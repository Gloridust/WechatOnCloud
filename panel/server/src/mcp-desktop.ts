// MCP 端点（mcp.ts）用到的实例桌面原语：窗口信息、内存截图、点击 / 滚动、微信会话指纹、起草与发送回车。
// 全部经 docker exec 在实例里跑 xdotool / xclip / ffmpeg（都是实例镜像自带的，R5：缺了就明说要升级实例）；
// 图像只在内存里，不落盘（R3）；所有输入脚本在实例内限时执行，超时即整组杀掉，不会在返回之后才触发。
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { instanceAppType, type Instance } from './store.js';
import {
  CLIP_DIR,
  CLIP_SAVE,
  X_PRELUDE,
  XDO_RELEASE_MODS,
  cancelClipRestore,
  dockerClient as docker,
  execCreate,
  instanceAcceptsLargePng,
  pasteImageInInstance,
  scheduleClipRestore,
  withClipLock,
  xdoKey,
} from './docker.js';

const RELEASE_MODS = `xdotool keyup --delay 0 ${XDO_RELEASE_MODS}`;
const TOOLS_MISSING_HINT = '实例镜像里缺少 MCP 需要的工具（xdotool / xclip / ffmpeg），请先升级实例';

// ---------- 只读能力（docker ping / X11 窗口信息 / 内存 PNG 截屏） ----------
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024; // 4 MiB 硬上限，防大帧撑爆内存

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WechatWindowRect extends WindowRect {
  id: string;
  title: string;
}

export interface WechatWindowInfo {
  display: string;
  displayWidth: number;
  displayHeight: number;
  wechatWindow: WechatWindowRect | null;
}

export interface ScreenshotCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotOptions {
  maxWidth?: number; // 默认 1280；0 表示原生分辨率不缩放
  crop?: ScreenshotCrop; // 原生屏幕坐标，按显示尺寸裁剪
}

export interface ScreenshotResult {
  png: Buffer;
  displayWidth: number;
  displayHeight: number;
  imageWidth: number;
  imageHeight: number;
  maxWidth: number;
  crop: ScreenshotCrop | null;
  wechatWindow: WechatWindowRect | null;
  bytes: number;
  durationMs: number;
}

// 探测 docker-socket-proxy / Docker daemon 连通性（只读 ping，不抛错）。
export async function dockerHealthy(timeoutMs = 3000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      docker.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('docker ping timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 解析 PNG IHDR 宽高并校验 PNG 魔数（前 24 字节）。
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (!Buffer.isBuffer(buf) || buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('截屏输出不是有效的 PNG 图片');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG 缺少 IHDR 头');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`PNG 尺寸非法：${width}x${height}`);
  }
  return { width, height };
}

// 校验并按屏幕边界裁剪截屏区域（原生像素坐标）。
export function clampScreenshotCrop(
  crop: ScreenshotCrop,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop {
  if (
    !crop ||
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height)
  ) {
    throw new Error('crop 参数必须是有限数字 { x, y, width, height }');
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new Error('crop 的 width 和 height 必须大于 0');
  }
  const x = Math.min(Math.max(0, Math.round(crop.x)), displayWidth - 1);
  const y = Math.min(Math.max(0, Math.round(crop.y)), displayHeight - 1);
  const width = Math.min(Math.max(1, Math.round(crop.width)), displayWidth - x);
  const height = Math.min(Math.max(1, Math.round(crop.height)), displayHeight - y);
  return { x, y, width, height };
}

// 解析 WECHAT_WINDOW_INFO_SCRIPT 输出。
export function parseWechatWindowInfo(raw: string): WechatWindowInfo {
  let display = ':1';
  let displayWidth = 0;
  let displayHeight = 0;
  let wechatWindow: WechatWindowRect | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (trimmed.startsWith('DISPLAY\t')) {
      const parts = trimmed.split('\t');
      if (parts.length >= 4) {
        display = parts[1] || ':1';
        displayWidth = Number(parts[2]) || 0;
        displayHeight = Number(parts[3]) || 0;
      }
    } else if (trimmed.startsWith('WINDOW\t')) {
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const x = Number(parts[2]);
        const y = Number(parts[3]);
        const width = Number(parts[4]);
        const height = Number(parts[5]);
        if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
          wechatWindow = {
            id: parts[1],
            x,
            y,
            width,
            height,
            title: parts.slice(6).join('\t'),
          };
        }
      }
    }
  }

  if (displayWidth <= 0 || displayHeight <= 0) {
    throw new Error('无法获取实例 X11 显示分辨率');
  }
  return { display, displayWidth, displayHeight, wechatWindow };
}

const WECHAT_WINDOW_INFO_SCRIPT = [
  'set -eu',
  'display="${DISPLAY:-}"',
  'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
  'export DISPLAY="${display:-:1}"',
  'sw=""; sh=""',
  'if command -v xdotool >/dev/null 2>&1; then read -r sw sh <<<"$(xdotool getdisplaygeometry 2>/dev/null || true)"; fi',
  'if [ -z "$sw" ] || [ -z "$sh" ]; then',
  '  read -r sw sh <<<"$(xdpyinfo 2>/dev/null | awk \'/dimensions:/ {split($2,a,"x"); print a[1], a[2]; exit}\')"',
  'fi',
  'printf "DISPLAY\\t%s\\t%s\\t%s\\n" "$DISPLAY" "${sw:-0}" "${sh:-0}"',
  'if command -v xdotool >/dev/null 2>&1; then',
  '  best_pref=0; best_area=0; best_id=""; best_x=0; best_y=0; best_w=0; best_h=0; best_title=""',
  '  ids="$(xdotool search --onlyvisible --class \'^wechat$\' 2>/dev/null || xdotool search --onlyvisible --class \'wechat\' 2>/dev/null || true)"',
  '  for c in $ids; do',
  '    X=0; Y=0; WIDTH=0; HEIGHT=0',
  '    eval "$(xdotool getwindowgeometry --shell "$c" 2>/dev/null | grep -E \'^(X|Y|WIDTH|HEIGHT)=-?[0-9]+$\' || true)"',
  '    [ "${WIDTH:-0}" -gt 0 ] && [ "${HEIGHT:-0}" -gt 0 ] || continue',
  '    title="$(xdotool getwindowname "$c" 2>/dev/null | tr \'\\r\\n\\t\' \'   \' || true)"',
  '    pref=0',
  '    case "$title" in 微信|Weixin|WeChat) pref=1 ;; esac',
  '    area=$((WIDTH * HEIGHT))',
  '    if [ "$pref" -gt "$best_pref" ] || { [ "$pref" -eq "$best_pref" ] && [ "$area" -gt "$best_area" ]; }; then',
  '      best_pref=$pref; best_area=$area; best_id=$c; best_x=$X; best_y=$Y; best_w=$WIDTH; best_h=$HEIGHT; best_title=$title',
  '    fi',
  '  done',
  '  if [ -n "$best_id" ]; then',
  '    printf "WINDOW\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$best_id" "$best_x" "$best_y" "$best_w" "$best_h" "$best_title"',
  '  fi',
  'fi',
].join('\n');

