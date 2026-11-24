// AI 代回微信（1.6.6+，参考 CowAgent / wechat-bot / wxauto 的风控设计）。
//
// 路线选择：不碰 PC Hook（仅 Windows）、不碰 Web/iPad 协议（封号风险高）、不依赖 SQLCipher 解密。
// 沿用本 fork 已有的 KasmVNC 桌面能力：xwd 截图 → 多模态模型读「当前会话最后一条左侧气泡」→
// 本地规则过滤（白名单 / @触发 / 冷却 / 停止词）→ xclip 中文直贴 → 可选回车发送。
//
// 三种模式：
//   off    关闭（默认）
//   assist 人工确认：面板点一次「生成回复」，草稿只填进输入框或返回前端预览，不自动发
//   auto   自动：后台轮询未读红点增量，命中规则后自动生成并发送
//
// 隐私：截图只裁右侧聊天区，不落盘；API Key 只存在 accounts.json（0600），接口一律脱敏回传。
import { deflateSync } from 'node:zlib';
import { getSettings, getAutoReplyEnabled, type Instance } from './store.js';
import { execCaptureBinary, typeInInstance, keyInInstance, activeWindowClass, focusChatWindow, focusChatInput } from './docker.js';
import { appendInstanceLog } from './logs.js';
import { probeUnread } from './unreadProbe.js';

export type AutoReplyMode = 'off' | 'assist' | 'auto';

export interface AutoReplyConfig {
  mode: AutoReplyMode;
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  whitelist: string[]; // 联系人/群名；空=不限制（仍受触发前缀与冷却约束）
  triggerPrefix: string; // 非空时，消息必须以此开头（群聊会先去掉 @机器人名）
  stopWords: string[]; // 命中任意一个则永远不回（如「人工」「别回了」）
  cooldownSec: number; // 同一会话两次自动回复的最小间隔
  maxPerHour: number; // 全局每小时自动回复上限
  maxChars: number; // 单条回复最大字数
  pollSec: number; // auto 模式轮询间隔（最小 15s）
  autoTagEnabled: boolean; // 全自动发出的消息是否带「由 AI 代回」标记
  autoTagText: string; // 标记文案，附加在正文末尾
  autoAllowAny: boolean; // 白名单为空时是否允许对当前会话自动回复（需显式开启，风险自负）
}

export type PublicAutoReplyConfig = Omit<AutoReplyConfig, 'apiKey'> & {
  apiKeySet: boolean;
  // 总开关是否生效（面板设置优先，env 仅默认值）。前端据此显示"已开启/待开启"。
  enabledByEnv: boolean;
};

export interface DraftResult {
  shouldReply: boolean;
  reason: string;
  contact: string;
  message: string;
  reply: string;
  usedScreenshot: boolean;
  elapsedMs: number;
}

export interface TickResult {
  ran: boolean;
  skipped?: string;
  draft?: DraftResult;
  sent?: boolean;
  error?: string;
}

// 全自动回复留痕：面板「AI 代回」tab 显示最近记录，便于区分哪些消息是 AI 发出的。
export interface AutoReplyHistoryItem {
  at: number;
  contact: string;
  message: string;
  reply: string;
  tagged: boolean;
  tagText: string;
  source: 'auto' | 'manual';
}

export interface AutoReplyVerifyResult {
  model: string;
  baseURL: string;
  textOk: boolean;
  visionOk: boolean;
  textError?: string;
  visionError?: string;
  latencyMs: number;
  hint: string;
}

const DEFAULT_PROMPT =
  '你是微信桌面端的信息抽取与回复助手。截图是微信聊天窗口，只分析右侧聊天区域：气泡靠右是自己发的，靠左是对方发的。' +
  '只识别最底部一条「靠左」的新消息，忽略自己刚发的消息、系统提示、时间分割线、图片/文件/语音/表情本身。' +
  '以本人身份简短自然地回复，像真人聊天，不使用客套长句，不提 AI 身份。' +
  '严格输出 JSON，不要 Markdown 代码块：{"shouldReply":true/false,"reason":"","contact":"","message":"","reply":""}' +
  '。sys/文件/语音/表情/纯图片无法可靠理解时 shouldReply=false。';

