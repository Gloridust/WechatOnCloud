// 未读通知：轮询各微信实例的未读红点，状态变化（无→有）时经 SSE 推送给前端。
// 默认关闭（WOC_UNREAD_NOTIFY=1 开启），轮询间隔可配（WOC_UNREAD_POLL_SEC，默认 30s）。
// 只推送"有未读了"这个布尔信号 + 红点数，不含任何聊天内容。
import type { FastifyReply } from 'fastify';
import { probeUnread } from './unreadProbe.js';
import type { Instance } from './store.js';

interface SseClient {
  id: string;
  reply: FastifyReply;
}

const clients = new Set<SseClient>();
// 每个实例上次观测到的未读状态，用于检测"无→有"的跳变。
const lastState = new Map<string, boolean>();

const ENABLED = process.env.WOC_UNREAD_NOTIFY === '1';
const POLL_SEC = Math.max(10, Number(process.env.WOC_UNREAD_POLL_SEC) || 30);

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

/** 启动后台轮询。只对"微信"实例检测（QQ/浏览器界面未读样式不同，暂不支持）。 */
export function startUnreadPoller(listInstances: () => Instance[]) {
  if (!ENABLED) {
    return;
  }
  const tick = async () => {
    for (const inst of listInstances()) {
      if ((inst.appType || 'wechat') !== 'wechat') continue;
      try {
        await pollOnce(inst);
      } catch {
        /* 单实例失败不影响其它 */
      }
    }
  };
  setInterval(() => void tick(), POLL_SEC * 1000).unref();
  // 启动后延迟一轮再开始，避开面板启动高峰。
  setTimeout(() => void tick(), 15_000).unref();
}

export const unreadNotifyEnabled = ENABLED;
export const unreadPollSec = POLL_SEC;