// 查询运行中实例的 X11 显示尺寸与微信主窗口几何信息（只读，不启动容器）。
export async function wechatWindowInfo(inst: Instance): Promise<WechatWindowInfo> {
  const res = await execInputScript(inst, WECHAT_WINDOW_INFO_SCRIPT, [], 6);
  if (res.exitCode !== 0) {
    throw new Error((res.stderr || res.stdout || `读取窗口信息失败，退出码 ${res.exitCode}`).trim().slice(0, 300));
  }
  return parseWechatWindowInfo(res.stdout);
}

// 收集 docker exec 多路复用流中的原始 stdout 字节（供 execCaptureBuffer 使用并可独立单测）。
// 关键：在 TCP docker-socket-proxy 上，hijacked socket 往往在 'end' 后立即触发 'close'，
// 此时 exec.inspect() 仍在异步等待中；必须同步置 ended=true，避免 'close' 误判为异常中断。
export function collectDemuxedStream(
  stream: NodeJS.EventEmitter & { destroy: () => void },
  demux: (
    s: any,
    stdout: { write: (b: Buffer) => void },
    stderr: { write: (b: Buffer) => void },
  ) => void,
  inspectExec: () => Promise<{ Running?: boolean; ExitCode?: number | null }>,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const maxBytes = opts.maxBytes ?? MAX_SCREENSHOT_BYTES;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let ended = false;
    let totalBytes = 0;
    const outChunks: Buffer[] = [];
    let err = '';
    const errDecoder = new StringDecoder('utf8');

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.destroy();
      reject(e);
    };

    const timer = timeoutMs
      ? setTimeout(() => fail(new Error('截屏执行超时')), timeoutMs)
      : undefined;

    const stdout = {
      write: (b: Buffer) => {
        if (settled) return;
        totalBytes += b.length;
        if (totalBytes > maxBytes) {
          fail(new Error(`截屏结果超出上限（>${maxBytes} 字节）`));
          return;
        }
        outChunks.push(Buffer.from(b));
      },
    };
    const stderr = {
      write: (b: Buffer) => {
        if (err.length < 4096) err += errDecoder.write(b);
      },
    };

    demux(stream, stdout, stderr);
    stream.on('close', () => {
      if (!ended && !settled) fail(new Error('截屏连接异常中断'));
    });
    stream.on('end', async () => {
      ended = true;
      if (settled) return;
      err += errDecoder.end();
      try {
        const info = await inspectExec();
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (info.Running || info.ExitCode == null) {
          reject(new Error('无法确认截屏进程已结束'));
          return;
        }
        if (info.ExitCode !== 0) {
          reject(new Error((err || `截屏命令失败，退出码 ${info.ExitCode}`).trim()));
          return;
        }
        resolve(Buffer.concat(outChunks));
      } catch (e: any) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    stream.on('error', (e: any) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

// 在实例容器内执行命令并直接收集原始二进制 stdout（用于内存截屏，带超时和字节上限）。
async function execCaptureBuffer(
  inst: Instance,
  cmd: string[],
  user = 'abc',
  timeoutMs = 10000,
  maxBytes = MAX_SCREENSHOT_BYTES,
): Promise<Buffer> {
  const c = docker.getContainer(inst.containerName);
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  return collectDemuxedStream(
    stream,
    (s, stdout, stderr) => docker.modem.demuxStream(s, stdout as any, stderr as any),
    () => exec.inspect(),
    { timeoutMs, maxBytes },
  );
}

// ---------- 受控输入脚本执行（限时必杀 + 区分「确定没执行」与「结果未知」） ----------
export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// dispatched='no'：确定没有任何点击 / 滚轮 / 按键发出；'unknown'：可能已部分执行。
export class InputCommandError extends Error {
  readonly code: 'input_timeout' | 'focus_mismatch' | 'input_precondition_failed' | 'input_failed';
  readonly dispatched: 'no' | 'unknown';

  constructor(code: InputCommandError['code'], dispatched: InputCommandError['dispatched'], message: string) {
    super(message);
    this.name = 'InputCommandError';
    this.code = code;
    this.dispatched = dispatched;
  }
}

export const INPUT_KILL_AFTER_SEC = 8;
// 脚本内约定的「前置条件不满足」退出码：这些分支都在第一个点击 / 按键之前退出。
// 3=找不到微信主窗口或输入框不可见；4=活动窗口不是微信主窗口；5=指针未到达目标坐标；127=缺少命令。
const INPUT_PRECONDITION_EXIT_CODES = new Set([3, 4, 5, 127]);

// 收集 docker exec 的退出码与输出：非零退出码不抛错，交给 assertInputOk 判定。
export function collectScriptResult(
  stream: NodeJS.EventEmitter & { destroy: () => void },
  demux: (
    s: any,
    stdout: { write: (b: Buffer) => void },
    stderr: { write: (b: Buffer) => void },
  ) => void,
  inspectExec: () => Promise<{ Running?: boolean; ExitCode?: number | null }>,
  opts: { timeoutMs: number },
): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolve, reject) => {
    let settled = false;
    let ended = false;
    let out = '';
    let err = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error('命令结果未知：执行超时')), opts.timeoutMs);

    demux(
      stream,
      { write: (b: Buffer) => { if (out.length < 4096) out += outDecoder.write(b); } },
      { write: (b: Buffer) => { if (err.length < 4096) err += errDecoder.write(b); } },
    );
    stream.on('close', () => {
      if (!ended) fail(new Error('命令结果未知：连接关闭'));
    });
    stream.on('end', async () => {
      ended = true;
      if (settled) return;
      try {
        const info = await inspectExec();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (info.Running || info.ExitCode == null) {
          reject(new Error('命令结果未知：无法确认执行已结束'));
          return;
        }
        resolve({ exitCode: info.ExitCode, stdout: out + outDecoder.end(), stderr: err + errDecoder.end() });
      } catch (e: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    stream.on('error', (e: any) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

// 在实例容器内以 `timeout -k 1 N bash -c script` 执行输入脚本：超过 N 秒整组进程被 SIGTERM（再 1 秒 SIGKILL），
// 所以调用返回之后不会再有迟到的点击 / 按键；面板侧超时比容器内再多留 3 秒。
async function execInputScript(
  inst: Instance,
  script: string,
  args: string[],
  killAfterSec: number,
): Promise<ScriptResult> {
  const c = docker.getContainer(inst.containerName);
  const cmd = ['timeout', '-k', '1', String(killAfterSec), 'bash', '-c', script, ...args];
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: 'abc' });
  const stream = await exec.start({ hijack: true, stdin: false });
  return collectScriptResult(
    stream,
    (s, stdout, stderr) => docker.modem.demuxStream(s, stdout as any, stderr as any),
    () => exec.inspect(),
    { timeoutMs: (killAfterSec + 3) * 1000 },
  );
}

export function assertInputOk(res: ScriptResult, what: string): void {
  if (res.exitCode === 0) return;
  const detail = (res.stderr || res.stdout).trim().slice(0, 300);
  if (res.exitCode === 124 || res.exitCode === 137) {
    throw new InputCommandError(
      'input_timeout',
      'unknown',
      `${what}超时：容器内进程已被终止，不会延迟触发；是否已部分执行未知`,
    );
  }
  if (res.exitCode === 127) throw new InputCommandError('input_precondition_failed', 'no', TOOLS_MISSING_HINT);
  if (INPUT_PRECONDITION_EXIT_CODES.has(res.exitCode)) {
    throw new InputCommandError(
      res.exitCode === 4 ? 'focus_mismatch' : 'input_precondition_failed',
      'no',
      detail || `${what}前置条件不满足（退出码 ${res.exitCode}）`,
    );
  }
  throw new InputCommandError('input_failed', 'unknown', detail || `${what}失败（退出码 ${res.exitCode}）`);
}

const SCREENSHOT_CAPTURE_SCRIPT = [
  'set -eu',
  'display="$1"; cap_w="$2"; cap_h="$3"; cap_x="$4"; cap_y="$5"; scale_w="$6"',
  'export DISPLAY="$display"',
  'command -v ffmpeg >/dev/null 2>&1 || { echo "实例镜像里没有 ffmpeg，请先升级实例" >&2; exit 127; }',
  'if [ "$scale_w" -gt 0 ] && [ "$cap_w" -gt "$scale_w" ]; then',
  '  exec ffmpeg -loglevel error -f x11grab -video_size "${cap_w}x${cap_h}" -i "${display}+${cap_x},${cap_y}" -vframes 1 -vf "scale=${scale_w}:-1" -f image2pipe -vcodec png -',
  'else',
  '  exec ffmpeg -loglevel error -f x11grab -video_size "${cap_w}x${cap_h}" -i "${display}+${cap_x},${cap_y}" -vframes 1 -f image2pipe -vcodec png -',
  'fi',
].join('\n');

// 内存截屏：单次 docker exec 经 ffmpeg x11grab 输出 PNG 流，不落盘、不打印图片内容。
export async function captureInstanceScreenshot(
  inst: Instance,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const t0 = Date.now();
  const winInfo = await wechatWindowInfo(inst);
  const clampedCrop = opts.crop
    ? clampScreenshotCrop(opts.crop, winInfo.displayWidth, winInfo.displayHeight)
    : null;
  const rect = clampedCrop ?? { x: 0, y: 0, width: winInfo.displayWidth, height: winInfo.displayHeight };
  const maxWidth = opts.maxWidth === undefined ? 1280 : Math.max(0, Math.round(opts.maxWidth));
  if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
    throw new Error('实例 DISPLAY 名称非法');
  }

  const png = await execCaptureBuffer(
    inst,
    [
      'bash',
      '-c',
      SCREENSHOT_CAPTURE_SCRIPT,
      'woc-screenshot',
      winInfo.display,
      String(rect.width),
      String(rect.height),
      String(rect.x),
      String(rect.y),
      String(maxWidth),
    ],
    'abc',
    10000,
    MAX_SCREENSHOT_BYTES,
  );

  const dims = parsePngDimensions(png);
  return {
    png,
    displayWidth: winInfo.displayWidth,
    displayHeight: winInfo.displayHeight,
    imageWidth: dims.width,
    imageHeight: dims.height,
    maxWidth,
    crop: clampedCrop,
    wechatWindow: winInfo.wechatWindow,
    bytes: png.length,
    durationMs: Date.now() - t0,
  };
}

// ---------- 受控写操作 MCP 辅助能力（点击 / 滚动 / 会话指纹） ----------
export type MouseButton = 'left' | 'right' | 'middle';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export class DisplaySizeMismatchError extends Error {
  readonly code = 'display_size_mismatch';
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly actualWidth: number;
  readonly actualHeight: number;

  constructor(expectedWidth: number, expectedHeight: number, actualWidth: number, actualHeight: number) {
    super(
      `显示分辨率已变化：预期 ${expectedWidth}x${expectedHeight}，当前实际 ${actualWidth}x${actualHeight}`,
    );
    this.name = 'DisplaySizeMismatchError';
    this.expectedWidth = expectedWidth;
    this.expectedHeight = expectedHeight;
    this.actualWidth = actualWidth;
    this.actualHeight = actualHeight;
  }
}

export interface ClickOptions {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  button?: MouseButton;
  doubleClick?: boolean;
}

export interface ScrollOptions {
  x: number;
  y: number;
  displayWidth: number;
  displayHeight: number;
  direction: ScrollDirection;
  clicks?: number;
}

// 移动指针后核对落点再点击。不用 `mousemove --sync`：xdotool 3.20160805（Debian bookworm）的 --sync 是
// 「等指针离开原位置」，指针本来就在目标坐标时会空等 500×30ms=15s —— 同一坐标连续两次点击 / 滚动必然超时。
const MOVE_POINTER_LINES = [
  'xdotool mousemove "$x" "$y"',
  'sleep 0.05',
  'X=""; Y=""',
  'eval "$(xdotool getmouselocation --shell | grep -E \'^(X|Y)=[0-9]+$\')"',
  'if [ "$X" != "$x" ] || [ "$Y" != "$y" ]; then echo "pointer_not_at_target actual=${X:-?},${Y:-?} target=$x,$y" >&2; exit 5; fi',
];

export const CLICK_SCRIPT = [
  'set -eu',
  'display="$1"; x="$2"; y="$3"; btn="$4"; dbl="$5"',
  'export DISPLAY="$display"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  RELEASE_MODS,
  ...MOVE_POINTER_LINES,
  'if [ "$dbl" = "1" ]; then',
  '  xdotool click --repeat 2 --delay 80 "$btn"',
  'else',
  '  xdotool click "$btn"',
  'fi',
].join('\n');

export const SCROLL_SCRIPT = [
  'set -eu',
  'display="$1"; x="$2"; y="$3"; btn="$4"; clicks="$5"',
  'export DISPLAY="$display"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  RELEASE_MODS,
  ...MOVE_POINTER_LINES,
  'xdotool click --repeat "$clicks" --delay 40 "$btn"',
].join('\n');

const MOUSE_BUTTON_MAP: Record<MouseButton, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

const SCROLL_BUTTON_MAP: Record<ScrollDirection, string> = {
  up: '4',
  down: '5',
  left: '6',
  right: '7',
};

export async function clickInInstance(
  inst: Instance,
  opts: ClickOptions,
): Promise<{ displayWidth: number; displayHeight: number }> {
  const btn = MOUSE_BUTTON_MAP[opts.button ?? 'left'];
  if (!btn) throw new Error('鼠标按键名不合法');
  {
    const winInfo = await wechatWindowInfo(inst);
    if (winInfo.displayWidth !== opts.displayWidth || winInfo.displayHeight !== opts.displayHeight) {
      throw new DisplaySizeMismatchError(
        opts.displayWidth,
        opts.displayHeight,
        winInfo.displayWidth,
        winInfo.displayHeight,
      );
    }
    const x = Math.round(opts.x);
    const y = Math.round(opts.y);
    if (x < 0 || x >= winInfo.displayWidth || y < 0 || y >= winInfo.displayHeight) {
      throw new Error(`点击坐标越界：(${x}, ${y}) 超出 ${winInfo.displayWidth}x${winInfo.displayHeight}`);
    }
    if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
      throw new Error('实例 DISPLAY 名称非法');
    }
    assertInputOk(
      await execInputScript(
        inst,
        CLICK_SCRIPT,
        ['woc-click', winInfo.display, String(x), String(y), btn, opts.doubleClick ? '1' : '0'],
        INPUT_KILL_AFTER_SEC,
      ),
      '点击',
    );
    return { displayWidth: winInfo.displayWidth, displayHeight: winInfo.displayHeight };
  }
}

export async function scrollInInstance(
  inst: Instance,
  opts: ScrollOptions,
): Promise<{ displayWidth: number; displayHeight: number }> {
  const btn = SCROLL_BUTTON_MAP[opts.direction];
  if (!btn) throw new Error('滚动方向不合法');
  const clicks = opts.clicks ?? 3;
  if (!Number.isInteger(clicks) || clicks < 1 || clicks > 20) {
    throw new Error('滚动步数必须为 1-20 的整数');
  }
  {
    const winInfo = await wechatWindowInfo(inst);
    if (winInfo.displayWidth !== opts.displayWidth || winInfo.displayHeight !== opts.displayHeight) {
      throw new DisplaySizeMismatchError(
        opts.displayWidth,
        opts.displayHeight,
        winInfo.displayWidth,
        winInfo.displayHeight,
      );
    }
    const x = Math.round(opts.x);
    const y = Math.round(opts.y);
    if (x < 0 || x >= winInfo.displayWidth || y < 0 || y >= winInfo.displayHeight) {
      throw new Error(`滚动坐标越界：(${x}, ${y}) 超出 ${winInfo.displayWidth}x${winInfo.displayHeight}`);
    }
    if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
      throw new Error('实例 DISPLAY 名称非法');
    }
    assertInputOk(
      await execInputScript(
        inst,
        SCROLL_SCRIPT,
        ['woc-scroll', winInfo.display, String(x), String(y), btn, String(clicks)],
        INPUT_KILL_AFTER_SEC,
      ),
      '滚动',
    );
    return { displayWidth: winInfo.displayWidth, displayHeight: winInfo.displayHeight };
  }
}

