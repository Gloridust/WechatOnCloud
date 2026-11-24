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
import { getSettings, getAutoReplyEnabled, type Instance } from './store.js';
import { execCaptureBinary, typeInInstance, keyInInstance, activeWindowClass } from './docker.js';
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
  for (const k of ['mode', 'baseURL', 'model', 'prompt', 'triggerPrefix', 'cooldownSec', 'maxPerHour', 'maxChars', 'pollSec', 'autoTagEnabled', 'autoTagText'] as const) {
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
  return parseJson(text) || { shouldReply: false, reason: '模型未返回可解析的 JSON', contact: '', message: text.slice(0, 200), reply: '' };
}

// ---------- 模型发现 / 连通性验证（OpenAI 兼容接口） ----------
// 1x1 红色 PNG，仅用于探测模型是否接受 image_url（视觉能力）；不上传任何会话截图。
const TINY_PNG_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

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
        last = `${res.status}：${raw.slice(0, 160)}`;
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
  const hint = !textOk
    ? '文本调用失败：请检查接口地址、API Key 与模型名'
    : visionOk
      ? '文本与视觉均可用，可直接用截图识别（支持全自动）'
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

export async function draftReply(inst: Instance, userMessage?: string): Promise<DraftResult> {
  const cfg = getAutoReplyConfig(inst.id);
  const started = Date.now();
  let image: Buffer | null = null;
  try {
    if (!userMessage) image = await captureChatPng(inst);
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
  opts?: { autoTag?: boolean },
): Promise<{ sent: boolean; activeClass: string; text: string; tagged: boolean; tagText: string }> {
  const cfg = getAutoReplyConfig(inst.id);
  // 仅全自动发送带标记；人工确认模式保持原样，避免干预用户手改的草稿。
  const out = opts?.autoTag ? taggedReply(cfg, text) : { text: String(text || '').trim().slice(0, cfg.maxChars), tagged: false, tagText: '' };
  const clean = out.text;
  if (!clean) throw new Error('回复内容为空');
  const cls = await activeWindowClass(inst);
  // 焦点不在微信就绝不盲发：xdotool 作用于 X server 的当前焦点，可能把回复贴进别的窗口。
  if (!/wechat|weixin/.test(cls)) {
    throw new Error(cls ? `当前焦点窗口是 ${cls}，请先在桌面点开微信会话输入框再发送` : '拿不到当前焦点窗口，请先点开微信会话输入框再发送');
  }
  await typeInInstance(inst, clean);
  if (withEnter) {
    await new Promise((r) => setTimeout(r, 250));
    await keyInInstance(inst, 'Return');
  }
  appendInstanceLog(inst.id, `[ai-reply] 已${withEnter ? '发送' : '填入'}回复（${clean.length}字）焦点=${cls || '未知'}${out.tagged ? ' 含AI标记' : ''}`);
  return { sent: withEnter, activeClass: cls, text: clean, tagged: out.tagged, tagText: out.tagText };
}

// ---------- 自动轮询 ----------
const lastBadges = new Map<string, number>();
const lastSentAt = new Map<string, number>();
const sentTimestamps = new Map<string, number[]>();
const fingerprints = new Map<string, { at: number; key: string }>();
const busy = new Set<string>();

export async function autoReplyTick(
  inst: Instance,
  isUserActive: (id: string) => boolean,
  force = false,
): Promise<TickResult> {
  const cfg = getAutoReplyConfig(inst.id);
  if (cfg.mode !== 'auto' && !force) return { ran: false, skipped: '自动模式未开启' };
  if (!getAutoReplyEnabled().enabled && !force) return { ran: false, skipped: '总开关未开启（桌面设置 → AI 代回）' };
  // 自动模式不会替用户切换会话（切错群比不回更糟），因此必须指定白名单：模型识别出的
  // 联系人/群名命中白名单才发。assist 模式由用户亲自打开会话，不受此限制。
  if (cfg.mode === 'auto' && !cfg.whitelist.length) return { ran: false, skipped: '自动模式需先配置白名单' };
  if (!cfg.apiKey) return { ran: false, skipped: '未配置 API Key' };
  if (busy.has(inst.id)) return { ran: false, skipped: '上一轮仍在执行' };
  if (isUserActive(inst.id)) return { ran: false, skipped: '用户正在操作桌面，已让行' };

  const unread = await probeUnread(inst);
  if (unread.error) return { ran: false, skipped: `未读检测失败：${unread.error}` };
  const prev = lastBadges.get(inst.id) ?? 0;
  lastBadges.set(inst.id, unread.badges);
  // 只有「红点数量增加」或「无→有」才算新消息；红点一直在不重复回。
  const isNew = force || unread.badges > prev || (prev === 0 && unread.hasUnread);
  if (!isNew) return { ran: false, skipped: '没有新的未读增量' };

  const now = Date.now();
  if (now - (lastSentAt.get(inst.id) || 0) < cfg.cooldownSec * 1000) return { ran: false, skipped: '冷却时间内' };
  const recent = (sentTimestamps.get(inst.id) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= cfg.maxPerHour) return { ran: false, skipped: '已达每小时上限' };

  busy.add(inst.id);
  try {
    const draft = await draftReply(inst);
    if (!draft.shouldReply) return { ran: true, draft, sent: false, skipped: draft.reason || '模型判断无需回复' };
    const fp = `${draft.contact}|${draft.message}`.slice(0, 300);
    const last = fingerprints.get(inst.id);
    if (last && last.key === fp && now - last.at < 30 * 60_000) {
      return { ran: true, draft, sent: false, skipped: '同一条消息已处理过' };
    }
    const sent = await sendDraft(inst, draft.reply, true, { autoTag: true });
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
    const msg = String(e?.message || e).slice(0, 300);
    appendInstanceLog(inst.id, `[ai-reply] 自动回复失败：${msg}`);
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
