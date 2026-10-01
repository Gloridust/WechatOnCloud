export interface PanelUser {
  id: string;
  username: string;
  role: 'admin' | 'sub';
  disabled: boolean;
  createdAt: string;
  allowedInstances: string[]; // admin 为空数组（隐式全部）
  mustChangePassword?: boolean; // 仍在用默认密码时为 true
}

export type WechatPhase = 'idle' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';
export interface WechatStatus {
  phase: WechatPhase;
  percent: number; // -1 表示进度不确定
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export type RuntimeState = 'running' | 'stopped' | 'missing';
export type AppType = 'wechat' | 'telegram' | 'chromium' | 'qq' | 'custom';
export const APP_LABELS: Record<AppType, string> = {
  wechat: '微信',
  telegram: 'Telegram',
  chromium: 'Chromium',
  qq: 'QQ',
  custom: '自定义应用',
};

// 各应用的 UI 画像，供卡片/桌面页按类型显示正确文案（避免到处写死「微信」）。
//   needsInstall: 是否需要运行时下载安装（微信/Telegram 是；Chromium 已烤进镜像、即创建即就绪）。
//   enterHint:    首次进入实例的提示。
//   updateLabel:  「管理」菜单里的更新按钮文案（needsInstall=false 时不显示）。
//   packageUpload: 「管理」菜单里有「上传安装包」（QQ：腾讯拒绝下载时传自己下载的 .deb，#153）。
export interface AppProfile {
  label: string;
  needsInstall: boolean;
  enterHint: string;
  updateLabel: string;
  packageUpload?: boolean;
}
export const APP_PROFILES: Record<AppType, AppProfile> = {
  wechat: { label: '微信', needsInstall: true, enterHint: '首次进入请扫码登录微信', updateLabel: '更新微信' },
  telegram: { label: 'Telegram', needsInstall: true, enterHint: '首次进入请登录 Telegram', updateLabel: '更新 Telegram' },
  chromium: { label: 'Chromium', needsInstall: false, enterHint: '浏览器已就绪，直接使用即可', updateLabel: '' },
  qq: { label: 'QQ', needsInstall: true, enterHint: '首次进入请用手机 QQ 扫码登录', updateLabel: '更新 QQ', packageUpload: true },
  custom: { label: '自定义应用', needsInstall: true, enterHint: '', updateLabel: '更新' },
};
export const appProfile = (t?: AppType): AppProfile => APP_PROFILES[t ?? 'wechat'] ?? APP_PROFILES.wechat;
export interface PanelInstance {
  id: string;
  name: string;
  appType?: AppType; // 缺省（老实例）= wechat
  icon?: string; // 自定义图标：data: 图片 / builtin:<key>；缺省按 appType 取默认图标
  createdAt: string;
  createdBy: string;
  memSoftLimitMB?: number;
  memHardLimitMB?: number;
}
export interface MemLimits {
  soft: number | null;
  hard: number | null;
  defaultSoft: number;
  defaultHard: number;
  currentMB: number;
  watchdogEnabled: boolean;
  intervalSec: number;
}
export interface InstanceWithStatus extends PanelInstance {
  runtime: RuntimeState;
  wechat: WechatStatus;
  imageVersion?: string | null; // 实例镜像版本（CI 发布版如 "1.4.0"；自构建为镜像短 id；容器缺失为 null）
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

export interface VersionInfo {
  current: string; // 当前构建版本（如 v1.2.0 / dev-<sha>）
  latest: string | null; // 仓库上最新发布版（如 v1.2.1）；查不到为 null
  hasUpdate: boolean; // 有可升级目标（正式版：latest>current；开发版：查到任一正式版）
  isDev: boolean; // 当前是开发版（非正式 vX.Y.Z）
  checkedAt: number; // 上次检查时间戳（ms）；0=尚未检查
  source: string | null; // 数据来源：dockerhub / ghcr / dockerhub+ghcr
  error: string | null; // 检查失败原因
}

// 反代身份网关（Cloudflare Access / Authelia 等）会话过期时，会把 API 请求 302 到它的跨域登录页；
// 默认的 fetch 会跟随这个跨域跳转、被浏览器按 CORS 拦下，前端只看到 "Failed to fetch"，页面卡死
// （PR #108 反馈的场景）。面板自己的 /api 从不返回重定向，所以用 redirect:'manual'：只要拿到
// opaqueredirect，就一定是网关拦了，整页重载交给网关重新认证后再回来。
// 刻意不把「网络失败」当成会话过期（PR #108 原方案）：面板重启 / 自更新期间 API 本就短暂不通，
// 那时整页跳转会停在浏览器的「无法访问」错误页，再也不会自动恢复。
const REAUTH_KEY = 'woc_gateway_reauth_ts';
// 重载前先注销 PWA 的 Service Worker：它会拦截页面导航、直接从缓存返回页面，请求根本到不了网关，
// 网关就没机会重新认证（实测：重载后仍被 302，最后落到 /login）。只在这一刻注销，下次正常加载时
// SW 会自动重新注册，已安装为应用（Chrome 应用 / 添加到主屏幕）的用户不受影响（PR #109 是直接删掉 PWA）。
function reloadThroughGateway() {
  const go = () => window.location.reload();
  if (!('serviceWorker' in navigator)) return go();
  navigator.serviceWorker
    .getRegistrations()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .catch(() => {})
    .finally(go);
}
async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { ...init, redirect: 'manual' });
  if (res.type === 'opaqueredirect') {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(REAUTH_KEY) || 0);
      if (Date.now() - last > 10_000) sessionStorage.setItem(REAUTH_KEY, String(Date.now()));
    } catch {
      /* 隐私模式：不做节流，照常重载 */
    }
    // 10s 内只重载一次：网关若配置异常一直 302，也不会陷入无限刷新
    if (Date.now() - last > 10_000) reloadThroughGateway();
    throw new Error('访问会话已失效，正在重新验证…');
  }
  return res;
}