// 检测坐标是否落入微信主窗口右下角「发送(S)」按钮防误触区（防止经 woc_click 绕过草稿确认链路）。
export function isInSendButtonZone(x: number, y: number, win: WechatWindowRect | null): boolean {
  if (!win) return false;
  return (
    x >= win.x + win.width - 160 &&
    x <= win.x + win.width &&
    y >= win.y + win.height - 72 &&
    y <= win.y + win.height
  );
}

// ---------- 微信 4.1.1.8 原生 1:1 标题栏 + 原生 1:1 输入区灰度指纹（零落盘、单帧原子采集） ----------
export const HEADER_INK_DELTA = 20;
// 实测 1836x884「文件传输助手」(6 汉字)在 280x44 原生标题区占 721 px (|px-bg|>=20)；
// 2 汉字约 240 px，取 75 px 作为防空白下限，兼顾细笔画短名且稳定拦截空白标题栏。
export const MIN_HEADER_INK_PIXELS = 75;
// 输入区按原生 1:1 逐像素比对，确认时最多 3 帧取最小差异（t=0, 350ms, 700ms）消除光标闪烁。
// 实测（微信 Linux 4.1.1.8，1836x884）：同一草稿连拍 15 帧只有光标亮 / 灭两种位图，任意连续 3 帧里两种都出现，
// 所以总有一帧与起草时逐像素一致；而改一个标点只差 12 px、改一个数字差 66 px、删一个汉字差 136 px。
// 因此不留容差：默认 0，差 1 像素即拒绝。确有需要时可用 MCP_EDITOR_MAX_DIFF_PIXELS 放宽。
export const DEFAULT_EDITOR_MAX_DIFF_PIXELS = 0;

