// 面板版本与更新检测。
// 构建时把版本号烤进镜像（Dockerfile: ARG/ENV WOC_VERSION，由 CI 用 git tag 注入，本地构建为 dev）；
// 运行时查询 Docker Hub 与 GHCR 上 woc-panel 的最新语义化标签，比对后给前端「有新版」红点。
// 全程 best-effort：离线 / 被墙 / 私有源拉取失败时不报错、不打扰，仅不显示红点（记 error 供「上次检查」提示）。

export const CURRENT_VERSION = (process.env.WOC_VERSION || 'dev').trim();

export interface VersionInfo {
  current: string; // 当前构建版本（如 v1.2.0 / dev-<sha>）
  latest: string | null; // 仓库上最新发布版（如 v1.2.1）；查不到为 null
  hasUpdate: boolean; // 有可升级目标时为 true（正式版：latest>current；开发版：查到任一正式版即可"升级到正式版"）
  isDev: boolean; // 当前不是正式语义化版本（如 dev-<sha> 本地/自构建版）
  checkedAt: number; // 上次检查时间戳（ms）；0 = 尚未检查
  source: string | null; // 数据来源：dockerhub / ghcr / dockerhub+ghcr
  error: string | null; // 检查失败原因（两个源都拉不到时）
}

// 镜像命名空间：从 WOC_WECHAT_IMAGE 推断（面板与实例镜像同账号）。
// 例 docker.io/gloridust/wechat-on-cloud:latest → gloridust；ghcr.io/gloridust/... 同理。
function imageOwner(): string {
  const img = (process.env.WOC_WECHAT_IMAGE || 'docker.io/gloridust/wechat-on-cloud').split('@')[0];
  const segs = img.split('/'); // [registry?, owner, image[:tag]]
  return segs.length >= 2 ? segs[segs.length - 2] : 'gloridust';
}
const PANEL_REPO = process.env.WOC_PANEL_REPO || 'woc-panel';

function parseSemver(s: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
// 从一堆标签里挑出最大的 x.y.z（忽略 latest / x / x.y 等非完整语义化标签）。
function maxSemver(tags: string[]): string | null {
  let best: [number, number, number] | null = null;
  for (const t of tags) {
    const v = parseSemver(t);
    if (v && (!best || cmpSemver(v, best) > 0)) best = v;
  }
  return best ? `${best[0]}.${best[1]}.${best[2]}` : null;
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'woc-panel-update-check', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Docker Hub 公共 API：免鉴权列标签。
async function dockerHubTags(owner: string): Promise<string[]> {
  const d = await getJson(`https://hub.docker.com/v2/repositories/${owner}/${PANEL_REPO}/tags?page_size=100`, {}, 8000);
  return Array.isArray(d?.results) ? d.results.map((r: any) => String(r?.name || '')) : [];
}
// GHCR 公共镜像：先取匿名 pull token，再走 registry v2 tags/list。
async function ghcrTags(owner: string): Promise<string[]> {
  const tok = await getJson(`https://ghcr.io/token?scope=repository:${owner}/${PANEL_REPO}:pull&service=ghcr.io`, {}, 8000);
  const d = await getJson(`https://ghcr.io/v2/${owner}/${PANEL_REPO}/tags/list`, { authorization: `Bearer ${tok?.token || ''}` }, 8000);
  return Array.isArray(d?.tags) ? d.tags.map((t: any) => String(t)) : [];
}

// 当前是否为"开发版"（非正式 vX.Y.Z，如本地/自构建的 dev-<sha>）。开发版允许一键"升级到正式版"。
const IS_DEV = !parseSemver(CURRENT_VERSION);

let cache: VersionInfo = { current: CURRENT_VERSION, latest: null, hasUpdate: false, isDev: IS_DEV, checkedAt: 0, source: null, error: null };
let inflight: Promise<VersionInfo> | null = null;

export function versionInfo(): VersionInfo {
  return cache;
}

// 查询两个仓库（并行、互不阻塞），取全局最大语义化版本与当前版本比对。失败静默写入 error。
export function checkForUpdate(): Promise<VersionInfo> {
  if (inflight) return inflight; // 合并并发请求，避免重复外呼
  inflight = (async () => {
    const owner = imageOwner();
    const sources: string[] = [];
    const tags: string[] = [];
    const [hub, ghcr] = await Promise.allSettled([dockerHubTags(owner), ghcrTags(owner)]);
    if (hub.status === 'fulfilled' && hub.value.length) {
      tags.push(...hub.value);
      sources.push('dockerhub');
    }
    if (ghcr.status === 'fulfilled' && ghcr.value.length) {
      tags.push(...ghcr.value);
      sources.push('ghcr');
    }
    const latestBare = maxSemver(tags);
    const cur = parseSemver(CURRENT_VERSION);
    const latestV = latestBare ? parseSemver(latestBare) : null;
    // 正式版：仅当 latest > current 才算有更新；开发版：查到任一正式版即可"升级到正式版"。
    const hasUpdate = IS_DEV ? !!latestV : !!(latestV && cur && cmpSemver(latestV, cur) > 0);
    cache = {
      current: CURRENT_VERSION,
      latest: latestBare ? `v${latestBare}` : null,
      hasUpdate,
      isDev: IS_DEV,
      checkedAt: Date.now(),
      source: sources.join('+') || null,
      error: tags.length ? null : '无法连接镜像仓库（Docker Hub / GHCR）',
    };
    return cache;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// 尚未检查过则触发一次后台检查（不等待）。GET /api/version 调用，保证刚启动也能尽快填上缓存。
export function ensureChecked(): void {
  if (!cache.checkedAt && !inflight) void checkForUpdate().catch(() => {});
}

// 启动后延迟首检（让监听就绪）+ 每 6 小时复检；定时器 unref，不阻止进程退出。
export function startUpdateChecker(): void {
  setTimeout(() => void checkForUpdate().catch(() => {}), 4_000).unref();
  setInterval(() => void checkForUpdate().catch(() => {}), 6 * 60 * 60 * 1000).unref();
}
