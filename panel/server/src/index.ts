import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import httpProxy from 'http-proxy';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  initStore,
  findByUsername,
  findById,
  verifyPassword,
  publicUser,
  listUsers,
  createSub,
  setDisabled,
  resetPassword,
  deleteUser,
  setUserInstances,
  listInstances,
  findInstance,
  setInstanceMemLimits,
  userInstances,
  userCanAccess,
  createInstance,
  removeInstance as removeInstanceRecord,
  renameInstance,
  setInstanceUsers,
  publicInstance,
    type Instance,
} from './store.js';
import {
  ensureNetwork,
  ensureRunning,
  runInstance,
  stopInstance,
  upgradeInstance,
  removeInstance as removeInstanceContainer,
  instanceRuntime,
  triggerWechat,
  wechatStatus,
  instanceTarget,
  uploadToInstance,
  listInstanceFiles,
  downloadFromInstance,
  deleteInstanceFile,
  instanceLogs,
  typeInInstance,
  listOrphanVolumes,
  removeVolume,
  listOrphanContainers,
  removeContainerById,
  instanceMemoryMB,
} from './docker.js';
import { createSession, getSession, destroySession, destroyUserSessions } from './sessions.js';
import { parseHost, parseAllowedHosts, isAllowedHost } from './host-guard.js';
import { createAuthProvider } from './auth/index.js';
import type { User } from './auth/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, '../../web/dist');
const COOKIE = 'woc_sess';
// Public hostnames the panel will accept Host headers for, in addition to the
// always-on loopback + RFC1918 LAN allowlist. Required for HTTPS reverse-proxy
// deploys (Caddy/nginx/飞牛 内置反代) where the public hostname differs from
// the LAN IP. See .env.example.
const ALLOWED_HOSTS = parseAllowedHosts(process.env.PANEL_ALLOWED_HOSTS);

function basicAuth(inst: Instance) {
  return 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
}

initStore();

// ---------- Auth Provider ----------
const auth = createAuthProvider();
await auth.init();

const app = Fastify({ logger: true, trustProxy: true });

// DNS-rebinding gate: reject requests whose Host header is neither a loopback /
// RFC1918 LAN address nor in PANEL_ALLOWED_HOSTS. Runs before every route so
// /api/*, /desktop/* and static-file responses are all covered.
app.addHook('onRequest', async (req, reply) => {
  const host = parseHost(req.headers.host);
  if (!isAllowedHost(host, ALLOWED_HOSTS)) {
    // 把被拒的 host 一起回显，反代调试时可一眼看出"反代后端实际传过来的 Host 是什么"
    // —— 决定是去白名单加这个 host，还是修反代让它透传客户端 Host。不泄露敏感信息。
    reply.code(400).send({
      error: 'Host header not allowed',
      host: host || null,
      hint: '反代部署请把对外域名加入 PANEL_ALLOWED_HOSTS（.env，逗号分隔多个域名），或修反代让 Host 头透传',
    });
  }
});

await app.register(cookie);
// 文件上传走原始二进制（前端以 application/octet-stream 直传 File）
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

// ---------- 鉴权辅助 ----------
async function currentUser(req: FastifyRequest): Promise<User | null> {
  return auth.currentUser(req);
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  return auth.requireAuth(req, reply);
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  return auth.requireAdmin(req, reply);
}

function allowLocalUserManagement(): boolean {
  const mode = process.env.WOC_AUTH_MODE || 'local';
  return mode !== 'oidc_full';
}

// ---------- 登录 / 会话 ----------
app.post('/api/auth/login', async (req, reply) => {
  const { username, password } = (req.body as any) ?? {};
  const u = username ? findByUsername(username) : undefined;
  if (!u || u.disabled || !verifyPassword(u, password ?? '')) {
    return reply.code(401).send({ error: '用户名或密码错误' });
  }
  const token = createSession(u.id);
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return { user: publicUser(u) };
});

// Auth mode endpoint
app.get('/api/auth/mode', async (_req, reply) => {
  reply.send({ mode: process.env.WOC_AUTH_MODE || 'local', oidcLabel: process.env.WOC_OIDC_LABEL || '统一身份登录' });
});

