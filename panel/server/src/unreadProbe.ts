// 微信未读角标检测（1.6.6）。
// 原理：微信 4.0 的未读数画在窗口内部、聊天库 SQLCipher 加密、dbus 通知被禁用，
// X11 层拿不到任何"来消息"信号。唯一可靠途径是看屏幕像素：会话列表行上的未读红点是
// 纯红(#FA5151 附近)圆角徽标。本模块在容器内 xwd 截屏 → ffmpeg 裁会话列表窄区 →
// 纯 Python(零依赖) 数"接近正方形、面积够大"的纯红连通块。
// 隐私：只裁左侧会话列表区域，不做 OCR、不读聊天文字、不落盘，只返回一个布尔与计数。
// 失败一律静默（hasUnread=false），绝不影响实例或面板。
import { execCapture } from './docker';
import type { Instance } from './store';

// 会话列表：实测 1656x892 布局下约 x=56..268；裁这条窄带避开右侧聊天内容。
// CROP_X=56 同时把最左侧竖排工具栏（其总未读角标在 x≈109 但 y<100、且是另一类徽标）排除在外。
const CROP_X = 56;
const CROP_Y = 40;
const CROP_W = 212;
const CROP_H = 840;
const CROP = `crop=${CROP_W}:${CROP_H}:${CROP_X}:${CROP_Y}`;

// 阈值：实测会话未读红点只有 8x7≈43 像素（远小于旧假设的 16-18px），旧阈值 11px/60 面积会全部漏检。
// 降到 6px/25 面积；靠「接近正方形 + 位于会话列表窄带」区分红点与红色头像/图片。
const MIN_WH = 6;
const SKEW = 5;
const MIN_AREA = 25;

// 纯 Python 连通块检测（零依赖）。输出 "badges biggest"。
const DETECT_PY = `import sys
from collections import deque
W,H=${CROP_W},${CROP_H}
raw=sys.stdin.buffer.read(); n=W*H; mask=bytearray(n)
for p in range(n):
    i=p*3; r,g,b=raw[i],raw[i+1],raw[i+2]
    if r>200 and g<90 and b<90 and r-g>130 and r-b>130: mask[p]=1
seen=bytearray(n); badges=0; biggest=0; spots=[]
for p in range(n):
    if not mask[p] or seen[p]: continue
    q=deque([p]); seen[p]=1; cnt=0; x0=x1=p%W; y0=y1=p//W
    while q:
        c=q.popleft(); cnt+=1; x=c%W; y=c//W
        if x<x0: x0=x
        if x>x1: x1=x
        if y<y0: y0=y
        if y>y1: y1=y
        for nb in (c-1,c+1,c-W,c+W):
            if 0<=nb<n and mask[nb] and not seen[nb]:
                seen[nb]=1; q.append(nb)
    w=x1-x0+1; h=y1-y0+1
    if cnt>=${MIN_AREA} and w>=${MIN_WH} and h>=${MIN_WH} and abs(w-h)<=${SKEW}:
        badges+=1
        if cnt>biggest: biggest=cnt
        spots.append("%d,%d,%d" % ((x0+x1)//2,(y0+y1)//2,cnt))
print(badges, biggest, " ".join(spots))
`;
const DETECT_PY_B64 = Buffer.from(DETECT_PY, 'utf8').toString('base64');

const DISPLAY_SETUP =
  'display="${DISPLAY:-}"; if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi; export DISPLAY="${display:-:1}"';

export interface UnreadSpot {
  x: number; // 红点中心，root 绝对坐标
  y: number;
  area: number;
  clickX: number; // 建议点击位置：会话行中部（会话名区域），避开红点本体与头像
  clickY: number;
}

export interface UnreadState {
  hasUnread: boolean;
  badges: number; // 检出的红点徽标数
  biggest: number; // 最大红点面积（调试用）
  spots: UnreadSpot[]; // 每个红点的坐标，供自动回复切到对应会话
  checkedAt: number;
  error?: string;
}

/**
 * 探测一次微信窗口会话列表是否有未读红点。
 * 全部在容器内执行，Python 脚本经 base64 传入（避免引号转义问题），任何异常都静默返回。
 */
export async function probeUnread(inst: Instance): Promise<UnreadState> {
  const now = Date.now();
  const fail = (error: string): UnreadState => ({
    hasUnread: false,
    badges: 0,
    biggest: 0,
    spots: [],
    checkedAt: now,
    error,
  });
  // base64 脚本写入 /tmp，xwd 截图 → ffmpeg 裁剪转 raw → 管道给 python。
  const cmd = [
    DISPLAY_SETUP,
    `echo ${DETECT_PY_B64} | base64 -d > /tmp/.woc_unread_detect.py`,
    'xwd -root -silent -out /tmp/.woc_unread.xwd 2>/dev/null || exit 3',
    `ffmpeg -y -loglevel error -i /tmp/.woc_unread.xwd -vf "${CROP}" -f rawvideo -pix_fmt rgb24 /tmp/.woc_unread.rgb 2>/dev/null || exit 4`,
    'rm -f /tmp/.woc_unread.xwd',
    'python3 /tmp/.woc_unread_detect.py < /tmp/.woc_unread.rgb 2>/dev/null || exit 5',
    'rm -f /tmp/.woc_unread.rgb /tmp/.woc_unread_detect.py',
  ].join('\n');
  const cleanupCmd = 'rm -f /tmp/.woc_unread.xwd /tmp/.woc_unread.rgb /tmp/.woc_unread_detect.py';
  try {
    let out: string;
    try {
      out = (await execCapture(inst, ['bash', '-c', cmd])).trim();
    } catch {
      // xwd/ffmpeg 偶发失败（会话刚切换、X server 忙；日志里出现过 ffmpeg exit 4）。
      // 清掉可能残留的半成品再试一次，避免一次瞬时失败就漏掉这条未读消息。
      try { await execCapture(inst, ['bash', '-c', cleanupCmd]); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
      out = (await execCapture(inst, ['bash', '-c', cmd])).trim();
    }
    const parts = out.trim().split(/\s+/).filter(Boolean);
    const badges = parseInt(parts[0], 10) || 0;
    const biggest = parseInt(parts[1], 10) || 0;
    const spots: UnreadSpot[] = [];
    for (const token of parts.slice(2)) {
      const cols = token.split(',').map((v) => parseInt(v, 10));
      const [cx, cy, area] = cols;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      spots.push({
        x: cx + CROP_X,
        y: cy + CROP_Y,
        area: Number.isFinite(area) ? area : 0,
        // 会话行中部（会话名区域）：点这里稳定打开会话，不会误触红点/头像/删除按钮。
        clickX: CROP_X + Math.round(CROP_W * 0.5),
        clickY: cy + CROP_Y,
      });
    }
    // 会话列表按最后消息时间排序：列表越靠上越新，优先处理；同高度取红点更大的（未读更多）。
    spots.sort((a, b) => a.y - b.y || b.area - a.area);
    return { hasUnread: badges > 0, badges, biggest, spots, checkedAt: now };
  } catch (e: any) {
    return fail(String(e?.message || e).slice(0, 200));
  }
}
