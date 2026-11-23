// 未读通知：轮询各微信实例的未读红点，状态变化（无→有）时经 SSE 推送给前端。
// 默认关闭（WOC_UNREAD_NOTIFY=1 作为老部署默认值）；1.6.7 起总开关可由面板切换并持久化，
// 轮询器始终运行、每轮动态读开关——面板点一下即生效，无需重启。
// 只推送"有未读了"这个布尔信号 + 红点数，不含任何聊天内容。
import type { FastifyReply } from 'fastify';
import { probeUnread } from './unreadProbe.js';
import { getUnreadNotifyConfig, type Instance } from './store.js';

interface SseClient {
  id: string;
  reply: FastifyReply;
}

const clients = new Set<SseClient>();
// 每个实例上次观测到的未读状态，用于检测"无→有"的跳变。
const lastState = new Map<string, boolean>();

/** 当前是否开启未读检测（动态读面板设置，env 仅作默认值）。 */
export function isUnreadEnabled(): boolean {
  return getUnreadNotifyConfig().enabled;
}
/** 当前轮询间隔秒数（动态）。 */
export function currentPollSec(): number {
  return getUnreadNotifyConfig().pollSec;
}
// 兼容旧引用（index.ts 曾用常量）；现在返回读取时的当前值。
export const unreadNotifyEnabled = new Proxy({}, { get: () => isUnreadEnabled() }) as unknown as boolean;
export const unreadPollSec = new Proxy({}, { get: () => currentPollSec() }) as unknown as number;

function sseWrite(c: SseClient, event: string, data: unknown) {
  try {
    c.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 连接已断：交给 close 事件清理 */
  }
}

/** 新增一个 SSE 订阅者；立即推一条当前快照，随后由轮询驱动变化事件。 */
export function addSseClient(id: string, reply: FastifyReply, currentlyUnread: boolean): () => void {
  const c: SseClient = { id, reply };
  clients.add(c);
  sseWrite(c, 'state', { instanceId: id, hasUnread: currentlyUnread, at: Date.now() });
  return () => clients.delete(c);
}

/** 向某实例的所有订阅者推送未读状态变化。 */
function broadcast(id: string, hasUnread: boolean, badges: number) {
  for (const c of clients) {
    if (c.id === id) sseWrite(c, 'unread', { instanceId: id, hasUnread, badges, at: Date.now() });
  }
}

/** 读取某实例当前缓存的未读状态（供 SSE 建立时给初始快照）。 */
export function currentUnread(id: string): boolean {
  return lastState.get(id) || false;
}

/** 立即探测指定实例一次并广播（前端手动"检查未读"时调用）。 */
export async function pollOnce(inst: Instance): Promise<{ hasUnread: boolean; badges: number; error?: string }> {
  const r = await probeUnread(inst);
  const prev = lastState.get(inst.id) || false;
  lastState.set(inst.id, r.hasUnread);
  broadcast(inst.id, r.hasUnread, r.badges);
  return { hasUnread: r.hasUnread, badges: r.badges, error: r.error };
}

/**
 * 启动后台轮询。定时器始终存在，但每轮动态判断开关——面板开/关即时生效。
 * 间隔也动态读取：用 5s 基础心跳 + 距上次实际探测的累计时间决定是否跑，
 * 这样面板改 pollSec 无需重建定时器。只对"微信"实例检测。
 */
export function startUnreadPoller(listInstances: () => Instance[]) {
  const lastRun = new Map<string, number>();
  const tick = async () => {
    if (!isUnreadEnabled()) return;
    const pollSec = currentPollSec();
    const now = Date.now();
    for (const inst of listInstances()) {
      if ((inst.appType || 'wechat') !== 'wechat') continue;
      const last = lastRun.get(inst.id) || 0;
      if (now - last < pollSec * 1000) continue;
      lastRun.set(inst.id, now);
      try {
        await pollOnce(inst);
      } catch {
        /* 单实例失败不影响其它 */
      }
    }
  };
  setInterval(() => void tick(), 5_000).unref();
  // 启动后延迟一轮再开始，避开面板启动高峰。
  setTimeout(() => void tick(), 15_000).unref();
}