// OIDC routes
app.get('/api/auth/oidc/login', async (req, reply) => {
  return auth.login(req, reply);
});

app.get('/api/auth/oidc/callback', async (req, reply) => {
  return auth.callback(req, reply);
});

app.post('/api/auth/logout', async (req, reply) => {
  destroySession(req.cookies?.[COOKIE]);
  reply.clearCookie(COOKIE, { secure: true, path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const u = await currentUser(req);
  if (!u) return reply.code(401).send({ error: '未登录' });
  return { user: u };
});

// ---------- 自助改密 ----------
app.post('/api/account/password', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  if (!allowLocalUserManagement()) return reply.code(403).send({ error: '当前认证模式下不支持本地改密' });
  const fullUser = findById(u.id);
  if (!fullUser) return reply.code(401).send({ error: '用户不存在' });
  const { oldPassword, newPassword } = (req.body as any) ?? {};
  if (!verifyPassword(fullUser, oldPassword ?? '')) return reply.code(400).send({ error: '原密码错误' });
  if (!newPassword || String(newPassword).length < 6) return reply.code(400).send({ error: '新密码至少 6 位' });
  resetPassword(u.id, newPassword);
  return { ok: true };
});

// ---------- 管理员：子账号管理 ----------
app.get('/api/admin/users', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  return { users: listUsers() };
});