export interface SessionFingerprint {
  displayWidth: number;
  displayHeight: number;
  wechatWindow: WechatWindowRect;
  headerRegion: ScreenshotCrop;
  editorRegion: ScreenshotCrop;
  headerGray: Buffer; // native 1:1 grayscale (headerRegion.width * headerRegion.height bytes), strictly in-memory
  editorGray: Buffer; // native 1:1 grayscale (editorRegion.width * editorRegion.height bytes), strictly in-memory
  headerInkPixels: number;
  headerBg: number;
  headerDigest: string; // 32-hex-char SHA-256 of the header bitmap + its size: stable identity of the open chat title
  digest: string; // 16-hex-char SHA-256 summary for metadata/logging
}

// 会话标题栏身份摘要：只取标题位图与其尺寸，同一会话多次采集恒定，可跨调用比对。
export function computeHeaderDigest(headerGray: Buffer, width: number, height: number): string {
  return createHash('sha256').update(headerGray).update(`|${width}x${height}`).digest('hex').slice(0, 32);
}

export interface HeaderCheckMetrics {
  match: boolean;
  diffPixels: number;
  totalPixels: number;
  meanAbsDiff: number;
}

export interface EditorCheckMetrics {
  enforced: boolean;
  match: boolean;
  diffPixels: number;
  changedPixels20: number;
  totalPixels: number;
  meanAbsDiff: number;
  changedPixelRatio: number;
  maxDiffPixels: number | null;
}

