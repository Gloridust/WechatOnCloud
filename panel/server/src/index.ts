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
  setInstanceIcon,
  setInstanceUsers,
  publicInstance,
  APP_TYPES,
  type AppType,
  type User,
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
  buildDiagnostics,
  typeInInstance,
  keyInInstance,
  listOrphanVolumes,
  removeVolume,
  listOrphanContainers,
  removeContainerById,
  instanceMemoryMB,
  instanceHttpHealthy,
  regenInstanceMachineId,
  listVolume,
  volMkdir,
  volMove,
  volDelete,
  volUploadFile,
  volExtractArchive,
  volDownloadFile,
  volBackupStream,
  volRestoreArchive,
} from './docker.js';
import { createSession, getSession, destroySession, destroyUserSessions } from './sessions.js';
import { parseHost, parseAllowedHosts, isRequestHostAllowed } from './host-guard.js';
import { CURRENT_VERSION, versionInfo, ensureChecked, checkForUpdate, startUpdateChecker } from './version.js';
import { appendInstanceLog, readInstanceLog, appendPanelLog, readPanelLog, pruneOldLogs, filterSince, rangeToMs, DIAG_RANGES } from './logs.js';

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

const app = Fastify({ logger: true, trustProxy: true });

// DNS-rebinding gate: reject requests whose Host header is neither a loopback /
// RFC1918 LAN address nor in PANEL_ALLOWED_HOSTS. Runs before every route so
// /api/*, /desktop/* and static-file responses are all covered.
app.addHook('onRequest', async (req, reply) => {
  if (!isRequestHostAllowed(req.headers.host, req.headers['x-forwarded-host'], ALLOWED_HOSTS)) {
    // 把被拒的 Host / X-Forwarded-Host 一起回显，反代调试时可一眼看出"后端实际收到的是什么"
    // —— 决定是去白名单加这个 host，还是修反代让它透传 Host。不泄露敏感信息。
    reply.code(400).send({
      error: 'Host header not allowed',
      host: parseHost(req.headers.host) || null,
      forwardedHost: req.headers['x-forwarded-host'] || null,
      hint: '反代部署请把对外域名加入 PANEL_ALLOWED_HOSTS（.env 逗号分隔，支持 *.example.com），改完用 docker compose up -d 重建容器（不是 restart）使其生效',
    });
  }
});

await app.register(cookie);
// 文件上传走原始二进制（前端以 application/octet-stream 直传 File）
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

// ---------- 鉴权辅助 ----------
function currentUser(req: FastifyRequest): User | null {
  const token = req.cookies?.[COOKIE];
  const s = getSession(token);
  if (!s) return null;
  const u = findById(s.userId);
  if (!u || u.disabled) return null;
  return u;
}

function requireAuth(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = currentUser(req);
  if (!u) {
    reply.code(401).send({ error: '未登录' });
    return null;
  }
  return u;
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): User | null {
  const u = requireAuth(req, reply);
  if (!u) return null;
  if (u.role !== 'admin') {
    reply.code(403).send({ error: '需要管理员权限' });
    return null;
  }
  return u;
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
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  return { user: publicUser(u) };
});

app.post('/api/auth/logout', async (req, reply) => {
  destroySession(req.cookies?.[COOKIE]);
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const u = currentUser(req);
  if (!u) return reply.code(401).send({ error: '未登录' });
  return { user: publicUser(u) };
});

// ---------- 版本与更新检测 ----------
// 当前构建版本 + 缓存的「最新版」检测结果（后台每 6h 查一次 Docker Hub/GHCR）。任何登录用户可读。
app.get('/api/version', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  ensureChecked(); // 刚启动还没首检时，触发一次后台检查（不阻塞本次响应）
  return versionInfo();
});
// 立即重新检查（管理员，用于「检查更新」按钮）。
app.post('/api/admin/version/check', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return await checkForUpdate();
});

