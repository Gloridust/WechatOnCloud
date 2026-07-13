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
  renameUser,
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
  getDesktopDark,
  setDesktopDark,
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
  latestInstanceImageId,
  instanceOutdated,
  pullImage,
  pruneDanglingImages,
  pruneOldWocImages,
  remoteInstanceImageNewer,
  resolveInstanceImage,
  removeInstance as removeInstanceContainer,
  instanceRuntime,
  instanceImageVersion,
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
  listBackgrounds,
  uploadBackground,
  applyBackground,
  deleteBackground,
  getBackgroundImage,
  getCurrentBackground,
  clearBackground,
  listFonts,
  uploadFont,
  deleteFont,
  applyFont,
  getAppliedFont,
  getFontFamily,
} from './docker.js';
import { createSession, getSession, destroySession, destroyUserSessions, SESSION_TTL_MS } from './sessions.js';
import { parseHost, parseAllowedHosts, isRequestHostAllowed } from './host-guard.js';
import { CURRENT_VERSION, versionInfo, ensureChecked, checkForUpdate, startUpdateChecker } from './version.js';
import { triggerSelfUpdate } from './self-update.js';
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
    return reply; // 显式终止后续生命周期（async 钩子里已 send 时的规范写法，防继续进入路由）
  }
});

await app.register(cookie);
// 文件上传走原始二进制（前端以 application/octet-stream 直传 File）
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
// Heartbeat and other no-body POST routes send no Content-Type; fall through to this wildcard
// instead of being rejected with 415. Fastify's exact-match parsers above take priority.
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, _body, done) => done(null, null));

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
  // 会话滑动续期（见 sessions.ts）：服务端刚续过期时间的话，顺手把 cookie 的 maxAge 也刷新，
  // 浏览器侧同步续期——否则服务端会话还活着、cookie 却先过期，效果等于没续。
  const token = req.cookies?.[COOKIE];
  const s = token ? getSession(token) : null;
  if (s?.slid) {
    s.slid = false;
    reply.setCookie(COOKIE, token!, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
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
// 登录限速：NAS 面板常被直接暴露公网，无限速 = 可被无脑爆破。
// 双键计数：来源 IP+用户名（5 次/15 分钟）防单账号爆破；来源 IP（20 次/15 分钟）防换用户名轮询。
// 用 socket 直连地址而非 X-Forwarded-For——trustProxy 开着，XFF 可伪造，直连地址不可伪造
// （反代场景下直连地址是反代 IP，限速粒度变粗但依然有效兜底）。成功登录清零。纯内存，重启即清。
const loginFails = new Map<string, { n: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginFailCheck(key: string, max: number): boolean {
  const e = loginFails.get(key);
  if (!e || e.resetAt < Date.now()) return true;
  return e.n < max;
}
function loginFailBump(key: string): void {
  const e = loginFails.get(key);
  if (!e || e.resetAt < Date.now()) loginFails.set(key, { n: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else e.n++;
  // 防内存膨胀：过千条时清一次过期项
  if (loginFails.size > 1000) for (const [k, v] of loginFails) if (v.resetAt < Date.now()) loginFails.delete(k);
}
app.post('/api/auth/login', async (req, reply) => {
  const { username, password } = (req.body as any) ?? {};
  const ip = req.raw.socket?.remoteAddress || '?';
  const ipKey = `ip:${ip}`;
  const userKey = `u:${ip}|${String(username || '')}`;
  if (!loginFailCheck(ipKey, 20) || !loginFailCheck(userKey, 5)) {
    appendPanelLog('WARN', `登录限速触发：来源 ${ip} 尝试登录「${String(username || '')}」被暂时拒绝（15 分钟窗口内失败过多）`);
    return reply.code(429).send({ error: '登录失败次数过多，请 15 分钟后再试' });
  }
  const u = username ? findByUsername(username) : undefined;
  if (!u || u.disabled || !verifyPassword(u, password ?? '')) {
    loginFailBump(ipKey);
    loginFailBump(userKey);
    return reply.code(401).send({ error: '用户名或密码错误' });
  }
  loginFails.delete(ipKey);
  loginFails.delete(userKey);
  const token = createSession(u.id);
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000), // 与服务端会话时长一致（WOC_SESSION_DAYS，默认 30 天）
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

// 一键更新面板自身（管理员）：拉新镜像 → 派生 helper 容器重建 woc-panel（带健康检查 + 失败回滚）。
// 返回后面板会在十几秒内被 helper 重启，前端提示用户稍候刷新。
app.post('/api/admin/version/self-update', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  try {
    const { target } = await triggerSelfUpdate();
    return { ok: true, target, message: '已开始更新：面板将在十几秒内重启为新版本，请稍候刷新页面' };
  } catch (e: any) {
    appendPanelLog('ERROR', `面板自更新失败：${e?.message || e}`);
    return reply.code(500).send({ error: '更新失败：' + (e?.message || e) });
  }
});

// ---------- 实例桌面深色（与面板主题统一的那个开关）----------
// 读取当前实例深色状态（任何登录用户可读，用于前端同步主题开关与实例的一致性）。
app.get('/api/desktop-theme', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { dark: getDesktopDark() };
});
// 设置实例深色（管理员）。面板顶栏主题开关切到 深/浅 时调用：持久化即可。它作为浏览器(Chromium)实例
// 启动时的明暗（经 envList → WOC_DARK 下发，autostart 据此加 --force-dark-mode），故**重启实例后生效**，
// 不做在线切换（极简容器内无稳定的桌面 portal，微信也不跟随，详见 docker/autostart 注释）。
app.post('/api/admin/desktop-theme', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const dark = !!(req.body as any)?.dark;
  setDesktopDark(dark);
  appendPanelLog('INFO', `实例深色设为 ${dark ? '深色' : '浅色'}（浏览器实例重启后生效）`);
  return { ok: true, dark };
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

// 改用户名（登录名）。会话以 userId 为准，改名后保持登录、下次用新名登录即可。
app.post('/api/admin/users/:id/rename', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { username } = (req.body as any) ?? {};
  const id = (req.params as any).id;
  if (!username || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return reply.code(400).send({ error: '用户名为 3-20 位字母、数字或下划线' });
  }
  try {
    return { user: renameUser(id, username) };
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
      const [runtime, wx, imageVersion] = await Promise.all([
        instanceRuntime(inst),
        wechatStatus(inst),
        instanceImageVersion(inst), // 实例镜像版本（CI label；自构建为短 id）——让用户能自查"到底跑的哪版"
      ]);
      return { ...pub, runtime, wechat: wx, imageVersion };
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
    await runInstance(inst, { keepImage: true }); // 自愈=重启，幂等：沿用当前镜像，绝不隐式换版
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
    await runInstance(inst, { keepImage: true }); // 重启必须幂等：沿用当前镜像，换镜像只走显式「升级」
    return { ok: true };
  } catch (e: any) {
    appendPanelLog('ERROR', `重启实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    return reply.code(500).send({ error: '重启失败：' + (e?.message || e) });
  }
});

// 升级实例（仅管理员）：拉取最新微信镜像后重建（保留数据卷）。
// 异步化：拉取在受限网络下可达数分钟（要等到停滞超时），同步等待会被反代在 ~60s 掐断——
// 前端误报「升级失败」而后台其实还在跑，用户再点一次就撞出并发重建。改为：登记 → 立即返回，
// 前端轮询 upgrade-status 的 upgradingIds 直到该实例移出。
const upgradingIds = new Set<string>();
app.post('/api/admin/instances/:id/upgrade', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = findInstance((req.params as any).id);
  if (!inst) return reply.code(404).send({ error: '实例不存在' });
  if (upgradeAllState.running) return reply.code(409).send({ error: '「一键升级全部实例」进行中，请等它完成' });
  if (upgradingIds.has(inst.id)) return reply.code(409).send({ error: '该实例已在升级中' });
  upgradingIds.add(inst.id);
  void (async () => {
    try {
      appendPanelLog('INFO', `升级实例「${inst.name}」(id=${inst.id})：拉取最新镜像后重建`);
      await upgradeInstance(inst);
      appendPanelLog('INFO', `升级实例「${inst.name}」(id=${inst.id}) 完成`);
    } catch (e: any) {
      appendPanelLog('ERROR', `升级实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
    } finally {
      upgradingIds.delete(inst.id);
      // 没有其他升级在跑时顺手回收旧版本镜像（含带 tag 的历史版本，非仅悬空）
      if (!upgradingIds.size && !upgradeAllState.running) void pruneOldWocImages();
    }
  })();
  return { ok: true, started: true };
});

// 实例镜像升级状态：哪些实例的镜像落后于本地最新镜像（用于面板"实例可升级"红点 + 一键升级）。
// 面板与实例是两套镜像/容器：更新面板不会动实例，故用户常"更新了面板、实例还是旧镜像"（例：设壁纸报 127）。
app.get('/api/admin/instances/upgrade-status', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const latestId = await latestInstanceImageId();
  const list = listInstances();
  const results = await Promise.all(
    list.map(async (inst) => ({ id: inst.id, name: inst.name, outdated: await instanceOutdated(inst, latestId) })),
  );
  const outdated = results.filter((r) => r.outdated);
  return {
    known: !!latestId,
    outdatedCount: outdated.length,
    outdatedIds: outdated.map((r) => r.id),
    instances: results,
    // 远端 registry 是否有比本地更新的实例镜像（null=未知/离线）。补 instanceOutdated 的盲区：
    // 用户更新面板后本地实例镜像还是旧的，仅比本地会误报"无可升级"。
    remoteNewer: remoteInstanceImageNewer(),
    upgradeAll: upgradeAllState, // 一键升级进行中的进度（running=false 表示空闲/已完成）
    upgradingIds: [...upgradingIds], // 单实例升级中的实例（前端轮询用）
  };
});

// 一键升级全部"镜像落后"的实例。
// 异步化：拉镜像 + 逐个重建可能耗时数分钟到更久（受限网络下拉取要等到停滞超时），同步等待会让
// 前端请求悬死、代理超时——用户反馈"一键升级一直卡死"。改为：立即返回，后台顺序执行，
// 前端轮询 upgrade-status 里的 upgradeAll 进度。
// 顺序很关键：先拉镜像、再判定谁落后。反过来会把"本来等于旧最新版"的实例漏掉——拉取带来
// 更新后它们才变落后，用户点完"全部升级"却发现横幅还在。
let upgradeAllState = { running: false, total: 0, done: 0, failed: 0, phase: '' };
app.post('/api/admin/instances/upgrade-all', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  if (upgradeAllState.running) return reply.code(409).send({ error: '一键升级正在进行中，请等待完成' });
  if (upgradingIds.size) return reply.code(409).send({ error: '有实例正在单独升级，请等它完成' });
  upgradeAllState = { running: true, total: 0, done: 0, failed: 0, phase: '拉取最新实例镜像…' };
  void (async () => {
    try {
      // ① 统一拉取一次（失败不阻断：用本地已有镜像重建）
      try {
        await pullImage();
      } catch (e: any) {
        appendPanelLog('WARN', `一键升级：拉取镜像失败（${e?.message || e}），改用本地镜像重建`);
      }
      // ② 拉取后再判定落后清单
      const latestId = await latestInstanceImageId();
      if (!latestId) {
        appendPanelLog('ERROR', '一键升级：本地尚无实例镜像且拉取失败，无法继续');
        return;
      }
      const outdated: ReturnType<typeof listInstances> = [];
      for (const inst of listInstances()) if (await instanceOutdated(inst, latestId)) outdated.push(inst);
      upgradeAllState.total = outdated.length;
      if (!outdated.length) {
        appendPanelLog('INFO', '一键升级：所有实例已是最新镜像');
        return;
      }
      // ③ 逐个重建（跳过重复拉取）
      for (const inst of outdated) {
        upgradeAllState.phase = `升级「${inst.name}」…`;
        upgradingIds.add(inst.id);
        try {
          appendPanelLog('INFO', `一键升级实例「${inst.name}」(id=${inst.id})…`);
          await upgradeInstance(inst, { skipPull: true });
        } catch (e: any) {
          upgradeAllState.failed++;
          appendPanelLog('ERROR', `一键升级实例「${inst.name}」(id=${inst.id}) 失败：${e?.message || e}`);
        } finally {
          upgradingIds.delete(inst.id);
        }
        upgradeAllState.done++;
      }
      appendPanelLog('INFO', `一键升级全部实例完成：成功 ${upgradeAllState.done - upgradeAllState.failed}、失败 ${upgradeAllState.failed}`);
      // ④ 升级后清理旧版本镜像（含带 tag 的历史版本）防磁盘堆积
      await pruneOldWocImages();
    } finally {
      upgradeAllState = { ...upgradeAllState, running: false, phase: '' };
    }
  })();
  return { ok: true, started: true };
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

// ---------- 桌面壁纸管理 ----------
const bgHandler = (id: string, reply: FastifyReply): Instance | null => {
  const inst = findInstance(id);
  if (!inst) {
    reply.code(404).send({ error: '实例不存在' });
    return null; // 关键：reply 是 truthy，不能 return 它，否则调用方 `if (!inst)` 拦不住
  }
  return inst;
};

app.get('/api/admin/instances/:id/backgrounds', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try { return { backgrounds: await listBackgrounds(inst) }; }
  catch (e: any) { return reply.code(500).send({ error: e?.message || '列出壁纸失败' }); }
});

app.post('/api/admin/instances/:id/backgrounds', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  const name = String((req.query as any)?.name || '').trim();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件' });
  try {
    await uploadBackground(inst, name, body);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '上传失败' }); }
});