export interface FingerprintComparison {
  match: boolean;
  reason?: 'window_geometry_mismatch' | 'session_fingerprint_mismatch' | 'editor_fingerprint_mismatch';
  detail?: string;
  headerCheck: HeaderCheckMetrics;
  editorCheck: EditorCheckMetrics;
}

// 基于微信 Linux 4.1.1.8 实测布局计算当前会话标题核心裁剪区（1836x884 下精确为 {x:355,y:12,w:280,h:44}）：
// 左侧栏分隔线在 x=352，x=355 留出 3px 安全间隔，标题文字实测落在相对 (14,22)..(109,37)。
export function computeHeaderRegion(
  win: WechatWindowRect,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop | null {
  if (win.width < 480 || win.height < 300) return null;
  const sidebarOffset = win.width >= 900 ? 355 : Math.round(win.width * 0.32);
  const rawX = win.x + sidebarOffset;
  const rawY = win.y + 12;
  const maxRight = Math.min(displayWidth, win.x + win.width - 140);
  const availW = maxRight - rawX;
  if (availW < 80) return null;
  const rawW = Math.min(280, Math.max(120, availW));
  const rawH = Math.min(44, Math.max(24, Math.round(win.height * 0.06)));
  if (rawW < 80 || rawH < 16) return null;
  const clamped = clampScreenshotCrop(
    { x: rawX, y: rawY, width: rawW, height: rawH },
    displayWidth,
    displayHeight,
  );
  if (clamped.width < 80 || clamped.height < 16) return null;
  return clamped;
}

// 基于微信 Linux 4.1.1.8 实测布局计算输入编辑区裁剪区（位于工具栏下方、底部「发送(S)」按钮行上方）。
export function computeEditorRegion(
  win: WechatWindowRect,
  displayWidth: number,
  displayHeight: number,
): ScreenshotCrop | null {
  if (win.width < 480 || win.height < 300) return null;
  const sidebarOffset = win.width >= 900 ? 355 : Math.round(win.width * 0.32);
  const rawX = win.x + sidebarOffset;
  const rawY = win.y + win.height - 142;
  const rawW = Math.max(120, Math.min(displayWidth, win.x + win.width - 20) - rawX);
  const rawH = Math.min(82, Math.max(32, win.y + win.height - 60 - rawY));
  if (rawW < 80 || rawH < 16) return null;
  const clamped = clampScreenshotCrop(
    { x: rawX, y: rawY, width: rawW, height: rawH },
    displayWidth,
    displayHeight,
  );
  if (clamped.width < 80 || clamped.height < 16) return null;
  return clamped;
}

// 统计原生 1:1 灰度标题栏中的文字墨迹像素数（以众数为背景灰度，统计 |px - bg| >= 20 的像素）。
export function countHeaderInkPixels(buf: Buffer): { bg: number; inkPixels: number; totalPixels: number } {
  const totalPixels = buf.length;
  if (totalPixels === 0) return { bg: 0, inkPixels: 0, totalPixels: 0 };
  const hist = new Uint32Array(256);
  for (let i = 0; i < totalPixels; i++) hist[buf[i]]++;
  let bg = 0;
  let maxCount = 0;
  for (let v = 0; v < 256; v++) {
    if (hist[v] > maxCount) {
      maxCount = hist[v];
      bg = v;
    }
  }
  let inkPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (Math.abs(buf[i] - bg) >= HEADER_INK_DELTA) inkPixels++;
  }
  return { bg, inkPixels, totalPixels };
}