// ---------- 自助改密 ----------
app.post('/api/account/password', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const { oldPassword, newPassword } = (req.body as any) ?? {};
  if (!verifyPassword(u, oldPassword ?? '')) return reply.code(400).send({ error: '原密码错误' });
  if (!newPassword || String(newPassword).length < 6) return reply.code(400).send({ error: '新密码至少 6 位' });
  resetPassword(u.id, newPassword);
  return { ok: true };
});

// ---------- 管理员：子账号管理 ----------
app.get('/api/admin/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { users: listUsers() };
});

app.post('/api/admin/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
  if (!requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const instanceIds = Array.isArray((req.body as any)?.instanceIds) ? (req.body as any).instanceIds : [];
  try {
    return { user: setUserInstances(id, instanceIds) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

app.post('/api/admin/users/:id/disable', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
  if (!requireAdmin(req, reply)) return;
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
  if (!requireAdmin(req, reply)) return;
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
  const u = requireAuth(req, reply);
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

// 用户自助「卡死自愈」：当客户端检测到 VNC 多次干净重连仍连不上（多半是实例 KasmVNC 的 ws 接收器卡死——
// nginx 仍能serve 静态页让 noVNC 显示"正在连接"，但新 ws 永远 accept 不了，刷新/重启面板都无效、只能重启容器），
// 客户端调用本接口重启该实例（数据卷保留，约十几秒恢复）。需对该实例有访问权；每实例 3 分钟限一次防重启风暴。
const lastHealAt = new Map<string, number>();
app.post('/api/instances/:id/heal', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const now = Date.now();
  if (now - (lastHealAt.get(id) || 0) < 180000) {
    return { ok: true, restarted: false, message: '近期已尝试恢复，请稍候重连' };
  }
  lastHealAt.set(id, now);
  appendPanelLog('WARN', `实例「${inst.name}」(id=${id}) 由 ${u.username} 触发卡死自愈（VNC 连不上 → 重启容器，数据保留）`);
  try {
    await runInstance(inst);
    return { ok: true, restarted: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `实例「${inst.name}」(id=${id}) 卡死自愈重启失败：${e?.message || e}`);
    return reply.code(500).send({ error: '恢复失败：' + (e?.message || e) });
  }
});

// 客户端连接日志：前端把 VNC 连接态/动作回传，记进实例持久日志（[client] 前缀），与 [vnc] 服务端日志对齐排查。
app.post('/api/instances/:id/clientlog', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const msg = String((req.body as any)?.msg ?? '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  if (msg) appendInstanceLog(id, `[client] ${msg}（${u.username}）`);
  return { ok: true };
});

// 新建实例（仅管理员）：生成凭据 + docker run + 分配访问账户
app.post('/api/admin/instances', async (req, reply) => {
  const admin = requireAdmin(req, reply);
  if (!admin) return;
  const { name, reuseVolume, appType } = (req.body as any) ?? {};
  const allowedUserIds = Array.isArray((req.body as any)?.allowedUserIds) ? (req.body as any).allowedUserIds : [];
  if (!name || String(name).trim().length === 0 || String(name).length > 30) {
    return reply.code(400).send({ error: '实例名称为 1-30 个字符' });
  }
  const type: AppType = APP_TYPES.includes(appType) ? appType : 'wechat';
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
  const inst = createInstance(String(name), admin.id, allowedUserIds, reuseVolumeName, type);
  appendPanelLog(
    'INFO',
    `创建实例「${inst.name}」(${type}, id=${inst.id}) by ${admin.username}${reuseVolumeName ? ` · 复用卷 ${reuseVolumeName}` : ''} → 开始创建容器（镜像缺失会自动拉取，首次较慢）`,
  );
  appendInstanceLog(inst.id, `实例创建（${type}）by ${admin.username}`);
  try {
    await runInstance(inst);
  } catch (e: any) {
    removeInstanceRecord(inst.id); // 容器起不来则回滚登记
    appendPanelLog('ERROR', `创建实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '创建容器失败：' + (e?.message || e) });
  }
  appendPanelLog('INFO', `创建实例「${inst.name}」(id=${inst.id}) 成功`);
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

// 重置实例的设备 machine-id（仅管理员）：滚一个全新的唯一设备身份并重启实例。
// 用于某微信账号被腾讯按"设备风险"标记、登录即被踢时，像"换台新设备"一样恢复。会触发重新扫码登录。
app.post('/api/admin/instances/:id/regen-machine-id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await regenInstanceMachineId(inst);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '重置设备 ID 失败' });
  }
});

// 删除实例（仅管理员）：默认保留数据卷，?purge=1 才永久删聊天记录
app.delete('/api/admin/instances/:id', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const id = (req.params as any).id;
  const purge = (req.query as any)?.purge === '1' || (req.query as any)?.purge === 'true';
  const inst = findInstance(id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  appendPanelLog('INFO', `删除实例「${inst.name}」(id=${id})${purge ? ' · 同时清除数据卷' : ' · 保留数据卷'}`);
  await removeInstanceContainer(inst, purge);
  removeInstanceRecord(id);
  controlHolders.delete(id);
  return { ok: true };
});

// 重命名实例（仅管理员）：只改显示名，不动容器/卷。
app.post('/api/admin/instances/:id/rename', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { name } = (req.body as any) ?? {};
  try {
    return { instance: renameInstance((req.params as any).id, String(name ?? '')) };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

// 设置实例自定义图标（仅管理员）：icon = builtin:<key> / data:image 图片 / 空串(恢复默认)。
app.post('/api/admin/instances/:id/icon', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { icon } = (req.body as any) ?? {};
  try {
    return { instance: setInstanceIcon((req.params as any).id, typeof icon === 'string' ? icon : null) };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '设置图标失败' });
  }
});

// 启动实例容器（仅管理员）：容器停止或被删后，一键拉起（不重建数据卷）。
app.post('/api/admin/instances/:id/start', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await ensureRunning(inst);
    appendPanelLog('INFO', `启动实例「${inst.name}」(id=${inst.id})`);
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `启动实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '启动失败：' + (e?.message || e) });
  }
});

// 停止实例容器（仅管理员）：保留容器与数据卷。
app.post('/api/admin/instances/:id/stop', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await stopInstance(inst);
    appendPanelLog('INFO', `停止实例「${inst.name}」(id=${inst.id})`);
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `停止实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '停止失败：' + (e?.message || e) });
  }
});

// 重启实例容器（仅管理员）：按当前本地镜像重建（保留数据卷 → 登录态不丢；快速，不联网拉取）。
app.post('/api/admin/instances/:id/restart', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    appendPanelLog('INFO', `重启实例「${inst.name}」(id=${inst.id})`);
    await runInstance(inst);
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `重启实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '重启失败：' + (e?.message || e) });
  }
});

