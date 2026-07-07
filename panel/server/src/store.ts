import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

export type Role = 'admin' | 'sub';

export interface User {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
  // 该账户可访问的微信实例 id 列表。admin 隐式全部，忽略此字段。
  allowedInstances: string[];
  // 仍在使用初始默认密码时为 true，前端据此提示尽快改密；任意一次改密/重置后清除。
  mustChangePassword?: boolean;
  // 离线密码找回：在 accounts.json 手动把某用户置为 true，重启面板即重置其密码并清除此标记。
  // 兼容下划线写法 reset_password。
  resetPassword?: boolean;
  reset_password?: boolean;
}

// 初始默认管理员密码；管理员仍在用它时强烈提示改密。
const DEFAULT_ADMIN_PASSWORD = 'wechat';

// v1.2.0：实例可承载多种应用（不止微信）。同一镜像运行时按 appType 安装/启动对应应用。
export type AppType = 'wechat' | 'telegram' | 'chromium' | 'custom';
export const APP_TYPES: AppType[] = ['wechat', 'telegram', 'chromium', 'custom'];
export const APP_LABELS: Record<AppType, string> = {
  wechat: '微信',
  telegram: 'Telegram',
  chromium: '浏览器',
  custom: '自定义应用',
};
// 向后兼容：v1.2.0 之前创建的实例没有 appType 字段，一律视为微信。
export function instanceAppType(i: Instance): AppType {
  return i.appType && APP_TYPES.includes(i.appType) ? i.appType : 'wechat';
}

export interface Instance {
  id: string; // 短 id，用于容器/卷命名
  name: string; // 显示名
  appType?: AppType; // 承载的应用类型；缺省（老实例）= wechat（见 instanceAppType）
  icon?: string; // 自定义图标：data: 图片(base64) 或 builtin:<key>；缺省按 appType 取默认图标
  containerName: string; // woc-wx-<id>
  volumeName: string; // woc-data-<id>
  kasmUser: string; // 随机生成，服务端注入反代，永不下发前端
  kasmPassword: string;
  createdAt: string;
  createdBy: string; // userId
  // 自定义应用（appType=custom）：用户上传的安装包信息，autostart 据此启动。
  customLaunch?: string; // 启动命令（容器内绝对路径或命令）
  // 自愈 watchdog 的"安全阀"，per-instance 覆盖全局默认；缺省时使用 env / 内置默认。
  // soft：内存超此值时，仅在"当前没有用户在远程会话"才主动重启（柔和自愈）；
  // hard：内存超此值时，无论是否有人在会话都重启（防止 OOM 拖垮宿主）。
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}

// 面板级全局设置（持久化进 accounts.json）。
export interface Settings {
  // 实例桌面深色模式：由面板顶栏的主题开关统一控制（管理员）。true=实例内应用走深色。
  // 既作为新建/重启实例的初始明暗（经容器环境 WOC_DARK 下发），也用于对运行中实例实时切换。
  desktopDark?: boolean;
}

interface Data {
  users: User[];
  instances: Instance[];
  settings?: Settings;
}

const FILE = process.env.PANEL_DATA || '/data/panel/accounts.json';

let data: Data = { users: [], instances: [] };

function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, FILE);
}

function makeUser(username: string, password: string, role: Role): User {
  return {
    id: randomUUID(),
    username,
    role,
    passwordHash: bcrypt.hashSync(password, 10),
    disabled: false,
    createdAt: new Date().toISOString(),
    allowedInstances: [],
  };
}

export function initStore() {
  if (existsSync(FILE)) {
    data = JSON.parse(readFileSync(FILE, 'utf8'));
  } else {
    data = { users: [], instances: [] };
  }
  // 迁移：补齐新增字段，兼容旧账号文件
  if (!Array.isArray(data.instances)) data.instances = [];
  for (const u of data.users) {
    if (!Array.isArray(u.allowedInstances)) u.allowedInstances = [];
  }
  if (!data.users.some((u) => u.role === 'admin')) {
    const username = process.env.PANEL_ADMIN_USER || 'admin';
    const password = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const admin = makeUser(username, password, 'admin');
    // 用默认密码初始化时标记，提醒尽快改密
    if (password === DEFAULT_ADMIN_PASSWORD) admin.mustChangePassword = true;
    data.users.push(admin);
    console.log(`[store] 已初始化管理员账号 '${username}'`);
  } else {
    // 兼容旧账号文件：管理员若仍能用默认密码登录，补打"需改密"标记
    for (const u of data.users) {
      if (u.role === 'admin' && u.mustChangePassword === undefined) {
        u.mustChangePassword = bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, u.passwordHash);
      }
    }
  }
  // 离线密码找回：忘记超管密码时，停掉面板 → 在 accounts.json 给该用户加 "resetPassword": true
  // → 重启面板。这里把其密码重置为 PANEL_ADMIN_PASSWORD（默认 wechat）、解禁，并清除标记。
  for (const u of data.users) {
    if ((u as any).resetPassword === true || (u as any).reset_password === true) {
      const pw = process.env.PANEL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
      u.passwordHash = bcrypt.hashSync(pw, 10);
      u.mustChangePassword = pw === DEFAULT_ADMIN_PASSWORD; // 重置成默认密码则提示尽快改密
      u.disabled = false;
      delete (u as any).resetPassword;
      delete (u as any).reset_password;
      console.log(`[store] 已重置用户 '${u.username}' 的密码（resetPassword 标记，密码=PANEL_ADMIN_PASSWORD 或默认 wechat）`);
    }
  }
  persist();
}