// 对比草稿期与确认期的会话指纹：
// 1. 窗口/屏幕/裁剪区几何必须完全一致（否则 window_geometry_mismatch）；
// 2. HEADER 原生 1:1 灰度图逐像素精确比对，零容差（diffPixels === 0，差 1 像素即 session_fingerprint_mismatch）；
// 3. EDITOR 原生 1:1 灰度图 diffPixels 比对，默认上限 DEFAULT_EDITOR_MAX_DIFF_PIXELS=0（配合确认时最多 3 帧早退采样消除光标闪烁）；显式传入 null 可退回仅诊断模式。
export function compareSessionFingerprints(
  draft: SessionFingerprint,
  live: SessionFingerprint,
  opts: { editorMaxDiffPixels?: number | null } = {},
): FingerprintComparison {
  const maxEditorDiff =
    opts.editorMaxDiffPixels === undefined ? DEFAULT_EDITOR_MAX_DIFF_PIXELS : opts.editorMaxDiffPixels;
  const failHeader: HeaderCheckMetrics = { match: false, diffPixels: -1, totalPixels: draft.headerGray.length, meanAbsDiff: 255 };
  const failEditor: EditorCheckMetrics = {
    enforced: maxEditorDiff !== null,
    match: maxEditorDiff === null,
    diffPixels: -1,
    changedPixels20: -1,
    totalPixels: draft.editorGray.length,
    meanAbsDiff: 255,
    changedPixelRatio: 1,
    maxDiffPixels: maxEditorDiff,
  };

  if (
    draft.displayWidth !== live.displayWidth ||
    draft.displayHeight !== live.displayHeight ||
    draft.wechatWindow.id !== live.wechatWindow.id ||
    draft.wechatWindow.x !== live.wechatWindow.x ||
    draft.wechatWindow.y !== live.wechatWindow.y ||
    draft.wechatWindow.width !== live.wechatWindow.width ||
    draft.wechatWindow.height !== live.wechatWindow.height ||
    draft.wechatWindow.title !== live.wechatWindow.title ||
    draft.headerRegion.x !== live.headerRegion.x ||
    draft.headerRegion.y !== live.headerRegion.y ||
    draft.headerRegion.width !== live.headerRegion.width ||
    draft.headerRegion.height !== live.headerRegion.height ||
    draft.editorRegion.x !== live.editorRegion.x ||
    draft.editorRegion.y !== live.editorRegion.y ||
    draft.editorRegion.width !== live.editorRegion.width ||
    draft.editorRegion.height !== live.editorRegion.height
  ) {
    return {
      match: false,
      reason: 'window_geometry_mismatch',
      detail: '显示分辨率或微信主窗口几何信息已发生变化',
      headerCheck: failHeader,
      editorCheck: failEditor,
    };
  }

  // Exact pixel-by-pixel HEADER comparison (zero tolerance: diffPixels === 0).
  const expectedHeaderLen = draft.headerRegion.width * draft.headerRegion.height;
  let headerCheck: HeaderCheckMetrics;
  if (draft.headerGray.length !== expectedHeaderLen || live.headerGray.length !== expectedHeaderLen) {
    headerCheck = { match: false, diffPixels: expectedHeaderLen, totalPixels: expectedHeaderLen, meanAbsDiff: 255 };
  } else {
    let diffPixels = 0;
    let absSum = 0;
    for (let i = 0; i < expectedHeaderLen; i++) {
      const d = Math.abs(draft.headerGray[i] - live.headerGray[i]);
      if (d !== 0) diffPixels++;
      absSum += d;
    }
    headerCheck = {
      match: diffPixels === 0,
      diffPixels,
      totalPixels: expectedHeaderLen,
      meanAbsDiff: Number((absSum / expectedHeaderLen).toFixed(4)),
    };
  }

  // Decoupled EDITOR comparison (diagnostic-only when maxEditorDiff === null).
  const expectedEditorLen = draft.editorRegion.width * draft.editorRegion.height;
  let editorCheck: EditorCheckMetrics;
  if (draft.editorGray.length !== expectedEditorLen || live.editorGray.length !== expectedEditorLen) {
    editorCheck = {
      enforced: maxEditorDiff !== null,
      match: maxEditorDiff === null,
      diffPixels: expectedEditorLen,
      changedPixels20: expectedEditorLen,
      totalPixels: expectedEditorLen,
      meanAbsDiff: 255,
      changedPixelRatio: 1,
      maxDiffPixels: maxEditorDiff,
    };
  } else {
    let diffPixels = 0;
    let changedPixels20 = 0;
    let absSum = 0;
    for (let i = 0; i < expectedEditorLen; i++) {
      const d = Math.abs(draft.editorGray[i] - live.editorGray[i]);
      if (d !== 0) diffPixels++;
      if (d >= HEADER_INK_DELTA) changedPixels20++;
      absSum += d;
    }
    const meanAbsDiff = Number((absSum / expectedEditorLen).toFixed(4));
    const changedPixelRatio = Number((changedPixels20 / expectedEditorLen).toFixed(4));
    const enforced = maxEditorDiff !== null;
    const match = !enforced || diffPixels <= maxEditorDiff;
    editorCheck = {
      enforced,
      match,
      diffPixels,
      changedPixels20,
      totalPixels: expectedEditorLen,
      meanAbsDiff,
      changedPixelRatio,
      maxDiffPixels: maxEditorDiff,
    };
  }

  if (!headerCheck.match) {
    return {
      match: false,
      reason: 'session_fingerprint_mismatch',
      detail: `会话标题栏原生 1:1 像素发生变化（diff_pixels=${headerCheck.diffPixels}/${headerCheck.totalPixels}）`,
      headerCheck,
      editorCheck,
    };
  }
  if (editorCheck.enforced && !editorCheck.match) {
    return {
      match: false,
      reason: 'editor_fingerprint_mismatch',
      detail: `输入编辑区像素变化超出阈值（diff_pixels=${editorCheck.diffPixels} > ${editorCheck.maxDiffPixels}）`,
      headerCheck,
      editorCheck,
    };
  }
  return { match: true, headerCheck, editorCheck };
}

// 单帧原子采集：关闭鼠标绘制（-draw_mouse 0），单次 ffmpeg x11grab 切出原生 1:1 的 header (hw x hh) 与
// editor (ew x eh)，都不缩放；两块右侧补黑到同宽 pw 后纵向拼接为 pw x (hh + eh) 原始灰度流。
export const FINGERPRINT_FILTER_GRAPH =
  '[0:v]split=2[h][e];[h]crop=${hw}:${hh}:${hx}:${hy},format=gray,pad=${pw}:${hh}:0:0:black[hs];' +
  '[e]crop=${ew}:${eh}:${ex}:${ey},format=gray,pad=${pw}:${eh}:0:0:black[es];[hs][es]vstack=inputs=2[out]';