app.post('/api/admin/users', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  if (!allowLocalUserManagement()) return reply.code(403).send({ error: '当前认证模式下不支持本地用户管理' });
  const { username, password } = (req.body as any) ?? {};
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return reply.code(400).send({ error: '用户名为 3-20 位字母、数字或下划线' });
  }
  if (!password || String(password).length < 6) return reply.code(400).send({ error: '密码至少 6 位' });
  const allowedInstances = Array.isArray((req.body as any)?.allowedInstances) ? (req.body as any).allowedInstances : [];
  try {
    return { user: createSub(username, password, allowedInstances) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// 账户侧：设置某账户可访问的实例
app.post('/api/admin/users/:id/instances', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const instanceIds = Array.isArray((req.body as any)?.instanceIds) ? (req.body as any).instanceIds : [];
  try {
    return { user: setUserInstances(id, instanceIds) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post('/api/admin/users/:id/disable', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  if (!allowLocalUserManagement()) return reply.code(403).send({ error: '当前认证模式下不支持本地用户管理' });
  const { disabled } = (req.body as any) ?? {};
  const id = (req.params as any).id;
  try {
    const user = setDisabled(id, !!disabled);
    if (disabled) destroyUserSessions(id);
    return { user };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post('/api/admin/users/:id/reset', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  if (!allowLocalUserManagement()) return reply.code(403).send({ error: '当前认证模式下不支持本地用户管理' });
  const { newPassword } = (req.body as any) ?? {};
  const id = (req.params as any).id;
  if (!newPassword || String(newPassword).length < 6) return reply.code(400).send({ error: '密码至少 6 位' });
  try {
    const user = resetPassword(id, newPassword);
    destroyUserSessions(id);
    return { user };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  if (!allowLocalUserManagement()) return reply.code(403).send({ error: '当前认证模式下不支持本地用户管理' });
  const id = (req.params as any).id;
  try {
    deleteUser(id);
    destroyUserSessions(id);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// ---------- 微信实例管理 ----------
// 列出当前用户可见实例（含运行态 + 微信安装状态）
app.get('/api/instances', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const visible = userInstances(u);
  const out = await Promise.all(
    visible.map(async (pub) => {
      const inst = findInstance(pub.id)!;
      const [runtime, wx] = await Promise.all([instanceRuntime(inst), wechatStatus(inst)]);
      return { ...pub, runtime, wechat: wx };
    }),
  );
  return { instances: out };
});

// 新建实例（仅管理员）：生成凭据 + docker run + 分配访问账户
app.post('/api/admin/instances', async (req, reply) => {
  const admin = await requireAdmin(req, reply);
  if (!admin) return;
  const { name, reuseVolume } = (req.body as any) ?? {};
  const allowedUserIds = Array.isArray((req.body as any)?.allowedUserIds) ? (req.body as any).allowedUserIds : [];
  if (!name || String(name).trim().length === 0 || String(name).length > 30) {
    return reply.code(400).send({ error: '实例名称为 1-30 个字符' });
  }
  // 复用卷：必须以 woc-data- 开头，且不能被现存实例占用。后端先校验，避免坏名穿透到 docker run。
  let reuseVolumeName: string | undefined;
  if (reuseVolume) {
    if (typeof reuseVolume !== 'string' || !/^woc-data-[0-9a-zA-Z._-]{1,64}$/.test(reuseVolume)) {
      return reply.code(400).send({ error: '复用卷名不合法' });
    }
    if (listInstances().some((i) => i.volumeName === reuseVolume)) {
      return reply.code(409).send({ error: '该数据卷已被另一个实例占用' });
    }
    reuseVolumeName = reuseVolume;
  }
  const inst = createInstance(String(name), admin.id, allowedUserIds, reuseVolumeName);
  try {
    await runInstance(inst);
  } catch (e: any) {
    removeInstanceRecord(inst.id); // 容器起不来则回滚登记
    return reply.code(500).send({ error: '创建容器失败：' + (e?.message || e) });
  }
  return { instance: publicInstance(inst) };
});

// 列出"未被任何实例引用的 woc-data-* 数据卷"。删除实例时默认保留卷（聊天记录），但 panel 里
// 看不到这些孤儿卷；本接口让管理员在新建实例时复用旧卷（同微信号扫码可继承聊天记录），
// 或在不需要时彻底删除。
app.get('/api/admin/orphan-volumes', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const referenced = new Set(listInstances().map((i) => i.volumeName));
  try {
    const volumes = await listOrphanVolumes(referenced);
    return { volumes };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '读取数据卷失败' });
  }
});

// 列出"残留的 woc-wx-* 容器"：docker 里存在但 store 没登记。多为 runInstance 启动失败遗留
// 的 Created 容器，会占着 woc-data-<id> 卷名让删卷报 409。提供给管理员一键清理。
app.get('/api/admin/orphan-containers', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const known = new Set(listInstances().map((i) => i.containerName));
  try {
    const containers = await listOrphanContainers(known);
    return { containers };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '读取容器失败' });
  }
});

// 强制删除一个残留容器。仅当它不在 store 的已知容器集中（防误删正在用的实例）。
app.delete('/api/admin/orphan-containers/:idOrName', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const idOrName = (req.params as any).idOrName;
  if (!idOrName || typeof idOrName !== 'string') return reply.code(400).send({ error: '参数不合法' });
  if (listInstances().some((i) => i.containerName === idOrName)) {
    return reply.code(409).send({ error: '该容器属于现存实例，不能在此删除' });
  }
  try {
    await removeContainerById(idOrName);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '删除容器失败' });
  }
});

// 显式删除一个未使用的数据卷。被现存实例占用时拒绝（避免误删聊天记录）。
app.delete('/api/admin/orphan-volumes/:name', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const name = (req.params as any).name;
  if (!name || typeof name !== 'string' || !name.startsWith('woc-data-')) {
    return reply.code(400).send({ error: '卷名不合法' });
  }
  if (listInstances().some((i) => i.volumeName === name)) {
    return reply.code(409).send({ error: '该数据卷正被某个实例使用，不能删除' });
  }
  try {
    await removeVolume(name);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '删除数据卷失败' });
  }
});