// ---------- 全局设置 ----------
export function getSettings(): Settings {
  return data.settings || (data.settings = {});
}

export function getDesktopDark(): boolean {
  return !!getSettings().desktopDark;
}

export function setDesktopDark(v: boolean) {
  getSettings().desktopDark = !!v;
  persist();
}

// ---------- 用户 ----------
export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.createdAt,
    allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
    mustChangePassword: !!u.mustChangePassword,
  };
}

export function findByUsername(username: string) {
  return data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function findById(id: string) {
  return data.users.find((u) => u.id === id);
}

export function listUsers() {
  return data.users
    .slice()
    .sort((a, b) => (a.role === b.role ? a.createdAt.localeCompare(b.createdAt) : a.role === 'admin' ? -1 : 1))
    .map(publicUser);
}

export function verifyPassword(u: User, password: string) {
  return bcrypt.compareSync(password, u.passwordHash);
}

export function createSub(username: string, password: string, allowedInstances: string[] = []) {
  if (findByUsername(username)) throw new Error('用户名已存在');
  const u = makeUser(username, password, 'sub');
  u.allowedInstances = sanitizeInstanceIds(allowedInstances);
  data.users.push(u);
  persist();
  return publicUser(u);
}

export function setDisabled(id: string, disabled: boolean) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role === 'admin') throw new Error('不能禁用管理员');
  u.disabled = disabled;
  persist();
  return publicUser(u);
}

export function resetPassword(id: string, password: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  u.passwordHash = bcrypt.hashSync(password, 10);
  u.mustChangePassword = false; // 改过密就不再提示
  persist();
  return publicUser(u);
}

export function deleteUser(id: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role === 'admin') throw new Error('不能删除管理员');
  data.users = data.users.filter((x) => x.id !== id);
  persist();
}

// 改用户名（登录名）。格式校验在路由层；这里只查重并写入。会话以 userId 为准，改名后无需重新登录。
export function renameUser(id: string, newUsername: string) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  const name = String(newUsername || '').trim();
  const existing = findByUsername(name);
  if (existing && existing.id !== id) throw new Error('用户名已存在');
  u.username = name;
  persist();
  return publicUser(u);
}

// 设置某账户可访问的实例（账户侧编辑）
export function setUserInstances(id: string, instanceIds: string[]) {
  const u = findById(id);
  if (!u) throw new Error('用户不存在');
  if (u.role !== 'admin') u.allowedInstances = sanitizeInstanceIds(instanceIds);
  persist();
  return publicUser(u);
}

// ---------- 实例 ----------
function sanitizeInstanceIds(ids: string[]): string[] {
  const valid = new Set(data.instances.map((i) => i.id));
  return [...new Set((ids || []).filter((x) => valid.has(x)))];
}

export function publicInstance(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    appType: instanceAppType(i), // 老实例无字段时回退 wechat
    icon: i.icon,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    memSoftLimitMB: i.memSoftLimitMB,
    memHardLimitMB: i.memHardLimitMB,
  };
}

// 设置/清除某实例的 mem 安全阀。传 null 表示恢复默认（从对象上删字段）。
// 校验：正整数；soft < hard；上限 20480 MiB（20 GiB）。
export function setInstanceMemLimits(
  id: string,
  softMB: number | null,
  hardMB: number | null,
) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const norm = (v: number | null): number | undefined => {
    if (v == null) return undefined;
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > 20480) {
      throw new Error('阈值需为 1-20480 之间的整数（MiB）');
    }
    return v;
  };
  const s = norm(softMB);
  const h = norm(hardMB);
  if (s != null && h != null && s >= h) throw new Error('soft 阈值需小于 hard 阈值');
  inst.memSoftLimitMB = s;
  inst.memHardLimitMB = h;
  persist();
  return publicInstance(inst);
}