app.get('/api/admin/instances/:id/backgrounds/current', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try { return { background: await getCurrentBackground(inst) }; }
  catch (e: any) { return reply.code(500).send({ error: e?.message || '获取当前壁纸失败' }); }
});

app.get('/api/admin/instances/:id/backgrounds/:name/image', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    const buf = await getBackgroundImage(inst, (req.params as any).name, true);
    const name = (req.params as any).name as string;
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'png';
    const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
    reply.header('Content-Type', mime[ext] || 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(buf);
  } catch (e: any) { return reply.code(404).send({ error: '图片不存在' }); }
});

app.post('/api/admin/instances/:id/backgrounds/:name/apply', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await applyBackground(inst, (req.params as any).name);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '应用壁纸失败' }); }
});

app.post('/api/admin/instances/:id/backgrounds/clear', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await clearBackground(inst);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '清除壁纸失败' }); }
});

app.delete('/api/admin/instances/:id/backgrounds/:name', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await deleteBackground(inst, (req.params as any).name);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '删除失败' }); }
});

// ---------- 字体管理 ----------
app.get('/api/admin/instances/:id/fonts', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try { return { fonts: await listFonts(inst) }; }
  catch (e: any) { return reply.code(500).send({ error: e?.message || '列出字体失败' }); }
});