// 查/改单实例的内存安全阀（soft / hard）。前端"实例卡片 → 安全"弹窗用。
// GET 返回 per-instance 当前覆盖值 + 全局默认 + 实时内存（用于弹窗里展示）。
// PUT 接受 {soft, hard}，每项可为正整数 / null（null = 恢复默认）。
app.get('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  let currentMB = 0;
  try {
    if ((await instanceRuntime(inst)) === 'running') currentMB = await instanceMemoryMB(inst);
  } catch {
    /* ignore：未运行时为 0 */
  }
  return {
    soft: inst.memSoftLimitMB ?? null,
    hard: inst.memHardLimitMB ?? null,
    defaultSoft: DEFAULT_SOFT_MB,
    defaultHard: DEFAULT_HARD_MB,
    currentMB,
    watchdogEnabled: WATCHDOG_ENABLED,
    intervalSec: WATCHDOG_INTERVAL_SEC,
  };
});
app.put('/api/admin/instances/:id/mem-limits', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const body = (req.body as any) ?? {};
  // 允许 number / null；其它类型都视为"未提供"（保持原值）
  const norm = (v: any): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined;
  const s = norm(body.soft);
  const h = norm(body.hard);
  // 取最终生效值（写入前校验）
  const finalSoft = s === undefined ? inst.memSoftLimitMB ?? null : s;
  const finalHard = h === undefined ? inst.memHardLimitMB ?? null : h;
  try {
    const pub = setInstanceMemLimits(
      id,
      finalSoft,
      finalHard,
    );
    return { instance: pub };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '阈值不合法' });
  }
});

// 删除实例（仅管理员）：默认保留数据卷，?purge=1 才永久删聊天记录
app.delete('/api/admin/instances/:id', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const purge = (req.query as any)?.purge === '1' || (req.query as any)?.purge === 'true';
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  await removeInstanceContainer(inst, purge);
  removeInstanceRecord(id);
  controlHolders.delete(id);
  return { ok: true };
});

// 重命名实例（仅管理员）：只改显示名，不动容器/卷。
app.post('/api/admin/instances/:id/rename', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const { name } = (req.body as any) ?? {};
  try {
    return { instance: renameInstance((req.params as any).id, String(name ?? '')) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// 启动实例容器（仅管理员）：容器停止或被删后，一键拉起（不重建数据卷）。
app.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await ensureRunning(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '启动失败：' + (e?.message || e) });
  }
});

// 停止实例容器（仅管理员）：保留容器与数据卷。
app.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await stopInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '停止失败：' + (e?.message || e) });
  }
});

// 重启实例容器（仅管理员）：按当前本地镜像重建（保留数据卷 → 登录态不丢；快速，不联网拉取）。
app.post('/api/admin/instances/:id/restart', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await runInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '重启失败：' + (e?.message || e) });
  }
});

// 升级实例（仅管理员）：拉取最新微信镜像后重建（保留数据卷）。用于把旧实例更新到新版镜像
// （如修复"最小化丢失"等），类似「更新微信」但更新的是实例容器镜像本身。
app.post('/api/admin/instances/:id/upgrade', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await upgradeInstance(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '升级失败：' + (e?.message || e) });
  }
});

// 实例侧：设置该实例可被哪些账户访问
app.post('/api/admin/instances/:id/users', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const userIds = Array.isArray((req.body as any)?.userIds) ? (req.body as any).userIds : [];
  try {
    setInstanceUsers(id, userIds);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// ---------- 文件中转（有访问权限即可用；走面板鉴权，不额外暴露） ----------
// 上传：原始二进制直传，落到实例 ~/Desktop，微信文件选择器可直接选到。
app.post('/api/instances/:id/upload', { bodyLimit: 512 * 1024 * 1024 }, async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const name = String((req.query as any)?.name || '').trim();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件或格式错误' });
  try {
    await uploadToInstance(findInstance(id)!, name, body);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '上传失败' });
  }
});

// 列出可下载的中转文件
app.get('/api/instances/:id/files', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  try {
    return { files: await listInstanceFiles(findInstance(id)!) };
  } catch {
    return { files: [] };
  }
});

// 删除某个中转文件（有访问权限即可）
app.delete('/api/instances/:id/files', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const name = String((req.query as any)?.name || '').trim();
  try {
    await deleteInstanceFile(findInstance(id)!, name);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '删除失败' });
  }
});

// 下载某个中转文件
app.get('/api/instances/:id/download', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const name = String((req.query as any)?.name || '').trim();
  try {
    const buf = await downloadFromInstance(findInstance(id)!, name);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(buf);
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '下载失败' });
  }
});