const FINGERPRINT_CAPTURE_SCRIPT = [
  'set -eu',
  'display="$1"; sw="$2"; sh="$3"; hx="$4"; hy="$5"; hw="$6"; hh="$7"; ex="$8"; ey="$9"; ew="${10}"; eh="${11}"; pw="${12}"',
  'export DISPLAY="$display"',
  'command -v ffmpeg >/dev/null 2>&1 || { echo "实例镜像里没有 ffmpeg，请先升级实例" >&2; exit 127; }',
  `fc="${FINGERPRINT_FILTER_GRAPH}"`,
  'exec ffmpeg -loglevel error -draw_mouse 0 -f x11grab -video_size "${sw}x${sh}" -i "${display}+0,0" -vframes 1 -filter_complex "$fc" -map "[out]" -f rawvideo -pix_fmt gray -',
].join('\n');

export async function captureSessionFingerprint(inst: Instance): Promise<SessionFingerprint> {
  const winInfo = await wechatWindowInfo(inst);
  if (!winInfo.wechatWindow) {
    throw new Error('未找到可见的微信主窗口，无法采集会话指纹');
  }
  const headerRegion = computeHeaderRegion(
    winInfo.wechatWindow,
    winInfo.displayWidth,
    winInfo.displayHeight,
  );
  const editorRegion = computeEditorRegion(
    winInfo.wechatWindow,
    winInfo.displayWidth,
    winInfo.displayHeight,
  );
  if (!headerRegion || !editorRegion) {
    throw new Error('微信主窗口尺寸过小或不可见，无法安全定位会话标题栏与输入区');
  }
  if (!/^:[0-9]+(\.[0-9]+)?$/.test(winInfo.display)) {
    throw new Error('实例 DISPLAY 名称非法');
  }
  const stride = Math.max(headerRegion.width, editorRegion.width);
  const expectedTotalBytes = stride * (headerRegion.height + editorRegion.height);
  const combined = await execCaptureBuffer(
    inst,
    [
      'bash',
      '-c',
      FINGERPRINT_CAPTURE_SCRIPT,
      'woc-fingerprint',
      winInfo.display,
      String(winInfo.displayWidth),
      String(winInfo.displayHeight),
      String(headerRegion.x),
      String(headerRegion.y),
      String(headerRegion.width),
      String(headerRegion.height),
      String(editorRegion.x),
      String(editorRegion.y),
      String(editorRegion.width),
      String(editorRegion.height),
      String(stride),
    ],
    'abc',
    8000,
    expectedTotalBytes + 4096,
  );
  if (combined.length !== expectedTotalBytes) {
    throw new Error(`会话指纹原始字节数异常：期望 ${expectedTotalBytes}，实际 ${combined.length}`);
  }
  const headerGray = extractGrayRows(combined, stride, 0, headerRegion.width, headerRegion.height);
  const editorGray = extractGrayRows(combined, stride, headerRegion.height, editorRegion.width, editorRegion.height);
  const { bg: headerBg, inkPixels: headerInkPixels } = countHeaderInkPixels(headerGray);
  const headerDigest = computeHeaderDigest(headerGray, headerRegion.width, headerRegion.height);
  const digest = createHash('sha256')
    .update(headerGray)
    .update(editorGray)
    .update(
      `${winInfo.displayWidth}x${winInfo.displayHeight}:${winInfo.wechatWindow.id}:${headerRegion.x},${headerRegion.y},${headerRegion.width}x${headerRegion.height}:${editorRegion.x},${editorRegion.y},${editorRegion.width}x${editorRegion.height}`,
    )
    .digest('hex')
    .slice(0, 16);
  return {
    displayWidth: winInfo.displayWidth,
    displayHeight: winInfo.displayHeight,
    wechatWindow: winInfo.wechatWindow,
    headerRegion,
    editorRegion,
    headerGray,
    editorGray,
    headerInkPixels,
    headerBg,
    headerDigest,
    digest,
  };
}