const DEFAULTS: AutoReplyConfig = {
  mode: 'off',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: '',
  model: 'qwen3-vl-plus',
  prompt: DEFAULT_PROMPT,
  whitelist: [],
  triggerPrefix: '',
  stopWords: ['人工', '别回', '停止', '不用回'],
  cooldownSec: 60,
  maxPerHour: 20,
  maxChars: 300,
  pollSec: 30,
  autoTagEnabled: true,
  autoTagText: '（此消息由 AI 代回）',
  autoAllowAny: false,
};

type StoreConfig = Partial<AutoReplyConfig>;
function bucket(): Record<string, StoreConfig> {
  const s = getSettings();
  if (!s.autoReply || typeof s.autoReply !== 'object' || Array.isArray(s.autoReply)) s.autoReply = {};
  return s.autoReply as Record<string, StoreConfig>;
}

function sanitize(raw: StoreConfig): AutoReplyConfig {
  const m = ['off', 'assist', 'auto'].includes(String(raw.mode)) ? (raw.mode as AutoReplyMode) : 'off';
  const num = (v: unknown, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 100) : [];
  return {
    ...DEFAULTS,
    ...raw,
    mode: m,
    baseURL: typeof raw.baseURL === 'string' && raw.baseURL.trim() ? raw.baseURL.trim() : DEFAULTS.baseURL,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULTS.model,
    prompt: typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.slice(0, 4000) : DEFAULT_PROMPT,
    whitelist: list(raw.whitelist),
    stopWords: list(raw.stopWords),
    triggerPrefix: typeof raw.triggerPrefix === 'string' ? raw.triggerPrefix.slice(0, 60) : '',
    cooldownSec: num(raw.cooldownSec, DEFAULTS.cooldownSec, 0, 3600),
    maxPerHour: num(raw.maxPerHour, DEFAULTS.maxPerHour, 1, 200),
    maxChars: num(raw.maxChars, DEFAULTS.maxChars, 20, 1000),
    pollSec: num(raw.pollSec, DEFAULTS.pollSec, 15, 300),
    autoTagEnabled: raw.autoTagEnabled === undefined ? DEFAULTS.autoTagEnabled : !!raw.autoTagEnabled,
    autoTagText: typeof raw.autoTagText === 'string' ? raw.autoTagText.slice(0, 60) : DEFAULTS.autoTagText,
    autoAllowAny: raw.autoAllowAny === undefined ? DEFAULTS.autoAllowAny : !!raw.autoAllowAny,
  };
}

export function getAutoReplyConfig(id: string): AutoReplyConfig {
  return sanitize(bucket()[id] || {});
}

export function getPublicAutoReplyConfig(id: string): PublicAutoReplyConfig {
  const c = getAutoReplyConfig(id);
  const { apiKey, ...rest } = c;
  return { ...rest, apiKeySet: !!apiKey, enabledByEnv: getAutoReplyEnabled().enabled };
}

export function saveAutoReplyConfig(id: string, patch: Record<string, unknown>): PublicAutoReplyConfig {
  const cur = getAutoReplyConfig(id);
  const next: StoreConfig = { ...cur };
  for (const k of ['mode', 'baseURL', 'model', 'prompt', 'triggerPrefix', 'cooldownSec', 'maxPerHour', 'maxChars', 'pollSec', 'autoTagEnabled', 'autoTagText', 'autoAllowAny'] as const) {
    if (patch[k] !== undefined) (next as any)[k] = patch[k];
  }
  for (const k of ['whitelist', 'stopWords'] as const) {
    if (patch[k] !== undefined) (next as any)[k] = patch[k];
  }
  // 空字符串=保留原 Key；前端拿不到明文，只能覆盖或清除。
  if (typeof patch.clearApiKey === 'boolean' && patch.clearApiKey) next.apiKey = '';
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  bucket()[id] = sanitize(next);
  // persist 由 store 的 setAutoReply 完成（见下）；这里只更新内存，写盘交给调用方。
  return getPublicAutoReplyConfig(id);
}

