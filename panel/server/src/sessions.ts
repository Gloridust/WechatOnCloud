import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface Session {
  userId: string;
  expires: number;
  slid?: boolean; // 瞬态：本次请求刚做过滑动续期，提示鉴权层顺手刷新 cookie（持久化了也无害）
}

// 会话时长：可配置（天），默认 30 天。避免频繁重登（issue #95）。
const DAYS = Math.max(1, Number(process.env.WOC_SESSION_DAYS) || 30);
export const SESSION_TTL_MS = DAYS * 24 * 60 * 60 * 1000;

// 持久化到磁盘（与 accounts.json 同目录）。关键：面板重启 / 一键自更新 / 看门狗重建都会重启进程，
// 旧版会话只在内存里 → 每次都被踢下线要重输密码（这正是 #95 说的"记住密码没生效"）。落盘后即可跨重启保持登录。
const FILE = `${dirname(process.env.PANEL_DATA || '/data/panel/accounts.json')}/sessions.json`;
const sessions = new Map<string, Session>();

function load() {
  try {
    if (!existsSync(FILE)) return;
    const obj = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Session>;
    const now = Date.now();
    for (const [t, s] of Object.entries(obj)) {
      if (s && typeof s.userId === 'string' && typeof s.expires === 'number' && s.expires > now) sessions.set(t, s);
    }
  } catch {
    /* 文件损坏则视作无会话（用户重登一次即可），不影响启动 */
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return; // 防抖：短时间多次变更合并一次写盘
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
      const now = Date.now();
      const obj: Record<string, Session> = {};
      for (const [t, s] of sessions) if (s.expires > now) obj[t] = s;
      const tmp = `${FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      renameSync(tmp, FILE);
      chmodSync(FILE, 0o600);
    } catch {
      /* 写盘失败不致命：本进程内存里仍有会话 */
    }
  }, 500);
}

load();

export function createSession(userId: string) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  save();
  return token;
}

export function getSession(token?: string) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    save();
    return null;
  }
  // 滑动续期：剩余不足一半即续满。NAS 面板常年挂着，固定 30 天硬过期的体验就是
  // "隔三差五要重登"；滑动后活跃用户永不掉线，闲置超过时长才需重登。
  // index.ts 的鉴权层看到 slid 标记会顺手刷新 cookie 的 maxAge，浏览器侧同步续期。
  if (s.expires - Date.now() < SESSION_TTL_MS / 2) {
    s.expires = Date.now() + SESSION_TTL_MS;
    s.slid = true;
    save();
  }
  return s;
}

export function destroySession(token?: string) {
  if (token && sessions.delete(token)) save();
}

// 禁用/删除账号后，立即踢掉其所有在线会话
export function destroyUserSessions(userId: string) {
  let changed = false;
  for (const [token, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) save();
}