// 从步长为 stride 的灰度位图里取出从 rowOffset 行开始、左对齐的 width x height 子块。
export function extractGrayRows(buf: Buffer, stride: number, rowOffset: number, width: number, height: number): Buffer {
  if (width > stride || buf.length < stride * (rowOffset + height)) {
    throw new Error('灰度位图尺寸不足，无法切出指纹区域');
  }
  const out = Buffer.allocUnsafe(width * height);
  for (let r = 0; r < height; r++) {
    const start = (rowOffset + r) * stride;
    buf.copy(out, r * width, start, start + width);
  }
  return out;
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (let i = 0; i < body.length; i++) crc = PNG_CRC_TABLE[(crc ^ body[i]) & 0xff] ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

// 把内存里的 8 位灰度位图编码成 PNG（不落盘）：让调用方看到的图和服务端用来比对 / 算摘要的是同一份字节。
export function encodeGrayPng(gray: Buffer, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0 || gray.length !== width * height) {
    throw new Error('灰度位图尺寸与数据长度不符');
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}


// 「锁定当前会话」：粘贴前先把焦点送进微信主窗口当前会话的输入框，不再依赖用户事先点好光标
// （焦点停在搜索框、消息列表或别的窗口时，Ctrl+V 和回车都会落空）。
// 主窗口 = class wechat、标题「微信」、尺寸像主窗口的最大那个（排除登录框、图片查看、小程序等）。
// 输入框在会话区底部、高度固定：点「窗口底边上方 80px、可见右缘左侧 200px」（避开右下角「发送」按钮），
// 再 Ctrl+End 把光标移到草稿末尾，粘贴内容总是追加在已有草稿之后。鼠标点完放回原处。
// 找不到主窗口或输入框不在屏幕内就报错退出，不盲发。
export const WECHAT_FOCUS_INPUT = [
  'read -r sw sh <<<"$(xdotool getdisplaygeometry)"',
  'best=0; main=""',
  "for c in $(xdotool search --onlyvisible --class '^wechat$' 2>/dev/null); do",
  '  case "$(xdotool getwindowname "$c" 2>/dev/null)" in 微信|Weixin|WeChat) ;; *) continue ;; esac',
  "  eval \"$(xdotool getwindowgeometry --shell \"$c\" | grep -E '^(X|Y|WIDTH|HEIGHT)=-?[0-9]+$')\"",
  '  [ "${WIDTH:-0}" -ge 600 ] && [ "${HEIGHT:-0}" -ge 400 ] || continue',
  '  [ $((WIDTH * HEIGHT)) -gt "$best" ] || continue',
  '  best=$((WIDTH * HEIGHT)); main=$c; mx=$X; my=$Y; mw=$WIDTH; mh=$HEIGHT',
  'done',
  '[ -n "$main" ] || { echo "未找到微信聊天窗口：请确认微信已登录、主窗口未最小化" >&2; exit 3; }',
  'right=$((mx + mw)); [ "$right" -le "$sw" ] || right=$sw',
  'cx=$((right - 200)); cy=$((my + mh - 80))',
  'if [ "$cx" -lt $((mx + 400)) ] || [ "$cy" -lt 0 ] || [ "$cy" -ge "$sh" ]; then',
  '  echo "微信输入框不在可视区域内：请把浏览器窗口放大后再发" >&2; exit 3',
  'fi',
  'eval "$(xdotool getmouselocation --shell | grep -E \'^(X|Y)=[0-9]+$\')"; ox=$X; oy=$Y',
  'xdotool windowactivate --sync "$main" >/dev/null 2>&1 || true',
  RELEASE_MODS,
  // 不用 mousemove --sync：xdotool 3.20160805（Debian bookworm）在指针已停在目标坐标时会空等 500×30ms=15s。
  'xdotool mousemove "$cx" "$cy"',
  'sleep 0.05',
  'xdotool click 1',
  'xdotool key ctrl+End',
  'xdotool mousemove "$ox" "$oy"',
].join('\n');


// ---------- MCP 输入锁 ----------
// 让 MCP 把「校验 + 输入 + 复查」放进同一把实例锁：不可重入、不排队，占用期间别的 MCP 输入请求直接 409
// （宁可让调用方重试，也不让两个自动化请求交错）。真人经面板打字不走这把锁：有人在看桌面时 MCP 的写工具
// 一律以 human_in_control 拒绝，两者不会同时发生。
export class InputBusyError extends Error {
  readonly statusCode = 409;
  constructor() {
    super('该实例正在处理另一个 MCP 输入请求，请稍后再试');
    this.name = 'InputBusyError';
  }
}
const inputBusy = new Set<string>();
export async function withInstanceInputLock<T>(inst: Instance, operation: () => Promise<T>): Promise<T> {
  if (inputBusy.has(inst.id)) throw new InputBusyError();
  inputBusy.add(inst.id);
  try {
    return await operation();
  } finally {
    inputBusy.delete(inst.id);
  }
}

function assertWechatInstance(inst: Instance): void {
  if (instanceAppType(inst) !== 'wechat') {
    throw new InputCommandError('input_precondition_failed', 'no', '该操作只支持微信实例');
  }
}

// 起草：把焦点送进微信当前会话的输入框、清空残留、粘贴文字。绝不按回车。
// 与面板打字一样借用容器剪贴板，粘完由 scheduleClipRestore 归还用户原来复制的内容。
export const DRAFT_PASTE_KILL_AFTER_SEC = 12;
export const DRAFT_PASTE_SCRIPT = [
  ...X_PRELUDE,
  CLIP_SAVE,
  `printf %s "$1" | base64 -d > ${CLIP_DIR}/typed.txt`,
  `xclip -selection clipboard -i ${CLIP_DIR}/typed.txt >/dev/null 2>&1`,
  WECHAT_FOCUS_INPUT,
  xdoKey('ctrl+a'),
  'sleep 0.05',
  xdoKey('BackSpace'),
  'sleep 0.05',
  xdoKey('ctrl+v'),
].join('\n');

export async function pasteDraftInInstance(inst: Instance, text: string): Promise<void> {
  assertWechatInstance(inst);
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  await withClipLock(inst.id, async () => {
    cancelClipRestore(inst.id);
    try {
      assertInputOk(
        await execInputScript(inst, DRAFT_PASTE_SCRIPT, ['woc-draft', b64], DRAFT_PASTE_KILL_AFTER_SEC),
        '粘贴草稿',
      );
    } finally {
      scheduleClipRestore(inst);
    }
  });
}

// 清空微信当前会话输入框（聚焦输入框后 ctrl+a + BackSpace，绝不按回车）。
export const CLEAR_INPUT_SCRIPT = [...X_PRELUDE, WECHAT_FOCUS_INPUT, xdoKey('ctrl+a'), 'sleep 0.05', xdoKey('BackSpace')].join('\n');
export async function clearInputInInstance(inst: Instance): Promise<void> {
  assertWechatInstance(inst);
  assertInputOk(await execInputScript(inst, CLEAR_INPUT_SCRIPT, [], INPUT_KILL_AFTER_SEC), '清空输入框');
}

// 起草图片：聚焦微信当前会话输入框并清空残留，再用面板已有的图片粘贴链路写入剪贴板并 Ctrl+V（绝不按回车）。
export async function pasteDraftImageInInstance(inst: Instance, mime: string, content: Buffer): Promise<void> {
  assertWechatInstance(inst);
  await clearInputInInstance(inst);
  const largeOk = mime === 'image/png' ? await instanceAcceptsLargePng(inst) : false;
  await pasteImageInInstance(inst, mime, content, largeOk);
}

// 确认发送专用：校验微信主窗口仍是当前活动窗口后只按一次回车。
// 焦点被弹窗 / 其它窗口抢走时以 focus_mismatch 退出，此时确定没有按键发出。
export const SEND_RETURN_SCRIPT = [
  'set -eu',
  'display="${DISPLAY:-}"',
  'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
  'export DISPLAY="${display:-:1}"',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
  'expected="$1"; check="$2"',
  'if [ "$check" = "1" ]; then',
  '  active="$(xdotool getactivewindow 2>/dev/null || true)"',
  '  if [ "$active" != "$expected" ]; then echo "focus_mismatch active=${active:-none} expected=$expected" >&2; exit 4; fi',
  'fi',
  xdoKey('Return'),
].join('\n');

export async function sendReturnInInstance(
  inst: Instance,
  expectedWindowId: string,
  opts: { focusCheck?: boolean } = {},
): Promise<void> {
  assertWechatInstance(inst);
  if (!/^[0-9]{1,20}$/.test(expectedWindowId)) throw new InputCommandError('input_precondition_failed', 'no', '微信主窗口 ID 非法');
  const res = await execInputScript(
    inst,
    SEND_RETURN_SCRIPT,
    ['woc-send-return', expectedWindowId, opts.focusCheck === false ? '0' : '1'],
    5,
  );
  assertInputOk(res, '发送回车');
}