// ---------- 大文件上传 ----------
// 与服务端 index.ts 的 UPLOAD_LIMIT_* 一致。前端先比一下：超限时服务端会直接回 413 并断开连接，
// 浏览器此时往往只报「网络错误」，看不到原因。
const GB = 1024 ** 3;
export const UPLOAD_LIMITS = { transfer: 4 * GB, volumeFile: 20 * GB, archive: 100 * GB, package: 2 * GB };
export function assertUploadSize(file: Blob, limit: number) {
  if (file.size > limit) throw new Error(`文件太大（${fmtUploadSize(file.size)}，上限 ${fmtUploadSize(limit)}）`);
}
export function fmtUploadSize(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
export type UploadProgress = (loaded: number, total: number) => void;

function uploadHttpError(status: number): string {
  if (status === 413) return '文件太大：超过了上传上限，或反向代理限制了上传大小（nginx 需调大 client_max_body_size）';
  if (status === 502 || status === 504) return `上传失败（HTTP ${status}）：反向代理超时，或面板正在重启`;
  return `上传失败（HTTP ${status}）`;
}

// 原始二进制上传（File 直传 application/octet-stream），带上传进度（fetch 拿不到上传进度，这里用 XHR）
async function rawUpload(url: string, file: Blob, onProgress?: UploadProgress): Promise<any> {
  // 先发个普通请求探路：登录已失效、或反代身份网关要重新认证（apiFetch 会整页重载去认证）时，在这里就拦下，
  // 不至于几个 GB 传完才发现被挡在门外
  const probe = await apiFetch('/api/auth/me', { credentials: 'same-origin' });
  if (probe.status === 401) {
    location.assign('/login');
    throw new Error('登录已失效，请重新登录');
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch {
        /* 反代的错误页不是 JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        // 2xx 却不是面板的回应（被网关换成了登录页之类）：不能当成功
        if (data && data.ok) resolve(data);
        else reject(new Error('上传结果未知（收到的不是面板的响应），请刷新页面后检查'));
        return;
      }
      reject(new Error(data?.error || uploadHttpError(xhr.status)));
    };
    xhr.onerror = () => reject(new Error('上传失败：连接中断（网络断开，或反向代理限制了上传大小 / 时长）'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
}

// 解压 / 整卷恢复在服务端是后台任务：上传完拿到任务号，轮询到结束
async function waitVolumeJob(id: string, job: string, onStage?: (stage: string) => void): Promise<void> {
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    let st: { state: 'running' | 'done' | 'error'; stage: string; error: string | null };
    try {
      st = await req(`/api/admin/instances/${id}/volume/jobs/${job}`);
      misses = 0;
    } catch (e: any) {
      const msg = e?.message || '';
      if (/任务不存在/.test(msg)) throw new Error('任务状态丢失（面板可能重启过），请检查数据后决定是否重试');
      if (++misses > 60) throw new Error(`查询进度失败：${msg}`); // 网络抖动 / 面板重启中：多等一会儿
      continue;
    }
    onStage?.(st.stage);
    if (st.state === 'done') return;
    if (st.state === 'error') throw new Error(st.error || '操作失败');
  }
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  // 仅在有 body 时声明 JSON content-type：否则 Fastify 对「空 body + application/json」会报 400
  const headers = opts.body ? { 'content-type': 'application/json', ...opts.headers } : opts.headers;
  const res = await apiFetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 会话过期：除登录/探测接口外，任意接口收到 401 都说明 cookie 失效，直接回登录页（避免页面卡在错误态）
    const isAuthProbe = path.includes('/api/auth/login') || path.includes('/api/auth/me');
    if (res.status === 401 && !isAuthProbe && location.pathname !== '/login') {
      location.assign('/login');
    }
    throw new Error((data as any).error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => req<{ user: PanelUser }>('/api/auth/me'),
  login: (username: string, password: string) =>
    req<{ user: PanelUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  changePassword: (oldPassword: string, newPassword: string) =>
    req('/api/account/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) }),

  // 版本与更新检测
  getVersion: () => req<VersionInfo>('/api/version'),
  checkUpdate: () => req<VersionInfo>('/api/admin/version/check', { method: 'POST' }),
  // 一键更新面板自身：拉新镜像 + 派生 helper 容器重建 woc-panel（带回滚）。返回后面板会重启。
  selfUpdatePanel: () => req<{ ok: boolean; target: string; message: string }>('/api/admin/version/self-update', { method: 'POST' }),

  // 实例桌面深色（与面板主题统一的那个开关）：读取当前态 + 设置（管理员，实时切换运行中实例）。
  getDesktopTheme: () => req<{ dark: boolean }>('/api/desktop-theme'),
  setDesktopTheme: (dark: boolean) =>
    req<{ ok: boolean; dark: boolean; applied: number; failed: number }>('/api/admin/desktop-theme', {
      method: 'POST',
      body: JSON.stringify({ dark }),
    }),

  // 子账号
  listUsers: () => req<{ users: PanelUser[] }>('/api/admin/users'),
  createUser: (username: string, password: string, allowedInstances: string[] = []) =>
    req<{ user: PanelUser }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, allowedInstances }),
    }),
  setDisabled: (id: string, disabled: boolean) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/disable`, { method: 'POST', body: JSON.stringify({ disabled }) }),
  resetUser: (id: string, newPassword: string) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/reset`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
  renameUser: (id: string, username: string) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/rename`, { method: 'POST', body: JSON.stringify({ username }) }),
  deleteUser: (id: string) => req(`/api/admin/users/${id}`, { method: 'DELETE' }),
  setUserInstances: (id: string, instanceIds: string[]) =>
    req<{ user: PanelUser }>(`/api/admin/users/${id}/instances`, { method: 'POST', body: JSON.stringify({ instanceIds }) }),

  // 微信实例
  listInstances: () => req<{ instances: InstanceWithStatus[] }>('/api/instances'),
  createInstance: (name: string, allowedUserIds: string[] = [], reuseVolume?: string, appType: AppType = 'wechat') =>
    req<{ instance: PanelInstance }>('/api/admin/instances', {
      method: 'POST',
      body: JSON.stringify({ name, allowedUserIds, reuseVolume: reuseVolume || undefined, appType }),
    }),
  regenMachineId: (id: string) =>
    req(`/api/admin/instances/${id}/regen-machine-id`, { method: 'POST' }),
  getInstanceMemLimits: (id: string) =>
    req<MemLimits>(`/api/admin/instances/${id}/mem-limits`),
  setInstanceMemLimits: (id: string, soft: number | null | undefined, hard: number | null | undefined) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/mem-limits`, {
      method: 'PUT',
      body: JSON.stringify({ soft, hard }),
    }),
  listOrphanVolumes: () =>
    req<{ volumes: { name: string; createdAt?: string; sizeBytes?: number }[] }>('/api/admin/orphan-volumes'),
  deleteOrphanVolume: (name: string) =>
    req(`/api/admin/orphan-volumes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listOrphanContainers: () =>
    req<{ containers: { id: string; name: string; status: string; volumeName?: string }[] }>('/api/admin/orphan-containers'),
  deleteOrphanContainer: (idOrName: string) =>
    req(`/api/admin/orphan-containers/${encodeURIComponent(idOrName)}`, { method: 'DELETE' }),
  setInstanceIcon: (id: string, icon: string | null) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/icon`, { method: 'POST', body: JSON.stringify({ icon }) }),
  renameInstance: (id: string, name: string) =>
    req<{ instance: PanelInstance }>(`/api/admin/instances/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteInstance: (id: string, purge = false) =>
    req(`/api/admin/instances/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' }),
  setInstanceUsers: (id: string, userIds: string[]) =>
    req(`/api/admin/instances/${id}/users`, { method: 'POST', body: JSON.stringify({ userIds }) }),
  instanceWechatStatus: (id: string) => req<{ status: WechatStatus }>(`/api/instances/${id}/wechat/status`),
  // 卡死自愈：VNC 多次重连仍连不上时，重启该实例恢复（限频；需对实例有访问权）。
  healInstance: (id: string) => req<{ ok: boolean; restarted: boolean }>(`/api/instances/${id}/heal`, { method: 'POST' }),
  // 客户端连接日志：把前端的 VNC 连接态/动作回传服务端，记进实例日志（[client] 前缀），便于排查。Fire-and-forget。
  clientLog: (id: string, msg: string) => {
    req(`/api/instances/${id}/clientlog`, { method: 'POST', body: JSON.stringify({ msg }) }).catch(() => {});
  },
  instanceWechatInstall: (id: string) => req(`/api/admin/instances/${id}/wechat/install`, { method: 'POST' }),
  instanceWechatUpdate: (id: string) => req(`/api/admin/instances/${id}/wechat/update`, { method: 'POST' }),
  // 上传自己下载的安装包并安装（QQ 的 .deb；传完服务端即触发安装，进度看实例的安装状态）
  uploadAppPackage: async (id: string, file: File, onProgress?: UploadProgress) => {
    assertUploadSize(file, UPLOAD_LIMITS.package);
    return rawUpload(`/api/admin/instances/${id}/app/package?name=${encodeURIComponent(file.name)}`, file, onProgress);
  },
  instanceStart: (id: string) => req(`/api/admin/instances/${id}/start`, { method: 'POST' }),
  instanceStop: (id: string) => req(`/api/admin/instances/${id}/stop`, { method: 'POST' }),
  instanceRestart: (id: string) => req(`/api/admin/instances/${id}/restart`, { method: 'POST' }),
  // 单实例升级：异步（后端登记后立即返回），轮询 upgradeStatus().upgradingIds 直到该 id 移出。
  instanceUpgrade: (id: string) => req<{ ok: boolean; started: boolean }>(`/api/admin/instances/${id}/upgrade`, { method: 'POST' }),
  // 实例镜像升级状态（哪些实例落后于本地最新镜像、远端是否有新版、单个/批量升级进度）。
  upgradeStatus: () =>
    req<{
      known: boolean;
      outdatedCount: number;
      outdatedIds: string[];
      instances: { id: string; name: string; outdated: boolean }[];
      remoteNewer: boolean | null;
      upgradeAll: { running: boolean; total: number; done: number; failed: number; phase: string };
      upgradingIds: string[];
    }>('/api/admin/instances/upgrade-status'),
  // 一键升级全部（异步，立即返回；先拉镜像再判定落后，进度看 upgradeStatus().upgradeAll）。
  upgradeAllInstances: () =>
    req<{ ok: boolean; started: boolean }>('/api/admin/instances/upgrade-all', { method: 'POST' }),
  instanceLogsUrl: (id: string) => `/api/admin/instances/${id}/logs`,
  // 全局日志 / 诊断包（范围 24h/7d/30d/1y）
  diagnosticsUrl: (range: string) => `/api/admin/diagnostics?range=${encodeURIComponent(range)}`,
  panelLogUrl: (range: string) => `/api/admin/panel-log?range=${encodeURIComponent(range)}`,

  // 文件中转
  listFiles: (id: string) => req<{ files: { name: string; size: number; mtime?: number }[] }>(`/api/instances/${id}/files`),
  uploadFile: async (id: string, file: File, onProgress?: UploadProgress) => {
    assertUploadSize(file, UPLOAD_LIMITS.transfer);
    return rawUpload(`/api/instances/${id}/upload?name=${encodeURIComponent(file.name)}`, file, onProgress);
  },
  // 本机剪贴板图片 → 容器 X 剪贴板 → Ctrl+V（issue #91）
  pasteImage: async (id: string, file: Blob) => {
    const res = await apiFetch(`/api/instances/${id}/paste-image?type=${encodeURIComponent(file.type)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '粘贴图片失败');
    return res.json();
  },
  downloadFileUrl: (id: string, name: string) => `/api/instances/${id}/download?name=${encodeURIComponent(name)}`,
  deleteFile: (id: string, name: string) => req(`/api/instances/${id}/files?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // 数据卷管理（仅管理员）
  volumeList: (id: string, path = '') =>
    req<{ path: string; entries: VolEntry[] }>(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`),
  volumeMkdir: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }),
  volumeMove: (id: string, from: string, to: string) =>
    req(`/api/admin/instances/${id}/volume/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  volumeDelete: (id: string, path: string) =>
    req(`/api/admin/instances/${id}/volume?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  volumeDownloadUrl: (id: string, path: string) =>
    `/api/admin/instances/${id}/volume/download?path=${encodeURIComponent(path)}`,
  volumeBackupUrl: (id: string) => `/api/admin/instances/${id}/volume/backup`,
  volumeUpload: async (id: string, path: string, file: File, onProgress?: UploadProgress) => {
    assertUploadSize(file, UPLOAD_LIMITS.volumeFile);
    return rawUpload(
      `/api/admin/instances/${id}/volume/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
      file,
      onProgress,
    );
  },
  // 上传（带进度）→ 服务端校验、写入（后台任务，onStage 报告阶段）
  volumeExtract: async (id: string, path: string, file: File, onProgress?: UploadProgress, onStage?: (s: string) => void) => {
    assertUploadSize(file, UPLOAD_LIMITS.archive);
    const { job } = await rawUpload(`/api/admin/instances/${id}/volume/extract?path=${encodeURIComponent(path)}`, file, onProgress);
    await waitVolumeJob(id, job, onStage);
  },
  volumeRestore: async (id: string, file: File, onProgress?: UploadProgress, onStage?: (s: string) => void) => {
    assertUploadSize(file, UPLOAD_LIMITS.archive);
    const { job } = await rawUpload(`/api/admin/instances/${id}/volume/restore`, file, onProgress);
    await waitVolumeJob(id, job, onStage);
  },

  // 多端协作：操作控制权
  controlStatus: (id: string) => req<{ free: boolean; mine: boolean; holder: string | null }>(`/api/instances/${id}/control`),
  controlBeat: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/beat`, { method: 'POST' }),
  controlTake: (id: string) => req<{ mine: boolean; holder: string }>(`/api/instances/${id}/control/take`, { method: 'POST' }),
  typeInInstance: (id: string, text: string) => req(`/api/instances/${id}/type`, { method: 'POST', body: JSON.stringify({ text }) }),
  // 本机剪贴板文字粘进应用（粘贴桥判断本机比容器新时用；贴完留在容器剪贴板）
  pasteText: (id: string, text: string) => req(`/api/instances/${id}/paste-text`, { method: 'POST', body: JSON.stringify({ text }) }),
  keyInInstance: (id: string, key: string) => req(`/api/instances/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) }),

  // 桌面壁纸
  listBackgrounds: (id: string) => req<{ backgrounds: string[] }>(`/api/admin/instances/${id}/backgrounds`),
  uploadBackground: async (id: string, name: string, file: File) => {
    const res = await apiFetch(`/api/admin/instances/${id}/backgrounds?name=${encodeURIComponent(name)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '上传失败');
    return res.json();
  },
  applyBackground: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/backgrounds/${encodeURIComponent(name)}/apply`, { method: 'POST' }),
  deleteBackground: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getCurrentBackground: (id: string) => req<{ background: string }>(`/api/admin/instances/${id}/backgrounds/current`),
  clearBackground: (id: string) => req(`/api/admin/instances/${id}/backgrounds/clear`, { method: 'POST' }),

  // 字体管理
  listFonts: (id: string) => req<{ fonts: string[] }>(`/api/admin/instances/${id}/fonts`),
  uploadFont: async (id: string, name: string, file: File) => {
    const res = await apiFetch(`/api/admin/instances/${id}/fonts?name=${encodeURIComponent(name)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error || '上传失败');
    return res.json();
  },
  deleteFont: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/fonts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  getCurrentFont: (id: string) => req<{ fontFile: string }>(`/api/admin/instances/${id}/fonts/current`),
  applyFont: (id: string, name: string) =>
    req(`/api/admin/instances/${id}/fonts/${encodeURIComponent(name)}/apply`, { method: 'POST' }),
  resetFontDefault: (id: string) =>
    req(`/api/admin/instances/${id}/fonts/default`, { method: 'POST' }),
};