// ---------- 截图 ----------
// 右侧聊天区。沿用 unreadProbe 的 1176x666 基准；窗口尺寸变化时不强求精确，模型能从画面自行判断。
const CHAT_CROP = 'crop=900:590:256:52';
const DISPLAY_SETUP =
  'display="${DISPLAY:-}"; if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi; export DISPLAY="${display:-:1}"';

export async function captureChatPng(inst: Instance): Promise<Buffer> {
  const cmd = [
    DISPLAY_SETUP,
    'xwd -root -silent -out /tmp/.woc_ar.xwd 2>/dev/null || exit 3',
    `ffmpeg -y -loglevel error -i /tmp/.woc_ar.xwd -vf "${CHAT_CROP}" -f image2pipe -vcodec png pipe:1 2>/dev/null || exit 4`,
    'rm -f /tmp/.woc_ar.xwd',
  ].join('\n');
  return execCaptureBinary(inst, ['bash', '-c', cmd]);
}

// 发送后校验用：把聊天区压成 80x80 灰度 raw（6400 字节），便于跨容器取回按字节比对。
// 底部发一条消息会带来大片像素变化；时钟跳字、光标闪烁只影响极少字节，用差异比例即可区分「真发出去了」和「没发出去」。
const VERIFY_CROP = `${CHAT_CROP},scale=80:80,format=gray`;
export async function captureChatFingerprint(inst: Instance): Promise<Buffer | null> {
  const cmd = [
    DISPLAY_SETUP,
    'xwd -root -silent -out /tmp/.woc_arf.xwd 2>/dev/null || exit 3',
    `ffmpeg -y -loglevel error -i /tmp/.woc_arf.xwd -vf "${VERIFY_CROP}" -f rawvideo -pix_fmt gray pipe:1 2>/dev/null || exit 4`,
    'rm -f /tmp/.woc_arf.xwd',
  ].join('\n');
  try {
    const buf = await execCaptureBinary(inst, ['bash', '-c', cmd]);
    return buf.length >= 6400 ? buf.subarray(0, 6400) : null;
  } catch {
    return null;
  }
}

function fingerprintDiff(a: Buffer, b: Buffer): number {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 18) changed++;
  return changed / a.length;
}