app.post('/api/admin/instances/:id/fonts', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  const name = String((req.query as any)?.name || '').trim();
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: '空文件' });
  try {
    await uploadFont(inst, name, body);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '上传失败' }); }
});

app.delete('/api/admin/instances/:id/fonts/:name', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await deleteFont(inst, (req.params as any).name);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '删除失败' }); }
});

app.get('/api/admin/instances/:id/fonts/current', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try { return { fontFile: await getAppliedFont(inst) }; }
  catch (e: any) { return reply.code(500).send({ error: e?.message || '获取当前字体失败' }); }
});

app.post('/api/admin/instances/:id/fonts/:name/apply', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await applyFont(inst, (req.params as any).name);
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '应用字体失败' }); }
});

app.post('/api/admin/instances/:id/fonts/default', async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const inst = bgHandler((req.params as any).id, reply);
  if (!inst) return;
  try {
    await applyFont(inst, 'default');
    return { ok: true };
  } catch (e: any) { return reply.code(400).send({ error: e?.message || '重置字体失败' }); }
});

// ---------- 反向代理到内网 KasmVNC（按实例注入 Basic auth，会话 + 权限把守） ----------
// 单个 proxy 实例，target 与凭据逐请求指定：凭据暂存在 req 上，proxyReq 时注入。
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
// 控制权心跳只代表最近有键鼠操作，不能代表桌面是否仍在观看。Chrome 标签页进入后台后
// 不再产生键鼠事件，但 VNC WebSocket 通常仍保持连接；soft watchdog 应把它视为活跃会话。
const activeVncSockets = new Map<string, Set<Socket>>();