export function listInstances() {
  return data.instances.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findInstance(id: string) {
  return data.instances.find((i) => i.id === id);
}

// 当前用户可见的实例（admin 全部，sub 按 allowedInstances）
export function userInstances(u: User) {
  if (u.role === 'admin') return listInstances();
  const allowed = new Set(u.allowedInstances);
  return listInstances().filter((i) => allowed.has(i.id));
}

export function userCanAccess(u: User, instanceId: string) {
  if (u.role === 'admin') return !!findInstance(instanceId);
  return u.allowedInstances.includes(instanceId) && !!findInstance(instanceId);
}

// 复用旧卷时：从 woc-data-<id> 解析回 id，让新实例的 containerName / volumeName 都对齐旧卷的
// id（避免出现"卷叫 woc-data-abc，但实例 id 是 def"这种命名错配）。若旧 id 与现存实例冲突或卷名
// 非标准前缀，则退回新生成 id，仅卷名指向旧卷。
function parseIdFromVolume(volumeName: string): string | null {
  const m = /^woc-data-([0-9a-f]{10})$/.exec(volumeName);
  return m ? m[1] : null;
}

export function createInstance(
  name: string,
  createdBy: string,
  allowedUserIds: string[] = [],
  reuseVolumeName?: string,
  appType: AppType = 'wechat',
) {
  const type: AppType = APP_TYPES.includes(appType) ? appType : 'wechat';
  let id = randomBytes(5).toString('hex'); // 10 hex chars
  let volumeName = `woc-data-${id}`;
  if (reuseVolumeName) {
    const reusedId = parseIdFromVolume(reuseVolumeName);
    if (reusedId && !findInstance(reusedId)) {
      id = reusedId;
    }
    volumeName = reuseVolumeName; // 始终指向旧卷（即便 id 是新生成的）
  }
  const inst: Instance = {
    id,
    name: name.trim() || `${APP_LABELS[type]}-${id.slice(0, 4)}`,
    appType: type,
    containerName: `woc-wx-${id}`,
    volumeName,
    kasmUser: 'woc',
    // 用 hex（仅 0-9a-f）：容器内 init 脚本以 `openssl passwd -apr1 ${PASSWORD}` 未加引号方式生成 .htpasswd，
    // base64url 可能含前导 '-' 而被 openssl 当作命令行选项，导致密码哈希为空、所有鉴权失败。hex 不含任何 shell 特殊字符。
    kasmPassword: randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    createdBy,
  };
  data.instances.push(inst);
  // 把访问权限写到选中的账户上
  for (const uid of allowedUserIds || []) {
    const u = findById(uid);
    if (u && u.role !== 'admin' && !u.allowedInstances.includes(id)) {
      u.allowedInstances.push(id);
    }
  }
  persist();
  return inst;
}

export function renameInstance(id: string, name: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const n = (name || '').trim();
  if (!n || n.length > 30) throw new Error('实例名称为 1-30 个字符');
  inst.name = n;
  persist();
  return publicInstance(inst);
}

// 设置/清除实例自定义图标。传空 → 恢复按 appType 的默认图标。
// 仅允许 builtin:<key> 或 data:image/...（裁剪后约 128px，限 ~225KB，防滥用撑大 accounts.json）。
export function setInstanceIcon(id: string, icon: string | null) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const v = (icon ?? '').trim();
  if (!v) {
    delete inst.icon;
  } else if (/^builtin:[a-z0-9_-]{1,32}$/.test(v) || (v.startsWith('data:image/') && v.length <= 300000)) {
    inst.icon = v;
  } else {
    throw new Error('图标格式不合法或过大');
  }
  persist();
  return publicInstance(inst);
}

export function removeInstance(id: string) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  data.instances = data.instances.filter((i) => i.id !== id);
  // 从所有账户的可访问列表里移除
  for (const u of data.users) {
    u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 设置某实例可被哪些账户访问（实例侧编辑）
export function setInstanceUsers(id: string, userIds: string[]) {
  const inst = findInstance(id);
  if (!inst) throw new Error('实例不存在');
  const allow = new Set(userIds || []);
  for (const u of data.users) {
    if (u.role === 'admin') continue;
    const has = u.allowedInstances.includes(id);
    if (allow.has(u.id) && !has) u.allowedInstances.push(id);
    if (!allow.has(u.id) && has) u.allowedInstances = u.allowedInstances.filter((x) => x !== id);
  }
  persist();
  return inst;
}

// 已登记一个实例（迁移用：复用旧 ./data 卷）。返回是否新建。
export function registerExistingInstance(opts: {
  name: string;
  containerName: string;
  volumeName: string;
  kasmUser: string;
  kasmPassword: string;
  createdBy: string;
}) {
  const id = randomBytes(5).toString('hex');
  const inst: Instance = { id, createdAt: new Date().toISOString(), ...opts };
  data.instances.push(inst);
  persist();
  return inst;
}