// ---------- 多端协作：操作控制权（心跳软锁，避免多人同时操作打架） ----------
// 同一实例被多个浏览器连的是同一会话，键鼠会互相打架。这里用"心跳持锁"：
// 当前操作者每隔几秒 beat 续约；TTL 内他人只读（前端盖只读遮罩）。空闲超 TTL 自动释放。
const CONTROL_TTL = 10_000; // ms：超过则视为已空闲，可被接管
const controlHolders = new Map<string, { userId: string; username: string; at: number }>();

// 续约/认领：无人持有、已超时、或本来就是我 → 我成为操作者；否则返回当前操作者。
app.post('/api/instances/:id/control/beat', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const now = Date.now();
  const h = controlHolders.get(id);
  if (!h || now - h.at > CONTROL_TTL || h.userId === u.id) {
    controlHolders.set(id, { userId: u.id, username: u.username, at: now });
    return { mine: true, holder: u.username };
  }
  return { mine: false, holder: h.username };
});

// 只读查询当前操作者（前端轮询；不认领）。超 TTL 视为空闲。
app.get('/api/instances/:id/control', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const h = controlHolders.get(id);
  if (!h || Date.now() - h.at > CONTROL_TTL) return { free: true, mine: false, holder: null };
  return { free: false, mine: h.userId === u.id, holder: h.username };
});

// 主动接管（"申请控制"）：强制把操作权抢过来。
app.post('/api/instances/:id/control/take', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  controlHolders.set(id, { userId: u.id, username: u.username, at: Date.now() });
  return { mine: true, holder: u.username };
});

// 通过 xdotool 在实例容器内输入文字（绕过 VNC XKB keysym 容量限制，修复中文 IME 吞字）
app.post('/api/instances/:id/type', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const { text } = (req.body as any) ?? {};
  if (!text || typeof text !== 'string' || text.length > 500) return reply.code(400).send({ error: '文字为空或过长' });
  try {
    await typeInInstance(findInstance(id)!, text);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '输入失败' });
  }
});

// 查看实例容器日志（仅管理员）：排查"无法进入/未安装/卡死"等。inline 文本，浏览器可直接看/另存。
app.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    const text = await instanceLogs(inst);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(text || '（暂无日志）');
  } catch (e: any) {
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send('获取日志失败：' + (e?.message || e));
  }
});

// 该实例的微信安装状态（有访问权限即可看）
app.get('/api/instances/:id/wechat/status', async (req, reply) => {
  const u = await requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  return { status: await wechatStatus(findInstance(id)!) };
});

// 触发该实例微信下载/更新（仅管理员）
async function triggerInstanceWechat(id: string, cmd: 'install' | 'update', reply: FastifyReply) {
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await triggerWechat(inst, cmd);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: '无法触发安装：' + (e?.message || e) });
  }
}

app.post('/api/admin/instances/:id/wechat/install', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  return triggerInstanceWechat((req.params as any).id, 'install', reply);
});

app.post('/api/admin/instances/:id/wechat/update', async (req, reply) => {
  if (!await requireAdmin(req, reply)) return;
  return triggerInstanceWechat((req.params as any).id, 'update', reply);
});

// ---------- 反向代理到内网 KasmVNC（按实例注入 Basic auth，会话 + 权限把守） ----------
// 单个 proxy 实例，target 与凭据逐请求指定：凭据暂存在 req 上，proxyReq 时注入。
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
proxy.on('proxyReq', (proxyReq, req) => {
  const auth = (req as any)._wocAuth;
  if (auth) proxyReq.setHeader('authorization', auth);
});
proxy.on('proxyReqWs', (proxyReq, req) => {
  const auth = (req as any)._wocAuth;
  if (auth) proxyReq.setHeader('authorization', auth);
});
// 兜底：剥掉 KasmVNC 401 的 WWW-Authenticate 头，避免浏览器弹出原生 Basic Auth 登录框。
// 正常路径下我们已注入正确凭据（不会 401）；万一凭据失配，宁可桌面加载失败也绝不把登录弹窗暴露给用户。
proxy.on('proxyRes', (proxyRes) => {
  delete proxyRes.headers['www-authenticate'];
});
proxy.on('error', (_err, _req, res) => {
  try {
    const r = res as any;
    if (r && typeof r.writeHead === 'function') {
      r.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      r.end('桌面服务暂时不可用');
    } else if (r && typeof r.destroy === 'function') {
      r.destroy();
    }
  } catch {
    /* ignore */
  }
});