function trackActiveVncSocket(instId: string, socket: Socket) {
  let sockets = activeVncSockets.get(instId);
  if (!sockets) {
    sockets = new Set<Socket>();
    activeVncSockets.set(instId, sockets);
  }
  if (sockets.has(socket)) return;
  sockets.add(socket);
  socket.once('close', () => {
    const current = activeVncSockets.get(instId);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) activeVncSockets.delete(instId);
  });
}

function activeVncViewerCount(instId: string): number {
  return activeVncSockets.get(instId)?.size ?? 0;
}

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
  if (instId) {
    proxyReq.on('upgrade', () => {
      trackActiveVncSocket(instId, req.socket as Socket);
      appendInstanceLog(instId, '[vnc] 上游已接受(101) · 桌面连接建立');
    });
  }
});
// 上游（面板→实例）套接字 TCP keepalive：客户端断网/切网（WiFi→4G、NAS 休眠）时 TCP 不会主动通知，
// 半开死连接可挂数小时——对 KasmVNC 表现为"幽灵会话"占坑，与新连接并存是历史上 Xvnc 卡死的诱因之一。
// 30s 探测让死连接分钟级被回收，而不是小时级。
proxy.on('open', (proxySocket) => {
  try {
    proxySocket.setKeepAlive(true, 30_000);
  } catch {
    /* ignore */
  }
});
// 兜底：剥掉 KasmVNC 401 的 WWW-Authenticate 头，避免浏览器弹出原生 Basic Auth 登录框。
// 正常路径下我们已注入正确凭据（不会 401）；万一凭据失配，宁可桌面加载失败也绝不把登录弹窗暴露给用户。
proxy.on('proxyRes', (proxyRes) => {
  delete proxyRes.headers['www-authenticate'];
});
// 上游（实例 Web）暂时连不上时，给浏览器导航请求回一个「自动重连」的友好页面，而不是死的纯文本。
// 实例在 创建初始化 / 升级 / 重启 / 内存自愈软重启，以及面板自更新（代理短暂中断）时都会短暂 502，
// 几秒后即恢复；旧版回纯文本"桌面服务暂时不可用"且 iframe 一旦载入它就判 frameLoaded=true、不再重试，
// 用户就卡在黑屏死页（用户反馈的"新版黑屏 桌面服务暂不可用"）。此页每 3s 自动重载，实例一就绪即自动连上；
// 连续约 30s 仍不行才转手动重试，并按 20s 间隔重置计数（区分新一轮故障）。
const UPSTREAM_DOWN_HTML =
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>桌面连接中…</title><style>` +
  `html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#14161c;` +
  `color:#e7eaef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}.box{text-align:center;` +
  `max-width:340px;padding:24px}.sp{width:34px;height:34px;border:3px solid rgba(255,255,255,.16);border-top-color:#07C160;` +
  `border-radius:50%;margin:0 auto 16px;animation:r 1s linear infinite}@keyframes r{to{transform:rotate(360deg)}}` +
  `.t{font-size:15px;font-weight:600}.s{font-size:13px;color:#969ca6;margin-top:8px;line-height:1.6}.b{margin-top:18px;` +
  `display:none}button{background:#07C160;color:#fff;border:0;border-radius:999px;padding:9px 22px;font-size:14px;cursor:pointer}` +
  `</style></head><body><div class="box"><div class="sp" id="sp"></div><div class="t" id="t">桌面正在启动 / 重连中…</div>` +
  `<div class="s" id="s">实例重启或初始化时会短暂不可用，将自动重连，请稍候。</div>` +
  `<div class="b" id="b"><button onclick="location.reload()">重试</button></div></div><script>(function(){` +
  `function rl(){location.reload()}try{var K='woc_up_retry',now=Date.now(),o={};try{o=JSON.parse(sessionStorage.getItem(K)||'{}')}catch(e){}` +
  `var n=(now-(o.t||0)>20000)?1:((o.n||0)+1);sessionStorage.setItem(K,JSON.stringify({n:n,t:now}));` +
  `if(n<=10){setTimeout(rl,3000)}else{document.getElementById('sp').style.display='none';document.getElementById('b').style.display='block';` +
  `document.getElementById('t').textContent='桌面长时间未就绪';document.getElementById('s').textContent='实例可能在重启或未运行。可继续重试，或用左上角菜单返回主页让管理员检查。'}` +
  `}catch(e){setTimeout(rl,3000)}})();</script></body></html>`;