// ---------- 模型调用 ----------
function parseJson(text: string): any | null {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function callModel(cfg: AutoReplyConfig, image: Buffer | null, userText: string): Promise<any> {
  if (!cfg.apiKey) throw new Error('尚未配置 API Key（在「桌面设置 → AI 代回」里填写）');
  const content: any[] = [{ type: 'text', text: cfg.prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } });
  content.push({ type: 'text', text: userText });
  const url = `${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content }], temperature: 0.3, max_tokens: 600 }),
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`模型接口返回 ${res.status}：${raw.slice(0, 200)}`);
  const json = parseJson(raw) || {};
  const answer = json.choices?.[0]?.message?.content;
  // 兼容 content 为数组（部分视觉模型返回 [{"type":"text","text":"..."}]）
  const text = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.map((p: any) => p?.text || '').join('') : '';
  const parsed = parseJson(text);
  if (parsed) return parsed;
  // OCR / 纯识别类模型只会吐识别文字，不会按提示词输出 JSON，无法用于生成回复。
  // 给出可操作的原因，避免用户以为是自动回复没运行。
  const ocrLike = /ocr|识别/i.test(cfg.model);
  return {
    shouldReply: false,
    reason: ocrLike
      ? `模型 ${cfg.model} 是识别类模型，无法生成回复，请换成视觉对话模型（如 Qwen3-VL-32B-Instruct / qwen3-vl-plus）`
      : '模型未返回可解析的 JSON',
    contact: '',
    message: text.slice(0, 200),
    reply: '',
  };
}

// ---------- 模型发现 / 连通性验证（OpenAI 兼容接口） ----------
// 64x64 红白棋盘 PNG，仅用于探测模型是否接受 image_url（视觉能力）；不上传任何会话截图。
// 1.6.12：原 1x1 图会被 Qwen3-VL 以「宽高必须 >28」拒绝，导致真 VLM 被误判为文本模型。
// 1.6.13：改用运行时按 PNG 规范生成，避免硬编码 base64 被截断/填充错误导致所有模型
//         一律报「Failed to process the base64 image」（真 VLM 被再次误判）。
function makeProbePng(width = 64, height = 64): string {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor RGB
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const red = ((x >> 3) + (y >> 3)) % 2 === 0;
      const p = off + 1 + x * 3;
      rows[p] = 255; rows[p + 1] = red ? 0 : 255; rows[p + 2] = red ? 0 : 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const TINY_PNG_DATA = makeProbePng();

type Conn = { baseURL: string; apiKey: string; model: string };
function resolveConn(id: string, patch?: Record<string, unknown>): Conn {
  const cfg = getAutoReplyConfig(id);
  const pick = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  return {
    baseURL: pick(patch?.baseURL, cfg.baseURL),
    apiKey: pick(patch?.apiKey, cfg.apiKey),
    model: pick(patch?.model, cfg.model),
  };
}

function endpoints(base: string, path: string): string[] {
  const b = base.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const list = [`${b}/${path}`];
  // 用户可能只填到域名；没有 /v1 时补一次，兼容两种写法。
  if (!/\/v\d+$/.test(b)) list.push(`${b}/v1/${path}`);
  return [...new Set(list)];
}

async function compatFetch(conn: Conn, path: string, body?: unknown, timeoutMs = 25_000): Promise<any> {
  if (!conn.apiKey) throw new Error('请先保存 API Key（设置 → AI 代回）');
  let last = '接口不可达';
  for (const url of endpoints(conn.baseURL, path)) {
    try {
      const res = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${conn.apiKey}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (!res.ok) {
        // 常见错误翻成人话，避免用户盯着英文 402 猜原因。
        const friendly =
          res.status === 401 || res.status === 403 ? 'API Key 无效或无权限'
          : res.status === 402 ? 'API 账户余额不足或额度用尽'
          : res.status === 429 ? '调用频率/额度超限'
          : res.status === 404 ? '接口路径不存在（检查接口地址是否含 /v1）'
          : '';
        last = `${res.status}${friendly ? `：${friendly}` : ''}：${raw.slice(0, 120)}`;
        continue;
      }
      return parseJson(raw) || {};
    } catch (e: any) {
      last = String(e?.message || e).slice(0, 160);
    }
  }
  throw new Error(last);
}

function answerText(json: any): string {
  const m = json?.choices?.[0]?.message;
  const c = m?.content;
  const s = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text || '').join('') : '';
  // 部分推理模型 content 为空、只有 reasoning_content；证明接口已正常响应即可。
  return s || (typeof m?.reasoning_content === 'string' ? m.reasoning_content : '');
}

export async function listAutoReplyModels(
  id: string,
  patch?: Record<string, unknown>,
): Promise<{ models: string[]; baseURL: string }> {
  const conn = resolveConn(id, patch);
  const json = await compatFetch(conn, 'models', undefined, 20_000);
  const raw: any[] = Array.isArray(json.data) ? json.data : [];
  const models = raw
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((m: any): m is string => typeof m === 'string' && !!m.trim())
    .map((m: string) => m.trim());
  if (!models.length) throw new Error('接口未返回模型列表；需兼容 OpenAI GET /v1/models');
  return { models: [...new Set(models)].sort(), baseURL: conn.baseURL };
}

export async function verifyAutoReplyModel(id: string, patch?: Record<string, unknown>): Promise<AutoReplyVerifyResult> {
  const conn = resolveConn(id, patch);
  const started = Date.now();
  let textOk = false;
  let textError: string | undefined;
  let visionOk = false;
  let visionError: string | undefined;
  try {
    const json = await compatFetch(
      conn,
      'chat/completions',
      { model: conn.model, messages: [{ role: 'user', content: '只回复 OK' }], temperature: 0, max_tokens: 128 },
      30_000,
    );
    if (answerText(json).trim()) textOk = true;
    else textError = '接口返回内容为空';
  } catch (e: any) {
    textError = String(e?.message || e).slice(0, 200);
  }
  try {
    const json = await compatFetch(
      conn,
      'chat/completions',
      {
        model: conn.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是一张测试图片。看图后只回复 OK。' },
              { type: 'image_url', image_url: { url: TINY_PNG_DATA } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 128,
      },
      30_000,
    );
    if (answerText(json).trim()) visionOk = true;
    else visionError = '接口返回内容为空';
  } catch (e: any) {
    visionError = String(e?.message || e).slice(0, 200);
  }
  // 视觉失败不一定是模型不支持：图片尺寸/编码被网关拒绝时，提示要区分开。
  const probeIssue = !!visionError && /must be larger|failed to process|image size|dimension|base64/i.test(visionError);
  const hint = !textOk
    ? '文本调用失败：请检查接口地址、API Key 与模型名'
    : visionOk
      ? '文本与视觉均可用，可直接用截图识别（支持全自动）'
      : probeIssue
        ? '文本可用，但测试图未被该接口接受（不一定是模型不支持视觉）；可手动填消息验证'
        : '文本可用但视觉不可用：此模型不能读截图，请换视觉模型（VLM，如 qwen3-vl-plus），或手动填写对方消息';
  return { model: conn.model, baseURL: conn.baseURL, textOk, visionOk, textError, visionError, latencyMs: Date.now() - started, hint };
}

// ---------- 规则过滤 ----------
function applyRules(cfg: AutoReplyConfig, d: DraftResult): DraftResult {
  if (!d.shouldReply) return d;
  const text = String(d.message || '');
  if (!text.trim()) return { ...d, shouldReply: false, reason: '未识别到新消息' };
  if (cfg.stopWords.some((w) => text.includes(w))) return { ...d, shouldReply: false, reason: '命中停止词，转人工' };
  if (cfg.whitelist.length) {
    const hit = cfg.whitelist.some((w) => w && (String(d.contact || '').includes(w) || text.includes(w)));
    if (!hit) return { ...d, shouldReply: false, reason: '联系人/群不在白名单' };
  }
  if (cfg.triggerPrefix) {
    const body = text.replace(/^@\S+\s*/, '').trim();
    if (!body.startsWith(cfg.triggerPrefix) && !text.includes(cfg.triggerPrefix)) {
      return { ...d, shouldReply: false, reason: '未命中触发前缀' };
    }
  }
  if (!String(d.reply || '').trim()) return { ...d, shouldReply: false, reason: '回复为空' };
  return { ...d, reply: String(d.reply).trim().slice(0, cfg.maxChars) };
}

export async function draftReply(inst: Instance, userMessage?: string, opts?: { autoFocus?: boolean }): Promise<DraftResult> {
  const cfg = getAutoReplyConfig(inst.id);
  const started = Date.now();
  let image: Buffer | null = null;
  try {
    if (!userMessage) {
      // 全自动截图前先把微信窗口切到前台：xwd -root 截的是整个 X 桌面，若焦点/前台是别的程序，
      // 模型会看到错误画面。主动聚焦保证裁剪出的聊天区确实是微信。
      if (opts?.autoFocus) {
        const cls = await focusChatWindow(inst, inst.appType);
        if (!/wechat|weixin/.test(cls)) {
          appendInstanceLog(inst.id, `[ai-reply] 自动截图前无法聚焦微信窗口（class=${cls || '空'}），本轮跳过`);
          throw new Error('自动截图前无法把微信窗口切到前台，请确认微信已打开会话');
        }
      }
      image = await captureChatPng(inst);
    }
    const extra = userMessage
      ? `对方消息（由用户直接提供，优先于截图）：${userMessage}`
      : '请从截图中识别最后一条靠左的新消息。';
    const parsed = await callModel(cfg, image, extra);
    const d: DraftResult = {
      shouldReply: parsed.shouldReply === true || parsed.shouldReply === 'true',
      reason: String(parsed.reason || ''),
      contact: String(parsed.contact || ''),
      message: String(parsed.message || ''),
      reply: String(parsed.reply || ''),
      usedScreenshot: !!image,
      elapsedMs: Date.now() - started,
    };
    const result = applyRules(cfg, d);
    appendInstanceLog(inst.id, `[ai-reply] 草稿 shouldReply=${result.shouldReply} 联系人=${result.contact || '-'} 原因=${result.reason || '-'} 耗时=${result.elapsedMs}ms`);
    return result;
  } catch (e: any) {
    const err = String(e?.message || e).slice(0, 300);
    appendInstanceLog(inst.id, `[ai-reply] 生成失败：${err}`);
    throw new Error(err);
  }
}

// ---------- 回复留痕 ----------
const HISTORY_LIMIT = 50;
const historyByInstance = new Map<string, AutoReplyHistoryItem[]>();

export function getAutoReplyHistory(id: string, limit = 20): AutoReplyHistoryItem[] {
  const n = Math.max(1, Math.min(limit, HISTORY_LIMIT));
  return (historyByInstance.get(id) || []).slice(-n).reverse();
}

function pushHistory(id: string, item: AutoReplyHistoryItem): void {
  const list = historyByInstance.get(id) || [];
  list.push(item);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  historyByInstance.set(id, list);
}

function taggedReply(cfg: AutoReplyConfig, text: string): { text: string; tagged: boolean; tagText: string } {
  const tag = cfg.autoTagText.trim();
  if (!cfg.autoTagEnabled || !tag) return { text: String(text || '').trim().slice(0, cfg.maxChars), tagged: false, tagText: '' };
  // 标记占用正文额度，保证整条消息不超过 maxChars。
  const room = Math.max(1, cfg.maxChars - tag.length - 1);
  return { text: `${String(text || '').trim().slice(0, room)} ${tag}`, tagged: true, tagText: tag };
}

// ---------- 发送 ----------
export async function sendDraft(
  inst: Instance,
  text: string,
  withEnter: boolean,
  opts?: { autoTag?: boolean; autoFocus?: boolean },
): Promise<{ sent: boolean; activeClass: string; text: string; tagged: boolean; tagText: string }> {
  const cfg = getAutoReplyConfig(inst.id);
  // 仅全自动发送带标记；人工确认模式保持原样，避免干预用户手改的草稿。
  const out = opts?.autoTag ? taggedReply(cfg, text) : { text: String(text || '').trim().slice(0, cfg.maxChars), tagged: false, tagText: '' };
  const clean = out.text;
  if (!clean) throw new Error('回复内容为空');
  let cls = await activeWindowClass(inst);
  // 全自动模式发送前主动把微信窗口切到前台：轮询时焦点常在面板浏览器，等用户手动点开
  // 就失去了全自动的意义。先激活再校验，仍不是微信才放弃——避免把回复贴错窗口。
  if (opts?.autoFocus && !/wechat|weixin/.test(cls)) {
    cls = await focusChatWindow(inst, inst.appType);
  }
  if (!/wechat|weixin/.test(cls)) {
    throw new Error(cls ? `当前焦点窗口是 ${cls}，无法自动发送，请在桌面点开微信会话输入框` : '找不到微信窗口，无法自动发送（微信可能未打开会话）');
  }
  // 【1.6.18 关键修复】激活窗口 ≠ 焦点在输入框。此前只 windowactivate，Ctrl+V/回车常落到会话列表或空白处，
  // 动作"执行成功"但聊天区没有新消息，日志却写了「已发送」、留痕也记了假成功。这里主动点一下输入框拿真焦点。
  if (opts?.autoFocus) {
    const clicked = await focusChatInput(inst, inst.appType);
    appendInstanceLog(inst.id, `[ai-reply] 发送前点输入框 ${clicked ? '成功' : '未确认'}`);
  }
  // 发送前指纹：用于发送后确认聊天区确实发生了变化（消息真的发出去了）。
  const beforeFp = opts?.autoFocus ? await captureChatFingerprint(inst) : null;
  await typeInInstance(inst, clean);
  if (withEnter) {
    await new Promise((r) => setTimeout(r, 250));
    await keyInInstance(inst, 'Return');
  }
  // 发送后校验：等消息上屏后再取指纹比对。差异过小说明消息没进聊天区 —— 按失败处理，让上层回退基线重试，
  // 且不能写「已发送」/留痕，避免再出现"记录说发了、实际没发"的假成功。
  let verified = true;
  if (opts?.autoFocus && withEnter && beforeFp) {
    await new Promise((r) => setTimeout(r, 900));
    const afterFp = await captureChatFingerprint(inst);
    if (afterFp) {
      const ratio = fingerprintDiff(beforeFp, afterFp);
      verified = ratio > 0.01; // 1% 灰度像素变化，足以覆盖一条新气泡，又不被时钟/光标误触发
      appendInstanceLog(inst.id, `[ai-reply] 发送后画面差异=${(ratio * 100).toFixed(1)}% ${verified ? '已确认上屏' : '未检出新消息'}`);
      if (!verified) throw new Error('回复未出现在聊天区（焦点可能不在输入框），本轮不计成功，下轮重试');
    }
  }
  appendInstanceLog(inst.id, `[ai-reply] 已${withEnter ? '发送' : '填入'}回复（${clean.length}字）焦点=${cls || '未知'}${out.tagged ? ' 含AI标记' : ''}`);
  return { sent: withEnter && verified, activeClass: cls, text: clean, tagged: out.tagged, tagText: out.tagText };
}

// ---------- 自动轮询 ----------
const lastBadges = new Map<string, number>();
const lastSentAt = new Map<string, number>();
const sentTimestamps = new Map<string, number[]>();
const fingerprints = new Map<string, { at: number; key: string }>();
const busy = new Set<string>();
const lastSkipLog = new Map<string, number>();

// 跳过原因写进实例日志（同一原因 5 分钟最多一条），否则用户只看到"没反应"无法排障。
function noteSkip(inst: Instance, reason: string): void {
  const key = `${inst.id}|${reason}`;
  const now = Date.now();
  if (now - (lastSkipLog.get(key) || 0) < 5 * 60_000) return;
  lastSkipLog.set(key, now);
  appendInstanceLog(inst.id, `[ai-reply] 跳过：${reason}`);
}

export async function autoReplyTick(
  inst: Instance,
  isUserActive: (id: string) => boolean,
  force = false,
): Promise<TickResult> {
  const cfg = getAutoReplyConfig(inst.id);
  const skip = (reason: string): TickResult => { noteSkip(inst, reason); return { ran: false, skipped: reason }; };
  if (cfg.mode !== 'auto' && !force) return skip('自动模式未开启');
  if (!getAutoReplyEnabled().enabled && !force) return skip('总开关未开启（设置 → AI 代回）');
  // 自动模式不会替用户切换会话（切错群比不回更糟），默认要求白名单；
  // 若用户显式开启「不限制会话」，则只回复当前已打开的会话，风险自负。
  if (cfg.mode === 'auto' && !cfg.whitelist.length && !cfg.autoAllowAny) {
    return skip('自动模式需先配置白名单，或开启「不限制会话（仅当前窗口）」');
  }
  if (!cfg.apiKey) return skip('未配置 API Key');
  // OCR / 纯识别类模型不会按提示词输出 JSON，无法生成回复。提前拦下并写清原因，
  // 免得每轮都调用接口、返回空结果，用户却只看到「没生效」。
  if (/ocr/i.test(cfg.model)) {
    return skip(`模型 ${cfg.model} 是识别类模型，无法生成回复，请换成视觉对话模型（如 Qwen3-VL-32B-Instruct）`);
  }
  if (busy.has(inst.id)) return skip('上一轮仍在执行');
  if (isUserActive(inst.id)) {
    // 让行期间也要跟进未读基线：用户可能已手动点掉红点。这里不更新的话，基线会停在旧值，
    // 下一条消息的红点数恰好与旧值相同时会被误判为「没有新增」而永久不回（实测 1→0→1 卡死）。
    try {
      const seen = await probeUnread(inst);
      if (!seen.error) lastBadges.set(inst.id, seen.badges);
    } catch {
      /* 探测失败：保留原基线，下一轮再试 */
    }
    return skip('用户正在操作桌面，已让行');
  }

  const unread = await probeUnread(inst);
  if (unread.error) return skip(`未读检测失败：${unread.error}`);
  const prev = lastBadges.get(inst.id) ?? 0;
  // 只有「红点数量增加」或「无→有」才算新消息；红点一直在不重复回。
  const isNew = force || unread.badges > prev || (prev === 0 && unread.hasUnread);
  if (!isNew) {
    // 红点被用户手动清掉（数量下降/归零）：同步基线，否则下一批同数目的消息不再触发。
    if (unread.badges < prev) lastBadges.set(inst.id, unread.badges);
    return skip('没有新的未读增量');
  }
  // 先记下本轮增量对应的徽标，作为「已受理」基线；但若发送/草稿中途失败，catch 里会回退到
  // prev，让下一轮重新识别为增量并重试——否则一次焦点失败就会让这条消息永久不再触发。
  lastBadges.set(inst.id, unread.badges);

  const now = Date.now();
  if (now - (lastSentAt.get(inst.id) || 0) < cfg.cooldownSec * 1000) return skip('冷却时间内');
  const recent = (sentTimestamps.get(inst.id) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= cfg.maxPerHour) return skip('已达每小时上限');

  busy.add(inst.id);
  try {
    // 全自动：截图前主动聚焦微信，避免拍到面板浏览器或其他窗口。
    const draft = await draftReply(inst, undefined, { autoFocus: true });
    if (!draft.shouldReply) return { ran: true, draft, sent: false, skipped: draft.reason || '模型判断无需回复' };
    const fp = `${draft.contact}|${draft.message}`.slice(0, 300);
    const last = fingerprints.get(inst.id);
    if (last && last.key === fp && now - last.at < 30 * 60_000) {
      return { ran: true, draft, sent: false, skipped: '同一条消息已处理过' };
    }
    // 全自动：发送前主动把微信窗口激活到前台，避免焦点在面板浏览器时贴错窗口。
    const sent = await sendDraft(inst, draft.reply, true, { autoTag: true, autoFocus: true });
    lastSentAt.set(inst.id, now);
    recent.push(now);
    sentTimestamps.set(inst.id, recent);
    fingerprints.set(inst.id, { at: now, key: fp });
    pushHistory(inst.id, {
      at: now,
      contact: draft.contact || '当前会话',
      message: draft.message,
      reply: sent.text,
      tagged: sent.tagged,
      tagText: sent.tagText,
      source: 'auto',
    });
    return { ran: true, draft, sent: true };
  } catch (e: any) {
    // 真正的执行错误（焦点/窗口/接口）：回退未读基线，下一轮重新识别为增量并重试，
    // 否则一次偶发失败会让这条消息永久不再触发——这正是「开了没反应」的常见原因。
    lastBadges.set(inst.id, prev);
    const msg = String(e?.message || e).slice(0, 300);
    appendInstanceLog(inst.id, `[ai-reply] 自动回复失败（下轮重试）：${msg}`);
    return { ran: true, sent: false, error: msg };
  } finally {
    busy.delete(inst.id);
  }
}

export function startAutoReplyPoller(
  listInstances: () => Instance[],
  isUserActive: (id: string) => boolean,
): void {
  // 定时器始终存在；总开关与实例模式都在 tick 内动态读取，面板切换后立即生效。
  const lastRun = new Map<string, number>();
  const tick = async () => {
    if (!getAutoReplyEnabled().enabled) return;
    const now = Date.now();
    for (const inst of listInstances()) {
      if ((inst.appType || 'wechat') !== 'wechat') continue;
      const cfg = getAutoReplyConfig(inst.id);
      if (cfg.mode !== 'auto') continue;
      const last = lastRun.get(inst.id) || 0;
      if (now - last < cfg.pollSec * 1000) continue;
      lastRun.set(inst.id, now);
      try {
        await autoReplyTick(inst, isUserActive);
      } catch {
        /* 单实例失败不影响其它 */
      }
    }
  };
  // 固定 5s 心跳，各实例用自己的 pollSec 决定跳过（避免动态改间隔要重建定时器）。
  setInterval(() => void tick(), 5_000).unref();
  setTimeout(() => void tick(), 20_000).unref();
}