// 升级实例（仅管理员）：拉取最新微信镜像后重建（保留数据卷）。用于把旧实例更新到新版镜像
// （如修复"最小化丢失"等），类似「更新微信」但更新的是实例容器镜像本身。
app.post('/api/admin/instances/:id/upgrade', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    appendPanelLog('INFO', `升级实例「${inst.name}」(id=${inst.id})：拉取最新镜像后重建`);
    await upgradeInstance(inst);
    appendPanelLog('INFO', `升级实例「${inst.name}」(id=${inst.id}) 完成`);
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `升级实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '升级失败：' + (e?.message || e) });
  }
});

// 实例侧：设置该实例可被哪些账户访问
app.post('/api/admin/instances/:id/users', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
  const u = requireAuth(req, reply);
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
  const u = requireAuth(req, reply);
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
  const u = requireAuth(req, reply);
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
  const u = requireAuth(req, reply);
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
  const u = requireAuth(req, reply);
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
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const h = controlHolders.get(id);
  if (!h || Date.now() - h.at > CONTROL_TTL) return { free: true, mine: false, holder: null };
  return { free: false, mine: h.userId === u.id, holder: h.username };
});

// 主动接管（"申请控制"）：强制把操作权抢过来。
app.post('/api/instances/:id/control/take', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  controlHolders.set(id, { userId: u.id, username: u.username, at: Date.now() });
  return { mine: true, holder: u.username };
});

// 通过 xdotool 在实例容器内输入文字（绕过 VNC XKB keysym 容量限制，修复中文 IME 吞字）
app.post('/api/instances/:id/type', async (req, reply) => {
  const u = requireAuth(req, reply);
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

// 模拟单个按键（无感输入模式下按序送出被截下的回车/退格，保证与中文转发的顺序）
app.post('/api/instances/:id/key', async (req, reply) => {
  const u = requireAuth(req, reply);
  if (!u) return;
  const id = (req.params as any).id;
  if (!userCanAccess(u, id)) return reply.code(403).send({ error: '无权访问该实例' });
  const { key } = (req.body as any) ?? {};
  if (!key || typeof key !== 'string') return reply.code(400).send({ error: '按键名为空' });
  try {
    await keyInInstance(findInstance(id)!, key);
    return { ok: true };
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '按键失败' });
  }
});

// 查看实例容器日志（仅管理员）：排查"无法进入/未安装/卡死"等。inline 文本，浏览器可直接看/另存。
app.get('/api/admin/instances/:id/logs', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  reply.header('content-type', 'text/plain; charset=utf-8');
  // 持久化历史（重启原因 + 上一容器日志快照，跨重建保留）+ 本次容器实时日志。
  const history = readInstanceLog(inst.id).trimEnd();
  let live = '';
  try {
    live = (await instanceLogs(inst)).trimEnd();
  } catch (e: any) {
    live = '获取本次容器日志失败：' + (e?.message || e);
  }
  if (!history && !live) return reply.send('（暂无日志）');
  if (!history) return reply.send(live);
  return reply.send(
    `═══ 历史日志（持久化 · 跨重启保留）═══\n${history}\n\n═══ 本次容器日志（实时）═══\n${live || '（本次容器暂无日志）'}`,
  );
});

// ---------- 全局日志 / 诊断包（仅管理员）----------
// 面板全局运维日志（创建/删除/升级/启停/镜像拉取/错误等跨实例事件），可按时间范围裁剪。
app.get('/api/admin/panel-log', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  reply.header('content-type', 'text/plain; charset=utf-8');
  const since = Date.now() - rangeToMs((req.query as any)?.range);
  const text = filterSince(readPanelLog(), since).trimEnd();
  return reply.send(text || '（暂无面板日志）');
});

// 一键导出诊断包（tar.gz）：系统信息 + 面板日志 + 各实例容器状态/持久日志/实时日志 + 全部容器清单。
// 单实例日志只记录"实例内单次日志"，这里把全局 + 全部实例 + 容器层面的信息打包，便于排查
// 首个实例创建卡死 / 打开实例黑屏不可用 / 升级失败等问题。range：24h（默认）/7d/30d/1y。
app.get('/api/admin/diagnostics', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const range = ((req.query as any)?.range as string) || '24h';
  if (!DIAG_RANGES[range]) return reply.code(400).send({ error: '时间范围非法（24h/7d/30d/1y）' });
  const since = Date.now() - rangeToMs(range);
  try {
    const buf = await buildDiagnostics(listInstances(), since, { range, 面板版本: CURRENT_VERSION });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="woc-diag-${range}-${stamp}.tar.gz"`);
    appendPanelLog('INFO', `导出诊断包（范围 ${range}，${buf.length} 字节）`);
    return reply.send(buf);
  } catch (e: any) {
    appendPanelLog('ERROR', `导出诊断包失败：${e?.message || e}`);
    return reply.code(500).send({ error: '生成诊断包失败：' + (e?.message || e) });
  }
});