// /desktop/:id/rest → rest（剥掉前缀与实例段）。返回 null 表示 url 非法。
function parseDesktopUrl(rawUrl: string): { id: string; rest: string } | null {
  const m = rawUrl.match(/^\/desktop\/([0-9a-f]{6,})(\/.*|\?.*|)?$/);
  if (!m) return null;
  const id = m[1];
  let rest = m[2] || '/';
  if (rest.startsWith('?')) rest = '/' + rest;
  if (rest === '') rest = '/';
  return { id, rest };
}

const desktopHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const u = await currentUser(req);
  if (!u) {
    reply.code(302).header('location', '/login').send();
    return;
  }
  const parsed = parseDesktopUrl(req.raw.url || '');
  if (!parsed || !userCanAccess(u, parsed.id)) {
    reply.code(403).send({ error: '无权访问该实例' });
    return;
  }
  const inst = findInstance(parsed.id)!;
  reply.hijack();
  req.raw.url = parsed.rest;
  (req.raw as any)._wocAuth = basicAuth(inst);
  proxy.web(req.raw, reply.raw, { target: instanceTarget(inst) });
};

app.all('/desktop/:id', desktopHandler);
app.all('/desktop/:id/*', desktopHandler);

// ---------- 静态 SPA + 前端路由回退 ----------
await app.register(fstatic, { root: STATIC_DIR, wildcard: true, index: ['index.html'] });
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || '';
  if (url.startsWith('/api') || url.startsWith('/desktop')) {
    return reply.code(404).send({ error: 'not found' });
  }
  return reply.sendFile('index.html');
});

// ---------- 启动 + WebSocket 升级（同样校验会话） ----------
function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

await app.ready();

app.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  // DNS-rebinding gate for WebSocket upgrades (Fastify's onRequest hook does
  // not run on raw upgrades). KasmVNC proxying goes through this path.
  if (!isAllowedHost(parseHost(req.headers.host), ALLOWED_HOSTS)) {
    socket.destroy();
    return;
  }
  const parsed = req.url ? parseDesktopUrl(req.url) : null;
  if (!parsed) {
    socket.destroy();
    return;
  }
  const cookies = parseCookies(req.headers.cookie);
  const s = getSession(cookies[COOKIE]);
  const u = s && findById(s.userId);
  if (!u || u.disabled || !userCanAccess(u, parsed.id)) {
    socket.destroy();
    return;
  }
  const inst = findInstance(parsed.id)!;
  req.url = parsed.rest;
  (req as any)._wocAuth = basicAuth(inst);
  proxy.ws(req, socket, head, { target: instanceTarget(inst) });
});

// 探测面板网络 + 重启后把已登记实例的容器拉起来
await ensureNetwork().catch(() => {});
for (const pub of listInstances()) {
  try {
    await ensureRunning(findInstance(pub.id)!);
  } catch (e: any) {
    app.log.warn(`[instance] 启动实例 ${pub.id} 失败: ${e?.message || e}`);
  }
}

// Watchdog：KasmVNC/Xvnc 长跑会泄漏（实测 24h 可达 ~9 GiB），小内存机器会被拖垮。
// 两档阈值，按"是否有人在用"决定时机：
//   soft：mem >= soft 且当前无活跃会话 → 主动重启（柔和自愈，不打扰）
//   hard：mem >= hard → 无视会话强制重启（防止 OOM）
// 优先级 hard > soft。两档阈值可在面板"管理 → 实例卡片 → 安全"按钮里单实例覆盖；缺省走 env。
//
// env 默认（可被 per-instance 覆盖）：
//   WOC_INSTANCE_MEM_SOFT_MB    soft 阈值；默认 1500
//   WOC_INSTANCE_MEM_HARD_MB    hard 阈值；默认 2500（也兼容旧名 WOC_INSTANCE_MEM_LIMIT_MB）
//   WOC_WATCHDOG_INTERVAL_SEC   巡检间隔秒；默认 300（5 分钟），最小 60；0 关闭整个 watchdog
const DEFAULT_SOFT_MB = Math.max(0, Number(process.env.WOC_INSTANCE_MEM_SOFT_MB ?? 1500));
const DEFAULT_HARD_MB = Math.max(
  0,
  Number(process.env.WOC_INSTANCE_MEM_HARD_MB ?? process.env.WOC_INSTANCE_MEM_LIMIT_MB ?? 2500),
);
const WATCHDOG_INTERVAL_SEC = Math.max(60, Number(process.env.WOC_WATCHDOG_INTERVAL_SEC ?? 300));
const WATCHDOG_ENABLED = WATCHDOG_INTERVAL_SEC > 0 && (DEFAULT_SOFT_MB > 0 || DEFAULT_HARD_MB > 0);