proxy.on('error', (_err, req, res) => {
  try {
    const r = res as any;
    if (r && typeof r.writeHead === 'function') {
      // 仅对浏览器导航（接受 text/html）回友好自动重连页；JS/CSS/XHR 等子资源回纯文本，避免把 HTML 喂给非页面请求。
      const accept = String((req as any)?.headers?.accept || '');
      if (accept.includes('text/html')) {
        r.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        r.end(UPSTREAM_DOWN_HTML);
      } else {
        r.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        r.end('桌面服务暂时不可用');
      }
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
  // 客户端侧 TCP keepalive（与上游侧成对，见 proxy.on('open')）：及时回收断网客户端留下的半开死连接
  try {
    socket.setKeepAlive(true, 30_000);
  } catch {
    /* ignore */
  }
  const t0 = Date.now();
  socket.on('close', () => appendInstanceLog(inst.id, `[vnc] 连接关闭（持续 ${Math.round((Date.now() - t0) / 1000)}s）`));
  proxy.ws(req, socket, head, { target: instanceTarget(inst) }, (err: any) => {
    appendInstanceLog(inst.id, `[vnc] 连接失败：${err?.message || err}`);
  });
});

// 版本兜底：若面板偏好的「同版本实例镜像 tag」不可达则回退 :latest（见 docker.ts）。
// 须在实例检测/升级/启动之前解析好，否则升级指示器会因指向不存在的 tag 而恒空。
await resolveInstanceImage().catch(() => {});
// 探测面板网络 + 重启后把已登记实例的容器拉起来
await ensureNetwork().catch(() => {});
for (const pub of listInstances()) {
  try {
    await ensureRunning(findInstance(pub.id)!);
  } catch (e: any) {
    app.log.warn(`[instance] 启动实例 ${pub.id} 失败: ${e?.message || e}`);
  }
}

// 启动时清一次旧版本 woc 镜像：面板自更新会留下旧的 woc-panel 镜像（helper 用新镜像重建面板后，
// 旧镜像不再被任何容器引用，但带 tag 不是 dangling，清不掉）——在这里回收，也作为周期性兜底。
// 延迟 30s 执行，避开启动高峰（拉实例镜像 / 起容器）。
setTimeout(() => void pruneOldWocImages(), 30_000).unref();

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

// “当前有人在远程会话”同时看两类信号：VNC WebSocket 表示仍在观看，控制权心跳表示最近
// 有键鼠操作。Chrome 后台标签页会停止交互心跳，但只要桌面连接仍在，就不能做 soft 重启。
function hasActiveSession(id: string): boolean {
  if (activeVncViewerCount(id) > 0) return true;
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
      await runInstance(inst, { keepImage: true }); // 自愈幂等：沿用当前镜像，绝不因本地 :latest 变了就隐式升级
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
          const viewers = activeVncViewerCount(inst.id);
          if (hard > 0 && mb >= hard) {
            await recover(inst, 'hard', `mem=${mb}MiB ≥ hard=${hard}MiB，强制重启（active=${active}, viewers=${viewers}）`);
            continue;
          }
          if (soft > 0 && mb >= soft && !active) {
            await recover(inst, 'soft', `mem=${mb}MiB ≥ soft=${soft}MiB 且无活跃会话，柔和重启`);
            continue;
          }
          if (soft > 0 && mb >= soft && active) {
            app.log.info(`[watchdog] ${inst.containerName} mem=${mb}MiB ≥ soft=${soft}MiB 但用户在使用，延后（viewers=${viewers}）`);
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