// ---------- 数据卷管理（仅管理员）：浏览/上传/解压/下载/改名/移动/删除 + 整卷备份/恢复 ----------
// 数据卷 = 容器 /config，含微信完整会话与加密聊天库 → 仅 admin 可见可用（admin 本就有 docker.sock=宿主 root，
// 不新增风险；子账号永不可达）。
// 全程在「运行中」的实例上操作：浏览/改名/移动/删除靠 docker exec（需容器运行），上传/解压/下载/备份靠
// getArchive/putArchive。不强制停止实例（exec 在停止容器无法运行）。整卷恢复会覆盖全部数据，前端强提示
// 并建议恢复后重启实例以加载数据。

// 浏览目录（一层）
app.get('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    return await listVolume(inst, String((req.query as any)?.path || ''));
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '读取目录失败' });
  }
});

// 新建文件夹
app.post('/api/admin/instances/:id/volume/mkdir', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await volMkdir(inst, String((req.body as any)?.path || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '新建失败' });
  }
});

// 重命名 / 移动
app.post('/api/admin/instances/:id/volume/move', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const { from, to } = (req.body as any) ?? {};
  try {
    await volMove(inst, String(from || ''), String(to || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '移动失败' });
  }
});

// 删除文件 / 目录
app.delete('/api/admin/instances/:id/volume', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    await volDelete(inst, String((req.query as any)?.path || ''));
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '删除失败' });
  }
});