// 单实例生效阈值：per-instance 覆盖优先；为 undefined 则用 env 默认。
function effectiveLimits(inst: Instance): { soft: number; hard: number } {
  return {
    soft: inst.memSoftLimitMB ?? DEFAULT_SOFT_MB,
    hard: inst.memHardLimitMB ?? DEFAULT_HARD_MB,
  };
}

// "当前有人在远程会话" 启发式判定：复用控制权心跳。前端在用户鼠标/键盘/滚轮交互时 2.5s 节流 beat，
// 故 holder 在 TTL 内即视为"有人在主动操作"。只看屏（不交互）超过 TTL 后会被判为空闲——这是有意的，
// 软自愈宁愿在"看似空闲"时短暂打扰，也不要拖到 hard 强制重启。
function hasActiveSession(id: string): boolean {
  const h = controlHolders.get(id);
  return !!h && Date.now() - h.at <= CONTROL_TTL;
}

if (WATCHDOG_ENABLED) {
  const recovering = new Set<string>(); // 防重入：自愈期间跳过本实例
  const tick = async () => {
    for (const pub of listInstances()) {
      const inst = findInstance(pub.id);
      if (!inst || recovering.has(inst.id)) continue;
      try {
        if ((await instanceRuntime(inst)) !== 'running') continue;
        const mb = await instanceMemoryMB(inst);
        if (mb === 0) continue;
        const { soft, hard } = effectiveLimits(inst);
        const active = hasActiveSession(inst.id);
        let reason: 'hard' | 'soft' | null = null;
        if (hard > 0 && mb >= hard) reason = 'hard';
        else if (soft > 0 && mb >= soft && !active) reason = 'soft';
        if (!reason) {
          if (soft > 0 && mb >= soft && active) {
            app.log.info(
              `[watchdog] ${inst.containerName} mem=${mb}MiB ≥ soft=${soft}MiB 但用户在使用（holder=${controlHolders.get(inst.id)?.username}），延后`,
            );
          }
          continue;
        }
        recovering.add(inst.id);
        if (reason === 'hard') {
          app.log.warn(
            `[watchdog] ${inst.containerName} mem=${mb}MiB ≥ hard=${hard}MiB，强制重启（active=${active}）`,
          );
        } else {
          app.log.warn(
            `[watchdog] ${inst.containerName} mem=${mb}MiB ≥ soft=${soft}MiB 且无活跃会话，柔和重启`,
          );
        }
        try {
          await stopInstance(inst);
          await runInstance(inst);
          app.log.info(`[watchdog] ${inst.containerName} 自愈完成（${reason}）`);
        } catch (e: any) {
          app.log.error(`[watchdog] ${inst.containerName} 自愈失败（${reason}）: ${e?.message || e}`);
        } finally {
          recovering.delete(inst.id);
        }
      } catch (e: any) {
        app.log.warn(`[watchdog] ${pub.id} 检查异常: ${e?.message || e}`);
      }
    }
  };
  setInterval(() => void tick(), WATCHDOG_INTERVAL_SEC * 1000).unref();
  console.log(
    `[watchdog] 已启用 · soft=${DEFAULT_SOFT_MB} MiB · hard=${DEFAULT_HARD_MB} MiB · 间隔=${WATCHDOG_INTERVAL_SEC}s`,
  );
}

await app.listen({ port: PORT, host: HOST });
console.log(`[panel] 监听 http://${HOST}:${PORT}  （多实例反代已就绪）`);