// 下载单个文件
app.get('/api/admin/instances/:id/volume/download', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const path = String((req.query as any)?.path || '');
  const name = path.split('/').filter(Boolean).pop() || 'file';
  try {
    const buf = await volDownloadFile(inst, path);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(buf);
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '下载失败' });
  }
});

// 上传单个文件到当前目录（原始二进制；落地为 abc 属主）
app.post('/api/admin/instances/:id/volume/upload', { bodyLimit: 2 * 1024 * 1024 * 1024 }, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const path = String((req.query as any)?.path || '');
  const name = String((req.query as any)?.name || '').trim();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件或格式错误' });
  try {
    await volUploadFile(inst, path, name, body);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '上传失败' });
  }
});

// 上传压缩包并解压到当前目录（.tar / .tar.gz；PC 微信数据迁移用）
app.post('/api/admin/instances/:id/volume/extract', { bodyLimit: 3 * 1024 * 1024 * 1024 }, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件或格式错误' });
  try {
    await volExtractArchive(inst, String((req.query as any)?.path || ''), body);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '解压失败（请确认是 .tar 或 .tar.gz）' });
  }
});

// 整卷备份：流式下载 /config 为 .tar.gz
app.get('/api/admin/instances/:id/volume/backup', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  try {
    const stream = await volBackupStream(inst);
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`woc-${inst.name}-backup.tar.gz`)}`);
    return reply.send(stream);
  } catch (e: any) {
    return reply.code(500).send({ error: e?.message || '备份失败' });
  }
});

// 整卷恢复：上传本系统导出的 .tar.gz 备份（要求实例已停止）
app.post('/api/admin/instances/:id/volume/restore', { bodyLimit: 3 * 1024 * 1024 * 1024 }, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件或格式错误' });
  try {
    await volRestoreArchive(inst, body);
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e?.message || '恢复失败' });
  }
});

// 该实例的微信安装状态（有访问权限即可看）
app.get('/api/instances/:id/wechat/status', async (req, reply) => {
  const u = requireAuth(req, reply);
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
    appendPanelLog('INFO', `实例「${inst.name}」(id=${id}) 触发${cmd === 'install' ? '下载安装' : '更新'}应用`);
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `实例「${inst.name}」(id=${id}) 触发${cmd === 'install' ? '安装' : '更新'}失败：${e?.message || e}`);
    return reply.code(500).send({ error: '无法触发安装：' + (e?.message || e) });
  }
}

app.post('/api/admin/instances/:id/wechat/install', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return triggerInstanceWechat((req.params as any).id, 'install', reply);
});

app.post('/api/admin/instances/:id/wechat/update', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
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
  // 上游（实例 nginx → KasmVNC websockify）回 101 = ws 接收器接受了连接，桌面真正连上。
  // 卡死时这条不会出现（接收器停止 accept），即可定位"卡在面板→实例之间还是实例内部"。
  const instId = (req as any)._wocInstId;
  if (instId) proxyReq.on('upgrade', () => appendInstanceLog(instId, '[vnc] 上游已接受(101) · 桌面连接建立'));
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

const desktopHandler = (req: FastifyRequest, reply: FastifyReply) => {
  const u = currentUser(req);
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
await app.register(fstatic, { root: STATIC_DIR, wildcard: false, index: ['index.html'] });
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
  if (!isRequestHostAllowed(req.headers.host, req.headers['x-forwarded-host'], ALLOWED_HOSTS)) {
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
  (req as any)._wocInstId = inst.id;
  // 远程桌面连接日志：记录每次 ws 连接尝试 / 上游接受(在 proxyReqWs 里) / 失败 / 关闭时长。
  // 与实例容器内 KasmVNC 的 "got client connection" 按时间对齐，即可看出卡在哪一段。
  const ip = (req.socket && req.socket.remoteAddress) || '?';
  const uname = (u as any).username || '?';
  appendInstanceLog(inst.id, `[vnc] 连接尝试 user=${uname} ip=${ip}`);
  const t0 = Date.now();
  socket.on('close', () => appendInstanceLog(inst.id, `[vnc] 连接关闭（持续 ${Math.round((Date.now() - t0) / 1000)}s）`));
  proxy.ws(req, socket, head, { target: instanceTarget(inst) }, (err: any) => {
    appendInstanceLog(inst.id, `[vnc] 连接失败：${err?.message || err}`);
  });
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
//   WOC_WATCHDOG_HEALTH_FAILS   VNC 响应性探测：连续无响应几次才重启；默认 0=关闭该探测（仅保留内存自愈）
const DEFAULT_SOFT_MB = Math.max(0, Number(process.env.WOC_INSTANCE_MEM_SOFT_MB ?? 1500));
const DEFAULT_HARD_MB = Math.max(
  0,
  Number(process.env.WOC_INSTANCE_MEM_HARD_MB ?? process.env.WOC_INSTANCE_MEM_LIMIT_MB ?? 2500),
);
const WATCHDOG_INTERVAL_SEC = Math.max(60, Number(process.env.WOC_WATCHDOG_INTERVAL_SEC ?? 300));
// VNC 响应性探测默认关闭（=0）。实测健康实例 ~1ms 响应，但偶发宿主级 CPU/IO 争用（如同机重 docker build）
// 会让探测超时被误判为 stall 而重启正常实例，故默认不启用；需要时设为正整数 N（连续 N 次无响应才重启）开启。
const HEALTH_FAIL_LIMIT = Math.max(0, Number(process.env.WOC_WATCHDOG_HEALTH_FAILS ?? 0));
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
  const healthFails = new Map<string, number>(); // id → 连续无响应次数（仅 HEALTH_FAIL_LIMIT>0 时启用）

  const recover = async (inst: Instance, reason: string, detail: string) => {
    recovering.add(inst.id);
    app.log.warn(`[watchdog] ${inst.containerName} ${detail}`);
    appendInstanceLog(inst.id, `[看门狗] 自愈重启（${reason}）：${detail}`);
    appendPanelLog('WARN', `[看门狗] 实例「${inst.name}」(id=${inst.id}) 自愈重启（${reason}）：${detail}`);
    try {
      await stopInstance(inst);
      await runInstance(inst);
      healthFails.delete(inst.id);
      app.log.info(`[watchdog] ${inst.containerName} 自愈完成（${reason}）`);
    } catch (e: any) {
      appendPanelLog('ERROR', `[看门狗] 实例「${inst.name}」(id=${inst.id}) 自愈失败（${reason}）：${e?.message || e}`);
      app.log.error(`[watchdog] ${inst.containerName} 自愈失败（${reason}）: ${e?.message || e}`);
    } finally {
      recovering.delete(inst.id);
    }
  };

  const tick = async () => {
    for (const pub of listInstances()) {
      const inst = findInstance(pub.id);
      if (!inst || recovering.has(inst.id)) continue;
      try {
        if ((await instanceRuntime(inst)) !== 'running') {
          healthFails.delete(inst.id);
          continue;
        }
        // 1) 内存阈值自愈（既有）：hard 强制 / soft 仅在无人会话时
        const mb = await instanceMemoryMB(inst);
        if (mb > 0) {
          const { soft, hard } = effectiveLimits(inst);
          const active = hasActiveSession(inst.id);
          if (hard > 0 && mb >= hard) {
            await recover(inst, 'hard', `mem=${mb}MiB ≥ hard=${hard}MiB，强制重启（active=${active}）`);
            continue;
          }
          if (soft > 0 && mb >= soft && !active) {
            await recover(inst, 'soft', `mem=${mb}MiB ≥ soft=${soft}MiB 且无活跃会话，柔和重启`);
            continue;
          }
          if (soft > 0 && mb >= soft && active) {
            app.log.info(`[watchdog] ${inst.containerName} mem=${mb}MiB ≥ soft=${soft}MiB 但用户在使用，延后`);
          }
        }
        // 2) 响应性自愈：探测 VNC 是否还能提供页面；连续 N 次无响应 → 重启。
        //    应对"进程没死、显示在线，但 I/O/服务 stall 读不出 VNC 文件、永远卡在正在连接桌面"。
        //    默认关闭（HEALTH_FAIL_LIMIT=0）：偶发宿主级争用会误判健康实例为 stall；需要时用 env 开启。
        if (HEALTH_FAIL_LIMIT > 0) {
          const healthy = await instanceHttpHealthy(inst);
          if (healthy) {
            healthFails.delete(inst.id);
            continue;
          }
          const fails = (healthFails.get(inst.id) || 0) + 1;
          healthFails.set(inst.id, fails);
          app.log.warn(`[watchdog] ${inst.containerName} VNC 无响应（连续 ${fails}/${HEALTH_FAIL_LIMIT}）`);
          if (fails >= HEALTH_FAIL_LIMIT) {
            await recover(inst, 'unresponsive', `VNC 连续 ${fails} 次无响应（疑似 I/O/服务 stall），自愈重启`);
          }
        }
      } catch (e: any) {
        app.log.warn(`[watchdog] ${pub.id} 检查异常: ${e?.message || e}`);
      }
    }
  };
  setInterval(() => void tick(), WATCHDOG_INTERVAL_SEC * 1000).unref();
  console.log(
    `[watchdog] 已启用 · soft=${DEFAULT_SOFT_MB} MiB · hard=${DEFAULT_HARD_MB} MiB · 间隔=${WATCHDOG_INTERVAL_SEC}s · VNC响应性探测=${HEALTH_FAIL_LIMIT > 0 ? `连续${HEALTH_FAIL_LIMIT}次` : '关闭'}`,
  );
}

await app.listen({ port: PORT, host: HOST });
console.log(`[panel] 监听 http://${HOST}:${PORT}  （多实例反代已就绪）· 版本 ${CURRENT_VERSION}`);
appendPanelLog('INFO', `面板启动 · 版本 ${CURRENT_VERSION} · 监听 ${HOST}:${PORT}`);
startUpdateChecker(); // 后台检测新版（best-effort，失败静默）
// 日志保留期清理：启动后跑一次 + 每 24h 一次，删除超过一年的日志行（unref 不阻止退出）。
pruneOldLogs();
setInterval(() => pruneOldLogs(), 24 * 60 * 60 * 1000).unref();
