import { hostname } from 'node:os';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendInstanceLog, deleteInstanceLog, appendPanelLog, readInstanceLog, readPanelLog, filterSince } from './logs.js';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import { tarArchive, tarEntry, tarFileStream, tarSingleFile, openTarStream, scanArchive, sniffArchive } from './tar.js';
import { instanceAppType, getDesktopDark, type Instance } from './store.js';

// 实例镜像引用。版本耦合（架构守则 R1）：面板与实例镜像同一 release 同步出包、按同版本号
// 互相验证——正式版面板把 :latest 改写为与自身相同的版本 tag（如 1.4.1），保证
// 「面板 vX 管的实例镜像也是 vX」，杜绝旧面板拉到新实例镜像（或反之）产生未验证组合。
// 用户在 env 显式指定了非 latest tag（自行锁版）则完全尊重；开发版面板（dev-*）保持 latest。
function resolveWechatImage(): string {
  const raw = process.env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest';
  const ver = (process.env.WOC_VERSION || '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(ver)) return raw; // 开发版/未知版本 → 保持原样
  const noDigest = raw.split('@')[0];
  const m = noDigest.match(/^(.*):([^/:]+)$/);
  if (m && m[2] !== 'latest') return raw; // 用户显式锁了别的 tag → 尊重
  const repo = m ? m[1] : noDigest;
  return `${repo}:${ver}`;
}
// 注意：可被 resolveInstanceImage() 在启动时改写为 :latest 兜底（见下），故用 let。
let WECHAT_IMAGE = resolveWechatImage();

// 版本耦合的安全兜底（P0：issue #112 后续）。版本耦合让面板偏好「与自身同版本」的实例镜像 tag，
// 但若该 tag 确实没发布（典型如某次 CI 只发布了面板、实例镜像构建失败），面板会指向一个不存在的
// tag，导致可升级检测恒空、创建/升级实例拉取失败。故启动时校验一次。
//
// ⚠️ 关键（issue #114）：必须区分「仓库明确说没有(404)」和「压根连不上仓库」。
// 国内 NAS 极常见的情形是：`docker pull` 走加速镜像【能通】，但面板进程直连 registry API 的 fetch
// 【不通】。旧实现把两者都当成"不存在"→ 回退到本地那份可能几周前的 `:latest` → 用户面板明明是新版、
// 实例却永远停在老镜像，还打出"很可能该版本未成功发布"的误导文案。
// 现在：只有仓库【确认 404】才回退；连不上时保持版本 tag（乐观），把判决权交给真正的 `docker pull`
// （它有镜像加速配置，多半能拉到）；真拉不到时再由 ensureImage 兜底回退（见那里）。
let imageResolved = false;
export async function resolveInstanceImage(): Promise<void> {
  if (imageResolved) return;
  imageResolved = true;
  const preferred = WECHAT_IMAGE;
  const tagM = preferred.split('@')[0].match(/:([^/:]+)$/);
  if (!tagM || tagM[1] === 'latest') return; // 已是 latest 或无 tag → 无需兜底
  try {
    await docker.getImage(preferred).inspect();
    return; // 本地已有该版本镜像 → 用它
  } catch {
    /* 本地没有，继续查 registry */
  }
  const ref = parseImageRef(preferred);
  const probe = ref ? await probeManifest(ref) : ({ ok: false, reason: 'unreachable' } as const);
  if (probe.ok) return; // 仓库上存在该版本 → 用它（ensureImage 会拉）
  if (probe.reason === 'unreachable') {
    // 连不上仓库 ≠ 版本不存在。保持版本 tag，让 docker pull（可能走加速镜像）去试。
    appendPanelLog(
      'WARN',
      `无法连接镜像仓库校验 ${preferred}（网络受限？），仍按该版本拉取；若拉取失败会自动回退 :latest`,
    );
    return;
  }
  const fallback = preferred.replace(/:[^/:]+$/, ':latest');
  appendPanelLog(
    'WARN',
    `镜像仓库确认不存在 ${preferred}（该版本的实例镜像可能未成功发布），回退使用 ${fallback}`,
  );
  WECHAT_IMAGE = fallback;
}
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const TZ = process.env.TZ || 'Asia/Shanghai';
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

// 默认关闭 KasmVNC 的 GPU 硬件编码（baseimage 检测到 /dev/dri/renderD* 时会给 Xvnc 加 -hw3d）：
// 在 WSL2 / 虚拟 GPU 环境下该路径会导致 Xvnc 内存持续膨胀（实测反馈 21h 涨到 ~9GB）。
// 我们已设 LIBGL_ALWAYS_SOFTWARE=1 走软件渲染，hw3d 对微信这类静态界面收益甚微。
// 真实可用 GPU 想启用硬件编码：面板侧设 WOC_ENABLE_GPU=1，并让面板可见宿主 /dev/dri
// （如同摄像头，把宿主 /dev 挂到 /host-dev，或设 WOC_DRI_DEVICES 显式指定）。
const ENABLE_GPU = process.env.WOC_ENABLE_GPU === '1';
// #134：宿主内核禁用 IPv6（ipv6.disable=1）时，实例 nginx 默认配置里的 `listen [::]` 绑定失败，整个 nginx 起不来，
// 远程桌面随之全挂，用户只能进容器手动 sed。同一内核下所有容器看到的 /proc/net/if_inet6 一致：内核禁用 IPv6 时
// 该文件不存在（普通 Docker 网络只是在容器内关 IPv6，文件仍在、[::] 仍可绑定，不受影响）。也可用 WOC_DISABLE_IPV6 强制。
const NO_IPV6 = /^(1|true|yes)$/i.test(process.env.WOC_DISABLE_IPV6 || '') || !existsSync('/proc/net/if_inet6');

// 可选：给每个实例容器设内存上限（GiB），作为 Xvnc 等异常增长时的兜底，避免拖垮宿主。
// 默认 0 = 不限制（保持原行为）。命中上限时容器内 OOM 杀进程、由 s6 自动重启 VNC。
const INSTANCE_MEM_GB = Number(process.env.WOC_INSTANCE_MEM_GB) || 0;
const INSTANCE_MEM = INSTANCE_MEM_GB > 0 ? Math.floor(INSTANCE_MEM_GB * 1024 * 1024 * 1024) : 0;

// 设备伪装：把 /etc/os-release 伪装成 deepin（微信官方支持的发行版，且 Deepin 本就基于 Debian，
// 与本镜像的 Debian 用户态一致，不会自相矛盾）。默认开启；设 WOC_SPOOF_OS=0 关闭恢复 Debian。
// 配合 00-woc-identity 钩子里的 machine-id 唯一化 + 真实 hostname，整体让容器更像一台普通 Linux 桌面，
// 降低被腾讯按"非真实设备/设备农场"判风险的概率。注意：尽力而为，非保证；详见 doc/设备伪装.md。
const SPOOF_OS = process.env.WOC_SPOOF_OS !== '0';

// 给实例容器派生一个"像个人电脑"的内部 hostname（替代 woc-wx-<hex> 这种容器/服务器特征）。
// 从 inst.id 稳定派生：同一实例每次重建得到相同名字、不同实例不同。仅作伪装，不参与寻址
// （反代用容器名 containerName，不用此 hostname）。
function realisticHostname(id: string): string {
  const words = ['deepin', 'lenovo', 'thinkpad', 'matebook', 'xiaoxin', 'legion', 'dell', 'asus', 'desktop', 'home'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const w = words[h % words.length];
  const n = ((h >>> 8) % 900) + 100; // 100-999，避免前导 0
  return `${w}-pc-${n}`;
}

// 给实例容器派生一个"像真实有线网卡"的 MAC：常见网卡厂商 OUI 前缀 + 由 id 稳定派生的后三段。
// 容器默认 MAC 带"本地管理位"（第一字节第 2 位为 1，如 02/26/ee 开头），是"非真实硬件"的明显特征；
// 这里用全局管理、单播的真实厂商 OUI，更像一台插了网卡的真机。同一实例每次重建得到相同 MAC。
function realisticMac(id: string): string {
  // 常见消费级网卡厂商 OUI（全局管理 + 单播，首字节低两位为 0）
  const ouis = ['001b21', '8c1645', '00e04c', '0021cc', '3c970e', '001422', 'b827eb'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
  const oui = ouis[h % ouis.length];
  const hex = (n: number) => (n & 0xff).toString(16).padStart(2, '0');
  const tail = hex(h >>> 3) + hex(h >>> 11) + hex(h >>> 19);
  return (oui + tail).match(/.{2}/g)!.join(':');
}

const docker = new Docker(); // 默认连 /var/run/docker.sock

// 启动时等 Docker 可用。socket-proxy 加固部署下，宿主重启或 compose 同时重建代理和面板时，面板常比代理先起来，
// 头几秒解析不到 / 连不上代理；不等的话启动流程全部落空：没接上实例专用网络（实例桌面 502，要等之后的定期复查
// 才补上）、实例镜像解析不到等。直连 docker.sock 时第一下就能连上，不耽误启动。
export async function waitForDocker(maxMs = 30_000): Promise<boolean> {
  if (!process.env.DOCKER_HOST && !existsSync('/var/run/docker.sock')) return false; // 本地开发没有 Docker
  const t0 = Date.now();
  let lastErr: any;
  while (Date.now() - t0 < maxMs) {
    try {
      await docker.ping();
    } catch (e: any) {
      lastErr = e;
      if (!e?.statusCode) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // 有 HTTP 响应（代理没放行 /_ping 之类）：Docker 是通的
    }
    const waited = Date.now() - t0;
    if (waited > 1500) appendPanelLog('INFO', `等了 ${Math.round(waited / 1000)} 秒才连上 Docker（socket-proxy 刚启动？）`);
    return true;
  }
  appendPanelLog(
    'ERROR',
    `${Math.round(maxMs / 1000)} 秒内连不上 Docker（${lastErr?.message || lastErr}），实例相关功能暂不可用；请检查 docker.sock 挂载或 socket-proxy 容器`,
  );
  return false;
}

// 实例接入的 docker 网络名。默认是实例专用网络（见 ensureNetwork）；WOC_DOCKER_NETWORK 显式指定时用指定的。
const EXPLICIT_NETWORK = (process.env.WOC_DOCKER_NETWORK || '').trim() || null;
const INSTANCE_NETWORK = (process.env.WOC_INSTANCE_NETWORK || '').trim() || 'woc-instances';
let networkName: string | null = null;

export type RuntimeState = 'running' | 'stopped' | 'missing';

// 面板自身容器的完整 ID：docker 把 /etc/hostname、/etc/hosts、/etc/resolv.conf 从
// <数据目录>/containers/<id>/ 绑定挂进容器，mountinfo 里带着这个 ID，与容器名、hostname 都无关。
// （podman 的路径是 .../overlay-containers/<id>/userdata/hostname，同样认得出。）
function selfIdFromMounts(): string | null {
  try {
    const m = readFileSync('/proc/self/mountinfo', 'utf8').match(
      /\/([0-9a-f]{64})\/(?:userdata\/)?(?:hostname|hosts|resolv\.conf) \/etc\//,
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 找到「面板自身容器」。新建/重建实例要接到它所在的网络（反代按容器名访问实例），自更新要知道重建哪个容器。
// 候选依次：① mountinfo 里的容器 ID ② 容器 hostname（默认 = 自身短 ID）③ 已知面板容器名。
// ② ③ 都会落空的情形：compose 里自定义了 hostname 且容器不叫 woc-panel；或容器被 1Panel/Portainer 之类
// 工具「重建」时复刻了旧容器的 Hostname（= 已删除的旧容器 ID）。此前只有 ② ③，落空后实例落到默认
// bridge → 反代按名找不到 → 502 黑屏（#103），① 不受这些影响。
export async function inspectSelf(): Promise<any | null> {
  const candidates = [selfIdFromMounts(), hostname(), process.env.WOC_PANEL_CONTAINER || 'woc-panel'];
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      return await docker.getContainer(cand).inspect();
    } catch {
      /* 该候选找不到/读不到，尝试下一个 */
    }
  }
  return null;
}

// 面板所在的网络（去掉 none/host），按名字排序。
const netsOf = (self: any): string[] =>
  Object.keys(self?.NetworkSettings?.Networks || {})
    .filter((n) => n !== 'none' && n !== 'host')
    .sort();
async function selfNetworks(): Promise<string[] | null> {
  const self = await inspectSelf();
  return self ? netsOf(self) : null;
}

// socket-proxy 拒绝时 docker 报错里带着它整页的 HTML（多行），写进面板日志前去掉标签、压成一行
const oneLine = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

// 探测结果只在面板日志里提示一次（ensureNetwork 探测失败时每次建实例都会重试）。
const networkWarned = new Set<string>();
function warnNetworkOnce(key: string, msg: string): void {
  if (networkWarned.has(key)) return;
  networkWarned.add(key);
  appendPanelLog('WARN', msg);
}

// ---------- 实例专用网络 ----------
// 实例只接入一个专用网络（默认 woc-instances），面板自己也接上它，按容器名访问实例。此前实例直接接到面板所在的
// 网络：面板部署在 1Panel 的 1panel-network、反代所在网络这类共享网络上时，跑着微信 / 浏览器等不可信内容的实例
// 能直接访问同网络里的数据库、其它服务。专用网络建不起来（socket-proxy 加固部署没开放网络接口、地址池耗尽等）时
// 退回旧做法并在面板日志提示。已有实例在下次重启 / 升级 / 自愈重建时迁过来（重建沿用同一个伪装 MAC），不主动重启。
let isolatedNet: { subnet: string; gateway: string } | null = null; // 专用网络生效时的网段（拦截来自实例的请求用）

async function attachSelfToInstanceNetwork(self: any): Promise<void> {
  const net = docker.getNetwork(INSTANCE_NETWORK);
  let info: any = await net.inspect().catch((e: any) => {
    if (e?.statusCode === 404) return null;
    throw e;
  });
  if (!info) {
    await docker
      .createNetwork({ Name: INSTANCE_NETWORK, Driver: 'bridge', CheckDuplicate: true, Labels: { 'com.wechatoncloud.role': 'instances' } } as any)
      .catch((e: any) => {
        if (e?.statusCode !== 409) throw e; // 409 = 同时被别处建好了
      });
    info = await net.inspect();
    appendPanelLog('INFO', `已创建实例专用网络 ${INSTANCE_NETWORK}，之后新建 / 重启的实例都接到这里，与面板所在的其它网络隔离`);
  }
  if (!netsOf(self).includes(INSTANCE_NETWORK)) {
    // GwPriority < 0：面板的默认网关（出网、端口映射）仍走原来的网络；不设的话网络名排序靠前时默认网关会换到这边
    try {
      await net.connect({ Container: self.Id, EndpointConfig: { GwPriority: -1 } } as any);
    } catch (e: any) {
      if (!/already exists|already attached/i.test(String(e?.message))) throw e;
    }
  }
  const cfg = (info?.IPAM?.Config || []).find((c: any) => c?.Subnet && !String(c.Subnet).includes(':'));
  isolatedNet = cfg ? { subnet: String(cfg.Subnet), gateway: String(cfg.Gateway || '') } : null;
}

// 请求是否来自实例（专用网络网段内、且不是网关——经宿主转发进来的请求源地址是网关）。实例从不需要访问面板，
// 拦掉可以让被攻破的实例碰不到面板的登录与接口。
export function isFromInstanceNetwork(addr: string | undefined): boolean {
  if (!isolatedNet || !addr) return false;
  const ip = addr.replace(/^::ffff:/, '');
  if (!ip || ip === isolatedNet.gateway || ip.includes(':')) return false;
  const [base, bits] = isolatedNet.subnet.split('/');
  const toInt = (x: string) => x.split('.').reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
  const n = Number(bits);
  if (!(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
}

export function instanceNetworkName(): string | null {
  return isolatedNet ? INSTANCE_NETWORK : null;
}

// 本机 Docker 网络的网段（登录限速判断「对端是不是反代」用）：宿主上的反代（NAS 自带的反代、frpc）经网关地址进来，
// 容器里的反代（Nginx Proxy Manager、1Panel 的 OpenResty、cloudflared 等）是某个 Docker 网络里的地址。
// 实例专用网络只算网关（经宿主转发进来的请求源地址是它）：实例不是反代。
export async function dockerProxySubnets(): Promise<string[]> {
  const out: string[] = [];
  try {
    const nets: any[] = await docker.listNetworks();
    for (const n of nets) {
      for (const c of n?.IPAM?.Config || []) {
        if (n?.Name === INSTANCE_NETWORK) {
          if (c?.Gateway) out.push(String(c.Gateway));
        } else if (c?.Subnet) out.push(String(c.Subnet));
      }
    }
  } catch {
    // 列不出网络（socket-proxy 没开放网络接口）：退而求其次，只认面板自己所在网络
    const self = await inspectSelf().catch(() => null);
    for (const [name, ep] of Object.entries<any>(self?.NetworkSettings?.Networks || {})) {
      if (ep?.Gateway) out.push(String(ep.Gateway));
      if (name !== INSTANCE_NETWORK && ep?.IPAddress && ep?.IPPrefixLen) out.push(`${ep.IPAddress}/${ep.IPPrefixLen}`);
    }
  }
  return out;
}

// 面板容器被外部工具重建（compose up、1Panel / Portainer 的「重建」、飞牛应用更新）后，运行时接上的网络会丢失，
// 已迁到专用网络的实例就连不上了（502）。启动时 ensureNetwork 会接回去；这里定期复查兜底。
// 启动时 Docker 一直没连上（waitForDocker 等满了）的也在这里补上：没接上的补接；面板重启（不是重建）时网络还在、
// 但专用网络的网段没读到，拦截实例访问面板的那层防护不生效，也要补。
export function watchInstanceNetwork(): void {
  if (EXPLICIT_NETWORK) return;
  const tick = async () => {
    const self = await inspectSelf().catch(() => null);
    if (!self) return;
    const attached = netsOf(self).includes(INSTANCE_NETWORK);
    if (attached && isolatedNet && networkName === INSTANCE_NETWORK) return;
    const was = networkName === INSTANCE_NETWORK;
    try {
      await attachSelfToInstanceNetwork(self);
      networkName = INSTANCE_NETWORK;
      if (!attached) {
        appendPanelLog(
          was ? 'WARN' : 'INFO',
          was
            ? `面板不在实例专用网络 ${INSTANCE_NETWORK} 上了（容器被重建过？），已重新接上`
            : `已接入实例专用网络 ${INSTANCE_NETWORK}，之后新建 / 重启的实例都接到这里`,
        );
      }
    } catch (e: any) {
      if (was) appendPanelLog('ERROR', `面板重新接入实例专用网络 ${INSTANCE_NETWORK} 失败：${oneLine(String(e?.message || e))}`);
    }
  };
  setTimeout(() => void tick(), 15_000).unref();
  setInterval(() => void tick(), 2 * 60 * 1000).unref();
}

// 新建/重建的实例接到哪个网络。优先实例专用网络；WOC_DOCKER_NETWORK 显式指定时用指定的；
// 都不行时退回面板自身所在的网络。失败不致命：返回 null（实例落到 docker 默认 bridge，反代按名访问不到）。
let ensuring: Promise<string | null> | null = null;
export function ensureNetwork(): Promise<string | null> {
  if (networkName) return Promise.resolve(networkName);
  if (!ensuring) ensuring = resolveNetwork().finally(() => (ensuring = null));
  return ensuring;
}
async function resolveNetwork(): Promise<string | null> {
  if (EXPLICIT_NETWORK) return (networkName = EXPLICIT_NETWORK);
  const self = await inspectSelf();
  if (self) {
    try {
      await attachSelfToInstanceNetwork(self);
      return (networkName = INSTANCE_NETWORK);
    } catch (e: any) {
      const msg = String(e?.message || e);
      warnNetworkOnce(
        'isolation',
        `没能建立实例专用网络 ${INSTANCE_NETWORK}（${oneLine(msg)}），实例暂时仍接到面板所在的网络、与同网络的其它容器互通。` +
          (/403|forbidden|denied/i.test(msg) ? '多见于 socket-proxy 加固部署没开放 NETWORKS 权限，见 doc/安全加固.md' : ''),
      );
    }
  }
  const nets = self ? netsOf(self) : null;
  // 默认 bridge 不支持按容器名解析。面板同时在 bridge 和自定义网络上时必须选自定义网络——旧逻辑取排序后
  // 第一个，网络名排在 "bridge" 之后（如 proxy、traefik）就会选中 bridge，实例全部 502。
  const pick = nets?.find((n) => n !== 'bridge') || nets?.[0] || null;
  if (pick === 'bridge') {
    warnNetworkOnce(
      'bridge',
      '面板在 Docker 默认 bridge 网络上，该网络不能按容器名互访，实例桌面会打不开（502）。' +
        '请用 docker compose 部署（自带独立网络），或把面板接到自定义网络后重建面板',
    );
  }
  if (pick) {
    networkName = pick;
    return networkName;
  }
  console.warn('[docker] 无法探测面板网络（本地开发或缺少 docker.sock 时正常）');
  warnNetworkOnce(
    'none',
    nets
      ? '面板容器没有可用的 Docker 网络，新建/重启的实例将落到默认 bridge，桌面会打不开（502）'
      : '找不到面板自身容器，无法确定它所在的 Docker 网络，新建/重启的实例将落到默认 bridge，桌面可能打不开（502）。' +
          '可在 .env 设 WOC_DOCKER_NETWORK=<面板所在网络名> 后 docker compose up -d',
  );
  return null;
}

// 启动时体检一次（只记日志、不动实例）：① 显式指定的 WOC_DOCKER_NETWORK 面板自己不在上面；
// ② 运行中的实例和面板不在任何一个共同的自定义网络上（旧版探测失败时建到了 bridge 的实例，#103）；
// ③ 专用网络生效后，还留在共享网络上的老实例（下次重建时自动迁移）。
// ① ② 表现为桌面 502 / 一直重连；② 点「重启」即会把实例重建到面板网络（数据保留）。
export async function checkInstanceNetworks(instances: Instance[]): Promise<void> {
  const nets = await selfNetworks();
  if (!nets) return;
  if (EXPLICIT_NETWORK && !nets.includes(EXPLICIT_NETWORK)) {
    warnNetworkOnce(
      'explicit',
      `WOC_DOCKER_NETWORK=${EXPLICIT_NETWORK}，但面板自己不在这个网络上（面板所在：${nets.join(', ') || '无'}），` +
        '实例会接到面板访问不到的网络。请改成面板所在的网络名，或清空它让面板自动探测',
    );
  }
  const shared = new Set(nets.filter((n) => n !== 'bridge'));
  if (!shared.size) return; // 面板自己就不在自定义网络上：ensureNetwork 已提示
  const stray: string[] = [];
  const pending: string[] = [];
  for (const inst of instances) {
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      const own = Object.keys(info.NetworkSettings?.Networks || {});
      if (isolatedNet && !own.includes(INSTANCE_NETWORK)) pending.push(`「${inst.name}」`);
      if (!info.State?.Running) continue;
      if (!own.some((n) => shared.has(n))) stray.push(`「${inst.name}」(${own.join('/') || '无网络'})`);
    } catch {
      /* 容器不存在：启动流程会按当前配置新建 */
    }
  }
  if (pending.length) {
    appendPanelLog(
      'INFO',
      `实例${pending.join('、')} 还在面板所在的共享网络上，下次重启 / 升级时会自动迁到专用网络 ${INSTANCE_NETWORK}（数据与设备标识不变）；想立即隔离可在管理页点「重启」`,
    );
  }
  if (stray.length) {
    appendPanelLog(
      'WARN',
      `实例${stray.join('、')} 与面板（${[...shared].join(', ')}）不在同一 Docker 网络，面板连不到它们，桌面会打不开。` +
        '在面板里点这些实例的「重启」即可重建到面板网络（数据保留）',
    );
  }
}

// 摄像头直通：把宿主的 v4l2 视频设备映射进实例容器
// （浏览器摄像头 → KasmVNC → 容器内 /dev/videoN(v4l2loopback) → 微信）。
// 来源优先级：
//   1) WOC_VIDEO_DEVICES 显式指定（逗号分隔，如 /dev/video0,/dev/video1）——Ubuntu/无法自动探测时用；
//   2) 自动探测：把宿主 /dev 以只读挂到面板的 /host-dev（compose 可选），扫描其中的 videoN。
// 一个都找不到则返回空：音频/麦克风不受影响，仅摄像头不可用（优雅降级）。
function videoDevices(): string[] {
  const explicit = (process.env.WOC_VIDEO_DEVICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  for (const dir of ['/host-dev', '/dev']) {
    try {
      if (!existsSync(dir)) continue;
      const vids = readdirSync(dir)
        .filter((n) => /^video\d+$/.test(n))
        .map((n) => `/dev/${n}`); // 宿主侧设备路径
      if (vids.length) return vids;
    } catch {
      /* 无权限/不可读，忽略 */
    }
  }
  return [];
}

// GPU 直通：把宿主 /dev/dri 渲染节点映射进实例容器，仅 WOC_ENABLE_GPU=1 时生效。
// 来源优先级：
//   1) WOC_DRI_DEVICES 显式指定（逗号分隔，如 /dev/dri/renderD128,/dev/dri/card0）；
//   2) 自动探测：扫描面板可见的 /host-dev/dri 或 /dev/dri 中的 renderD*/card*。
// 一个都找不到则返回空：硬件编码不可用，但实例照常创建（优雅降级）。
function driDevices(): string[] {
  const explicit = (process.env.WOC_DRI_DEVICES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  for (const dir of ['/host-dev/dri', '/dev/dri']) {
    try {
      if (!existsSync(dir)) continue;
      const dris = readdirSync(dir)
        .filter((n) => /^(renderD\d+|card\d+)$/.test(n))
        .map((n) => `/dev/dri/${n}`); // 宿主侧设备路径
      if (dris.length) return dris;
    } catch {
      /* 无权限/不可读，忽略 */
    }
  }
  return [];
}

// 读取这些 DRI 设备文件的属主数字 GID。宿主上 /dev/dri/renderD* 常归属一个「动态分配」的
// render 组（其 GID 因发行版而异），与镜像内 render 组的 GID 未必一致；仅靠组名加 GroupAdd
// 时，容器内 abc 用户可能仍打不开渲染节点（permission denied）。把宿主侧真实数字 GID 一并
// 加进 GroupAdd，才能保证可访问。读取失败/无权限则跳过（退回仅组名，优雅降级）。
function driDeviceGids(devices: string[]): string[] {
  const gids = new Set<string>();
  for (const dev of devices) {
    try {
      gids.add(String(statSync(dev).gid));
    } catch {
      /* 设备不可 stat（面板未挂 /host-dev 等），忽略 */
    }
  }
  return Array.from(gids);
}

function envList(inst: Instance): string[] {
  const env = [
    `PUID=${PUID}`,
    `PGID=${PGID}`,
    `TZ=${TZ}`,
    `CUSTOM_USER=${inst.kasmUser}`,
    `PASSWORD=${inst.kasmPassword}`,
  ];
  // baseimage 仅检查该变量是否「已设置」（值无关），设上即不再给 Xvnc 加 -hw3d。
  if (!ENABLE_GPU) env.push('DISABLE_DRI=1');
  // 透传 os 伪装开关给容器内的 00-woc-identity 钩子（决定是否把 /etc/os-release 改成 deepin）。
  env.push(`WOC_SPOOF_OS=${SPOOF_OS ? '1' : '0'}`);
  // v1.2.0 多应用：透传应用类型给 02-woc-app 钩子（写入 /config/.woc-app，autostart 据此启动）。
  // 老实例无 appType → instanceAppType 回退 wechat；自定义应用额外透传启动命令。
  const appType = instanceAppType(inst);
  env.push(`WOC_APP_TYPE=${appType}`);
  if (appType === 'custom' && inst.customLaunch) env.push(`WOC_CUSTOM_LAUNCH=${inst.customLaunch}`);
  // 深色模式：作为新实例启动时的初始明暗下发给 autostart（autostart 据此设 portal color-scheme，
  // 微信等 Chromium 系应用即跟随系统深色）。开关由面板顶栏主题统一控制、持久化在 accounts.json，
  // 运行中的实例则通过 setInstanceDark 实时切换（见下）。
  if (getDesktopDark()) env.push('WOC_DARK=1');
  // baseimage 的 init-nginx 只看 DISABLE_IPV6 是否已设置，设了就删掉 `listen [::]`（每次启动重新生成配置，故须常驻于容器环境）
  if (NO_IPV6) env.push('DISABLE_IPV6=1');
  return env;
}

// 确保微信镜像在本地存在；缺失则从 GHCR 拉取（首次新建实例时镜像通常还没拉过）。
async function ensureImage(): Promise<void> {
  await resolveInstanceImage(); // 版本兜底：若耦合的版本 tag 不可达则先回退 :latest
  try {
    await docker.getImage(WECHAT_IMAGE).inspect();
    return;
  } catch {
    /* 本地没有，下面拉取 */
  }
  // 首次新建实例常卡在这一步（NAS 直连 docker.io 拉取超时，见 README）。这里前后都打日志：
  // 若诊断包里只见"开始拉取"而无"完成/失败"，即可定位为拉取卡死。
  appendPanelLog('INFO', `本地无实例镜像 ${WECHAT_IMAGE}，开始拉取（首次较慢；NAS 直连 docker.io 可能超时）…`);
  const t0 = Date.now();
  try {
    await pullImage();
    appendPanelLog('INFO', `实例镜像拉取完成 ${WECHAT_IMAGE}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
    return;
  } catch (e: any) {
    appendPanelLog('ERROR', `实例镜像拉取失败 ${WECHAT_IMAGE}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）：${e?.message || e}`);
    // 真兜底（issue #114）：版本 tag 拉不到时，若本地已有 :latest 就退而求其次用它，别让用户彻底不能用。
    // 这里基于【真实拉取失败】而非探测猜测——docker pull 有镜像加速配置，探测不通不代表拉不到。
    const fb = fallbackLatestRef();
    if (fb) {
      try {
        await docker.getImage(fb).inspect();
        appendPanelLog('WARN', `改用本地已有的 ${fb} 重建（注意：它可能是较旧的镜像；网络恢复后请重新「升级实例」拿到 ${WECHAT_IMAGE}）`);
        WECHAT_IMAGE = fb;
        return;
      } catch {
        /* 本地也没有 :latest → 无可兜底，抛出原错误 */
      }
    }
    throw e;
  }
}

// 当前镜像引用对应的 :latest 形式；已是 latest / 无 tag 则返回 null（无可回退）。
function fallbackLatestRef(): string | null {
  const noDigest = WECHAT_IMAGE.split('@')[0];
  const m = noDigest.match(/^(.*):([^/:]+)$/);
  if (!m || m[2] === 'latest') return null;
  return `${m[1]}:latest`;
}

// ---------- 自定义数据目录 WOC_DATA_ROOT（#133 #127，取代 PR #69 的做法） ----------
// 需求：实例数据（聊天记录、收到的文件）落到用户自选的宿主目录（大容量盘 / 方便直接取文件），
// 而不是 Docker 默认的卷目录。PR #69 直接把 /config 改绑宿主路径，会让已有实例切到空目录（看似丢数据），
// 且面板里按卷名工作的功能（数据卷浏览/备份/恢复/孤儿卷清理）全部失效。
// 这里改用 local 驱动的「绑定型具名卷」：卷名不变、内容在宿主目录，其余功能原样可用；
// 且只在新建实例（卷尚不存在）时生效——已存在的卷一律不碰，老实例零影响，事后取消该设置也不影响已建实例。
function parseDataRoot(raw: string | undefined): string {
  const v = (raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  // 只接受干净的绝对路径：会被拼进辅助容器的 shell 命令与卷的 device 参数
  if (!/^\/[A-Za-z0-9._\-\/]+$/.test(v) || v.split('/').includes('..')) {
    console.error(`[data-root] 忽略非法的 WOC_DATA_ROOT：${v}（需为不含空格与 .. 的宿主绝对路径）`);
    return '';
  }
  return v;
}
const DATA_ROOT = parseDataRoot(process.env.WOC_DATA_ROOT);
const VOLUME_NAME_RE = /^woc-data-[0-9a-z]+$/;
const SAFE_ID = (v: string) => (/^\d+$/.test(v) ? v : '1000');

// 以 root 跑一次性辅助容器，把宿主 root 目录挂到 /woc-root 执行一段脚本（面板容器本身看不到宿主路径）
async function runDataRootHelper(root: string, image: string, script: string): Promise<void> {
  const c = await docker.createContainer({
    Image: image,
    Entrypoint: ['sh', '-c'],
    Cmd: [script],
    User: '0',
    Labels: { 'woc.helper': 'data-root' },
    HostConfig: { Binds: [`${root}:/woc-root`] },
  } as any);
  try {
    await c.start();
    const r: any = await c.wait();
    if (r?.StatusCode !== 0) throw new Error(`辅助容器退出码 ${r?.StatusCode}`);
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

async function ensureInstanceVolume(inst: Instance, image: string): Promise<void> {
  if (!DATA_ROOT || !VOLUME_NAME_RE.test(inst.volumeName)) return;
  try {
    await docker.getVolume(inst.volumeName).inspect();
    return; // 卷已存在（老实例 / 重启 / 自愈）：绝不改动
  } catch {
    /* 不存在 → 按 WOC_DATA_ROOT 新建 */
  }
  const dir = `${DATA_ROOT}/${inst.volumeName}`;
  await runDataRootHelper(
    DATA_ROOT,
    image,
    `mkdir -p /woc-root/${inst.volumeName} && chown ${SAFE_ID(PUID)}:${SAFE_ID(PGID)} /woc-root/${inst.volumeName}`,
  );
  await docker.createVolume({
    Name: inst.volumeName,
    Driver: 'local',
    DriverOpts: { type: 'none', o: 'bind', device: dir },
    Labels: { 'woc.data-root': DATA_ROOT },
  } as any);
  appendInstanceLog(inst.id, `数据目录：宿主 ${dir}（WOC_DATA_ROOT）`);
  appendPanelLog('INFO', `实例 ${inst.id} 的数据目录建在宿主 ${dir}`);
}

// 删除数据卷；若是 WOC_DATA_ROOT 建的绑定型卷，宿主目录一并删除（「清除数据」的本意），
// 否则删卷只是去掉 Docker 里的卷对象，数据会以用户看不见的形式留在宿主上。
async function removeVolumeWithData(name: string): Promise<void> {
  let root = '';
  try {
    const info: any = await docker.getVolume(name).inspect();
    root = parseDataRoot(info?.Labels?.['woc.data-root']);
  } catch {
    /* 卷不存在 */
  }
  await docker.getVolume(name).remove({ force: true } as any);
  if (!root || !VOLUME_NAME_RE.test(name)) return;
  try {
    await runDataRootHelper(root, WECHAT_IMAGE, `rm -rf /woc-root/${name}`);
    appendPanelLog('INFO', `已删除宿主数据目录 ${root}/${name}`);
  } catch (e: any) {
    appendPanelLog('WARN', `宿主数据目录 ${root}/${name} 未能自动删除（${e?.message || e}），可手动删除`);
  }
}

// 诊断用：说明数据实际落在哪里
export async function describeInstanceVolume(name: string): Promise<string> {
  try {
    const info: any = await docker.getVolume(name).inspect();
    const dev = info?.Options?.device;
    return info?.Options?.o === 'bind' && dev ? `宿主目录 ${dev}` : `Docker 卷 ${info?.Mountpoint || ''}`.trim();
  } catch {
    return '卷尚不存在';
  }
}

// 创建并启动一个微信实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
// keepImage（稳定性关键）：重启/自愈必须幂等——沿用该实例当前正在跑的镜像重建，
// 绝不因"本地 :latest 恰好被某次拉取更新过"就悄悄换镜像（那等于一次没人要求的隐式升级；
// 若本地新镜像恰好是坏的，一次看门狗自愈就能弄坏一个用户从没升级过的实例）。
// 换镜像只允许发生在显式「升级实例」（不带 keepImage）。
// 同一实例的重建串行执行：手动重启、看门狗自愈、卡死自愈、升级可能撞在一起，并发时两边都「删旧建新」，
// 实测同时点两次重启必有一次报「容器名已被占用」失败（运气差时还会删掉另一边刚建好、尚未启动的容器）。
const lifecycleChains = new Map<string, Promise<unknown>>();
function withLifecycle<T>(instId: string, fn: () => Promise<T>): Promise<T> {
  const run = (lifecycleChains.get(instId) || Promise.resolve()).then(fn, fn);
  lifecycleChains.set(instId, run.catch(() => undefined));
  return run;
}
export function runInstance(inst: Instance, opts?: { keepImage?: boolean }): Promise<void> {
  return withLifecycle(inst.id, () => runInstanceNow(inst, opts));
}
async function runInstanceNow(inst: Instance, opts?: { keepImage?: boolean }): Promise<void> {
  const net = await ensureNetwork();
  const existing = docker.getContainer(inst.containerName);
  const info: any = await existing.inspect().catch(() => null);
  const imageOverride: string | undefined = opts?.keepImage && info?.Image ? String(info.Image) : undefined;
  // 沿用旧镜像重建时无需 ensureImage（镜像 id 一定在本地——容器刚在用它）；
  // 也避免"离线 + 本地无 :latest"时连重启都失败。
  // 必须先确保目标镜像在本地、再删旧容器：此前先删后拉，升级时拉不到新镜像（面板刚更新、本地只有旧版本号的镜像、
  // 网络又不通）就会把旧容器删掉却建不出新的，实例直接没了；现在拉取失败时旧容器原样保留。
  if (!imageOverride) await ensureImage();
  if (info) {
    try {
      // 删除前先把旧容器最后日志快照进持久日志，否则随容器删除就看不到"上次为何停/崩"。
      await snapshotContainerLog(inst, '容器重建（重启/升级/自愈），保留上一容器最后日志');
      await existing.remove({ force: true });
    } catch {
      /* 已被移走，正常 */
    }
  }
  await ensureInstanceVolume(inst, imageOverride || WECHAT_IMAGE);
  // 摄像头设备（探测不到则为空数组 → 仅摄像头不可用，音频/麦克风照常）
  const vids = videoDevices();
  const dris = ENABLE_GPU ? driDevices() : [];
  const hostConfig: Docker.HostConfig = {
    Binds: [`${inst.volumeName}:/config`],
    NetworkMode: net || undefined,
    SecurityOpt: ['seccomp=unconfined'],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: 'unless-stopped' },
    // 日志硬上限：docker 默认 json-file 无大小限制，应用崩溃循环（每 2s 刷错误）会把宿主磁盘
    // 无限吃掉（群晖用户反馈"一下子 1TB 没了"的元凶之一）。每实例封顶 20MB×2。
    LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '2' } },
  };
  if (INSTANCE_MEM > 0) {
    hostConfig.Memory = INSTANCE_MEM;
    hostConfig.MemorySwap = INSTANCE_MEM; // 禁止 swap 膨胀：限制即为硬上限
  }
  if (vids.length) {
    hostConfig.Devices = vids.map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' }));
    hostConfig.GroupAdd = ['video']; // 让容器内 abc 用户能访问 /dev/videoN
    console.log(`[docker] 实例 ${inst.id} 挂载摄像头设备: ${vids.join(', ')}`);
  }
  if (dris.length) {
    hostConfig.Devices = [
      ...(hostConfig.Devices || []),
      ...dris.map((d) => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' })),
    ];
    // 组名 render/video + 宿主侧真实数字 GID（应对 render 组 GID 在宿主与镜像间不一致的常见情况）。
    hostConfig.GroupAdd = Array.from(
      new Set([...(hostConfig.GroupAdd || []), 'render', 'video', ...driDeviceGids(dris)]),
    );
    console.log(`[docker] 实例 ${inst.id} 挂载 GPU 渲染设备: ${dris.join(', ')}`);
  }
  // 伪装成真实有线网卡 MAC（厂商 OUI），替代容器默认的本地管理位 MAC。
  const mac = realisticMac(inst.id);
  const createOpts: Docker.ContainerCreateOptions = {
    name: inst.containerName,
    Image: imageOverride || WECHAT_IMAGE,
    // 内部 hostname 伪装成"个人电脑"名（不再用 woc-wx-<hex>，那是容器/服务器特征）。
    // 反代靠容器名 name 寻址，与此 hostname 无关。
    Hostname: realisticHostname(inst.id),
    Env: envList(inst),
    ExposedPorts: { '3000/tcp': {} },
    HostConfig: hostConfig,
  };
  // 自定义网络时，MAC 须写到对应 endpoint 上（新版 docker 弃用顶层 MacAddress）；默认网络则用顶层。
  if (net) {
    createOpts.NetworkingConfig = { EndpointsConfig: { [net]: { MacAddress: mac } as any } };
  } else {
    (createOpts as any).MacAddress = mac;
  }
  const container = await docker.createContainer(createOpts);
  try {
    await container.start();
    appendInstanceLog(inst.id, '容器已启动');
    // 容器重建后恢复持久化的字体配置 / xsettingsd
    restoreFontFromVolume(inst).catch(() => {});
  } catch (e) {
    // 启动失败但容器已被创建出来（Created 状态），不清理的话会成为"幽灵容器"——
    // 它仍占着卷名 woc-data-<id>，让后续删卷报 409。修复 #23 时发现 4 个此类残留。
    try {
      await container.remove({ force: true });
    } catch {
      /* 容器已被外部移走或正在被清理，忽略 */
    }
    throw e;
  }
}

// 确保实例容器在运行：缺失则按需创建（不会重建已有卷），停止则启动。
// 只有容器确实不存在（404）才新建：Docker 一时连不上（socket-proxy 还没起来）时若也当成「不存在」去重建，
// 重建那一刻网络多半也没探测到，实例会落到默认 bridge、桌面 502。
export async function ensureRunning(inst: Instance): Promise<void> {
  const c = docker.getContainer(inst.containerName);
  let info: any;
  try {
    info = await c.inspect();
  } catch (e: any) {
    if (e?.statusCode !== 404) throw e;
    return runInstance(inst);
  }
  if (info.State?.Running) return;
  try {
    await c.start();
  } catch {
    await runInstance(inst);
  }
}

// 升级实例：拉取最新微信镜像后重建容器（保留数据卷 → 登录态不丢）。
// 拉取失败（本地自构建 / 离线 / 仓库不可达）则用本地现有镜像重建，不阻断。
// skipPull：批量升级时由调用方先统一拉取一次，避免 N 个实例拉 N 次（受限网络下每次
// 都要等到拉取停滞超时，表现为"一键升级卡死"）。
export async function upgradeInstance(inst: Instance, opts?: { skipPull?: boolean }): Promise<void> {
  let pullErr: any = null;
  if (!opts?.skipPull) {
    try {
      await pullImage();
    } catch (e: any) {
      pullErr = e;
      console.warn('[docker] 升级时拉取镜像失败，改用本地镜像重建:', e?.message || e);
    }
  }
  // 记录升级前镜像，用于事后判断"升级是否真的换了镜像"（issue #112：拉取失败静默回退旧镜像，
  // 用户被告知"完成"、实际什么都没变，且无从自查）。
  const before = await (async () => {
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      return String(info.Image || '');
    } catch {
      return '';
    }
  })();
  // 拉取失败、本地的目标镜像又正是实例现在用的：没有可升级的东西，别白白重建（实例会重启一次、所有人断线）
  if (pullErr && before) {
    const target = await docker.getImage(WECHAT_IMAGE).inspect().then((i: any) => String(i.Id || '')).catch(() => '');
    if (target === before) {
      throw new Error(`拉取新镜像失败（${pullErr?.message || pullErr}），实例未改动（未升级）。请检查网络/镜像源后重试`);
    }
  }
  // 升级不改变用户的运行状态：原本停止的实例，升级（重建）后停回去，而不是悄悄拉起。
  const wasStopped = (await instanceRuntime(inst)) === 'stopped';
  await runInstance(inst);
  if (wasStopped) {
    try {
      await stopInstance(inst);
      appendInstanceLog(inst.id, '升级完成，恢复原有的停止状态');
    } catch {
      /* 停不回去也不算失败 */
    }
  }
  const after = await (async () => {
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      return String(info.Image || '');
    } catch {
      return '';
    }
  })();
  if (pullErr && before && after === before) {
    // 诚实汇报：拉取失败且镜像未变 = 这次"升级"没有升级任何东西。抛错让调用方按失败处理，
    // 用户才知道要去解决网络/镜像源问题，而不是误以为已修复。
    throw new Error(
      `拉取新镜像失败（${pullErr?.message || pullErr}），实例仍在原镜像上重建（未升级）。请检查网络/镜像源后重试`,
    );
  }
  if (before && after !== before) {
    appendInstanceLog(inst.id, `镜像已更换：${before.slice(7, 19)} → ${after.slice(7, 19)}`);
  } else if (!pullErr) {
    appendInstanceLog(inst.id, '镜像已是最新，无需更换');
  }
}

// 清理【旧版本 woc 镜像】：删掉不再被任何容器使用、也不是当前版本的 woc-panel / wechat-on-cloud 镜像。
// 背景：版本耦合后面板拉的是带版本号的 tag（:1.4.5），升级到 :1.4.6 后旧的 :1.4.5 镜像仍带 tag、
// 不是 dangling，pruneDanglingImages 清不掉 → 每个历史版本的镜像（各 1~2GB）长期堆积吃满磁盘
// （用户反馈"历史镜像占用太多"）。这里按"无容器引用 + 非当前版本"精准删除，绝不动正在用/未升级实例的镜像。
// 环境变量 WOC_KEEP_OLD_IMAGES=1 可关闭（想保留旧镜像便于快速回滚的用户）。
export async function pruneOldWocImages(): Promise<void> {
  if (process.env.WOC_KEEP_OLD_IMAGES === '1') return;
  try {
    // 1) 要保留的镜像 id 集合：当前实例镜像 + 面板自身镜像 + 所有现存容器（含已停止）在用的镜像。
    const keep = new Set<string>();
    const curInstance = await latestInstanceImageId();
    if (curInstance) keep.add(curInstance);
    try {
      const panelC: any = await inspectSelf();
      if (panelC?.Image) keep.add(String(panelC.Image));
    } catch {
      /* 面板容器名不同/查不到 → 跳过，下面的容器遍历仍会覆盖到 */
    }
    const containers: any[] = await docker.listContainers({ all: true });
    for (const c of containers) if (c?.ImageID) keep.add(String(c.ImageID));

    // 2) 识别 woc 镜像的仓库路径（从 WECHAT_IMAGE 推断 owner，兼容 ghcr/docker.io/无前缀各种 tag 写法）。
    const ref = parseImageRef(WECHAT_IMAGE);
    const owner = ref?.repo.split('/').slice(0, -1).join('/') || 'gloridust';
    const panelRepo = process.env.WOC_PANEL_REPO || 'woc-panel';
    const wocRepoNeedles = [`${owner}/wechat-on-cloud`, `${owner}/${panelRepo}`];

    // 3) 遍历本地镜像，删掉"属于 woc 仓库 + 不在 keep 集"的。
    const images: any[] = await docker.listImages();
    let removed = 0;
    for (const img of images) {
      const tags: string[] = img.RepoTags || [];
      if (!tags.some((t) => wocRepoNeedles.some((n) => t.includes(n)))) continue; // 非 woc 镜像
      if (keep.has(String(img.Id))) continue; // 当前/在用 → 保留
      try {
        await docker.getImage(img.Id).remove({ force: true }); // force：一次删掉该镜像的所有 tag
        removed++;
        appendPanelLog('INFO', `清理旧版本镜像 ${tags.join(', ') || String(img.Id).slice(7, 19)}`);
      } catch {
        /* 仍被占用等 → 跳过，不影响其它 */
      }
    }
    if (removed > 0) appendPanelLog('INFO', `已清理 ${removed} 个旧版本 woc 镜像`);
  } catch (e: any) {
    console.warn('[docker] 清理旧版本镜像失败（忽略）:', e?.message || e);
  }
  // 顺带清一次悬空层（删旧镜像后可能又暴露出无 tag 的中间层）
  await pruneDanglingImages();
}

// 清理悬空（dangling）镜像：升级后旧实例镜像失去 tag 变成 <none>，长期堆积吃磁盘
// （每层 1-2GB，多次升级后可观）。只删无 tag 且无容器引用的镜像，安全。best-effort。
export async function pruneDanglingImages(): Promise<void> {
  try {
    const res: any = await docker.pruneImages({ filters: { dangling: ['true'] } as any });
    const freed = Number(res?.SpaceReclaimed || 0);
    if (freed > 0) appendPanelLog('INFO', `已清理悬空镜像，释放 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } catch (e: any) {
    console.warn('[docker] 清理悬空镜像失败（忽略）:', e?.message || e);
  }
}

// 重置实例的设备 machine-id：删掉持久化的 .woc-machine-id 后重启，由 00-woc-identity 钩子重新生成
// 一个全新的唯一值（相当于"换一台新设备"）。用于某账号被腾讯风控标记后手动滚新设备身份。
// 仅对含身份钩子的新镜像有效；旧镜像（升级前）无钩子，先 throw 提示升级，避免做无用功。
export async function regenInstanceMachineId(inst: Instance): Promise<void> {
  const hasHook = (
    await execCapture(inst, [
      'sh',
      '-c',
      'test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no',
    ])
  ).trim();
  if (hasHook !== 'yes') {
    throw new Error('该实例运行的是旧镜像（无设备身份模块），请先「升级实例」后再重置设备 ID');
  }
  // 删除持久化文件；重启时钩子检测到缺失 → 生成新的唯一 machine-id 并写回卷
  await execCapture(inst, ['sh', '-c', 'rm -f /config/.woc-machine-id']);
  await stopInstance(inst);
  await runInstance(inst, { keepImage: true }); // 重置身份=恢复类操作，幂等：不隐式换镜像（R10）
}

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await docker.getContainer(inst.containerName).stop({ t: 5 } as any);
    appendInstanceLog(inst.id, '容器已停止');
  } catch {
    /* 已停止或不存在 */
  }
}

export async function removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
    await c.remove({ force: true });
  } catch {
    /* 容器可能已不存在 */
  }
  if (purgeVolume) {
    try {
      await removeVolumeWithData(inst.volumeName);
    } catch {
      /* 卷可能不存在 */
    }
    deleteInstanceLog(inst.id); // 彻底删除时一并清掉持久日志
  }
}

// 列出"未被任何容器引用的 woc-data-* 数据卷"。判定改为 docker 真实视角（不再仅看 store），
// 否则 Created 状态的"幽灵容器"会让卷被误判为孤儿，删除时撞 409（real-world issue：
// 早期 runInstance 启动失败漏清残留容器，留下 4 个 Created 容器各占一个卷名）。
export async function listOrphanVolumes(referencedVolumes: Set<string>): Promise<
  Array<{ name: string; createdAt?: string; sizeBytes?: number }>
> {
  // 容器视角：扫所有容器（含已停止 / Created），收集它们挂载的 woc-data-* 卷名
  const allContainers = await docker.listContainers({ all: true });
  const containerRefs = new Set<string>();
  for (const c of allContainers) {
    for (const m of c.Mounts || []) {
      if (typeof m.Name === 'string' && m.Name.startsWith('woc-data-')) containerRefs.add(m.Name);
    }
  }
  // 与 store 视角并集：取两者都未引用的卷
  const referenced = new Set<string>([...referencedVolumes, ...containerRefs]);

  const { Volumes } = (await (docker as any).listVolumes()) || { Volumes: [] };
  if (!Array.isArray(Volumes)) return [];
  return Volumes
    .filter((v: any) => typeof v?.Name === 'string' && v.Name.startsWith('woc-data-') && !referenced.has(v.Name))
    .map((v: any) => ({
      name: v.Name,
      createdAt: v.CreatedAt,
      // UsageData 仅在 docker engine 启用 -v size=true 时返回，常见情况下没有；缺失就不展示
      sizeBytes: typeof v?.UsageData?.Size === 'number' && v.UsageData.Size >= 0 ? v.UsageData.Size : undefined,
    }))
    .sort((a, b) => (a.createdAt && b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : 0));
}

// 显式删除一个数据卷（管理员清理孤儿卷用）。调用方负责确认它不被现存实例引用。
export async function removeVolume(name: string): Promise<void> {
  await removeVolumeWithData(name);
}

// 列出"残留的 woc-wx-* 容器"：在 docker 里存在但 store 没登记的（多为 runInstance 失败时
// 留下的 Created 状态容器，或用户手动 docker run 出来的）。给管理员一键清理。
export async function listOrphanContainers(
  knownContainerNames: Set<string>,
): Promise<Array<{ id: string; name: string; status: string; volumeName?: string }>> {
  const all = await docker.listContainers({ all: true });
  const out: Array<{ id: string; name: string; status: string; volumeName?: string }> = [];
  for (const c of all) {
    const name = (c.Names || []).map((n) => n.replace(/^\//, '')).find((n) => n.startsWith('woc-wx-'));
    if (!name) continue;
    if (knownContainerNames.has(name)) continue;
    const vol = (c.Mounts || []).map((m) => m.Name).find((n) => typeof n === 'string' && n.startsWith('woc-data-'));
    out.push({ id: c.Id, name, status: c.Status || c.State || '', volumeName: vol });
  }
  return out;
}

// 强制删除一个残留容器（按短/全 id 或容器名都行）。
export async function removeContainerById(idOrName: string): Promise<void> {
  await docker.getContainer(idOrName).remove({ force: true });
}

// 取实例容器的"working set"内存（MB）：等同 docker stats 显示值 = usage - inactive_file。
// 用于 watchdog 检测 KasmVNC/Xvnc 长跑泄漏（21 小时可涨到 ~9 GiB），无法读取时返回 0（视为"暂未知"，
// 不触发自愈，避免容器刚启动 stats 不可用就被误杀）。一次性 stats、不订阅 stream。
export async function instanceMemoryMB(inst: Instance): Promise<number> {
  try {
    const c = docker.getContainer(inst.containerName);
    const s: any = await c.stats({ stream: false } as any);
    const usage = Number(s?.memory_stats?.usage) || 0;
    const inactive = Number(
      s?.memory_stats?.stats?.inactive_file ?? s?.memory_stats?.stats?.total_inactive_file,
    ) || 0;
    const bytes = Math.max(0, usage - inactive);
    return Math.round(bytes / 1024 / 1024);
  } catch {
    return 0;
  }
}

// 响应性健康探测：实测发现容器跑久了会出现 I/O / 服务 stall —— 进程没死、面板显示"在线"，
// 但读不出 VNC 客户端静态文件（nginx 报 upstream timed out），浏览器永远卡在"正在连接桌面"。
// 这里带注入鉴权请求真正会卡的那条路径（/vnc/index.html，经 nginx→kclient 静态serve），
// 超时即判不健康。无鉴权时 nginx 直接 401（很快），故必须注入鉴权让请求真正打到 kclient 静态层。
export async function instanceHttpHealthy(inst: Instance, timeoutMs = 8000): Promise<boolean> {
  const auth = 'Basic ' + Buffer.from(`${inst.kasmUser}:${inst.kasmPassword}`).toString('base64');
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(
      {
        host: inst.containerName,
        port: 3000,
        path: '/vnc/index.html',
        headers: { authorization: auth },
        timeout: timeoutMs,
      },
      (res) => {
        // 拿到响应头即说明 nginx+kclient 静态serve 活着（健康时为 200）。读掉 body 释放连接。
        const ok = !!res.statusCode && res.statusCode < 500;
        res.resume();
        done(ok);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(false); // 超时 = stall，判不健康
    });
    req.on('error', () => done(false));
  });
}


export async function instanceRuntime(inst: Instance): Promise<RuntimeState> {
  try {
    const info = await docker.getContainer(inst.containerName).inspect();
    return info.State?.Running ? 'running' : 'stopped';
  } catch {
    return 'missing';
  }
}

// 实例容器本次已运行多少秒（State.StartedAt 起算）；没在跑 / 读不到时返回 null。
export async function instanceUptimeSec(inst: Instance): Promise<number | null> {
  try {
    const info = await docker.getContainer(inst.containerName).inspect();
    if (!info.State?.Running) return null;
    const t = Date.parse(String(info.State.StartedAt || ''));
    return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : null;
  } catch {
    return null;
  }
}

// 本地「最新实例镜像」的 Id（新建/升级实例会用到的镜像）。查不到（未拉取过）返回 null。
export async function latestInstanceImageId(): Promise<string | null> {
  try {
    const img: any = await docker.getImage(WECHAT_IMAGE).inspect();
    return String(img.Id);
  } catch {
    return null;
  }
}

// 实例是否「镜像落后」：其运行中容器的镜像 Id 与本地最新镜像不一致（即重建就会换新镜像）。
// 容器不存在 / 查不到最新镜像时返回 false（不打扰）。传入 latestId 复用一次查询，避免 N 次 inspect。
export async function instanceOutdated(inst: Instance, latestId: string | null): Promise<boolean> {
  if (!latestId) return false;
  try {
    const info: any = await docker.getContainer(inst.containerName).inspect();
    const cur = String(info.Image || '');
    return !!cur && cur !== latestId;
  } catch {
    return false; // 容器不存在（未创建/已删）→ 不算落后
  }
}

// 实例容器当前运行镜像的版本号（CI 打的 org.opencontainers.image.version label，如 "1.4.0"）。
// 本地自构建镜像无该 label → 返回镜像短 id（显示为"自构建 xxxx"级别信息）；容器不存在 → null。
// 背景（issue #112）：用户无从得知实例到底跑的哪版镜像，"以为升级了其实没有"无法自查。
export async function instanceImageVersion(inst: Instance): Promise<string | null> {
  try {
    const info: any = await docker.getContainer(inst.containerName).inspect();
    const imgId = String(info.Image || '');
    if (!imgId) return null;
    try {
      const img: any = await docker.getImage(imgId).inspect();
      const v = img?.Config?.Labels?.['org.opencontainers.image.version'];
      if (v) return String(v);
    } catch {
      /* 镜像记录不可读（containerd 快照残留），退回短 id */
    }
    return imgId.replace(/^sha256:/, '').slice(0, 12);
  } catch {
    return null;
  }
}

// ---------- 远端实例镜像新版检测 ----------
// 盲区背景：instanceOutdated 只比「容器镜像 vs 本地镜像」。用户更新面板后，本地实例镜像
// 往往还是旧的（没人主动 pull）→ 检测恒为"无可升级"→ 升级引导永远不出现。这里用 registry
// manifest digest（HEAD 请求，不下载）对比本地镜像的 RepoDigests，判断远端是否有新版。
// best-effort：离线/被墙/私有源 → null（未知，不打扰）；本地自构建镜像（无 RepoDigests）→ null。
let remoteImageCache: { val: boolean | null; at: number } = { val: null, at: 0 };
let remoteImageInflight: Promise<void> | null = null;
export function invalidateRemoteImageCache(): void {
  remoteImageCache = { val: null, at: 0 };
}
// 同步返回缓存值（可能 null=未知），过期时后台刷新——upgrade-status 是管理页高频接口，不能被 8s 外呼拖住。
export function remoteInstanceImageNewer(): boolean | null {
  const TTL = 30 * 60 * 1000;
  if (Date.now() - remoteImageCache.at >= TTL && !remoteImageInflight) {
    remoteImageInflight = checkRemoteImageNewer()
      .then((v) => {
        remoteImageCache = { val: v, at: Date.now() };
      })
      .catch(() => {
        remoteImageCache = { val: null, at: Date.now() };
      })
      .finally(() => {
        remoteImageInflight = null;
      });
  }
  return remoteImageCache.at ? remoteImageCache.val : null;
}

async function checkRemoteImageNewer(): Promise<boolean | null> {
  const ref = parseImageRef(WECHAT_IMAGE);
  if (!ref) return null;
  let local: any;
  try {
    local = await docker.getImage(WECHAT_IMAGE).inspect();
  } catch {
    // 本地没有该镜像。版本耦合后这是常态：面板刚自更新到 vX，本地还只有旧版镜像、没有 :vX 的 tag。
    // 远端确实存在该镜像 → 视为「有新版可拉取」，让升级引导亮起（一键升级会先拉取）。
    // 连不上（unreachable）→ null=未知，不打扰；确认不存在（missing）→ 也没得升，null。
    const probe = await probeManifest(ref);
    return probe.ok ? true : null;
  }
  const repoDigests: string[] = local.RepoDigests || [];
  if (!repoDigests.length) return null; // 本地自构建（无 registry 来源）→ 无从比较，不打扰
  const probe = await probeManifest(ref);
  if (!probe.ok) return null; // 未知/不存在 → 不打扰
  return !repoDigests.some((d) => d.endsWith('@' + probe.digest));
}

// 解析镜像引用 → { registry, repo, tag }。例：docker.io/gloridust/wechat-on-cloud:latest。
function parseImageRef(image: string): { registry: string; repo: string; tag: string } | null {
  const noDigest = image.split('@')[0];
  const segs = noDigest.split('/');
  let registry = 'docker.io';
  if (segs.length > 1 && (segs[0].includes('.') || segs[0].includes(':'))) registry = segs.shift() as string;
  let last = segs[segs.length - 1] || '';
  let tag = 'latest';
  const ti = last.lastIndexOf(':');
  if (ti > 0) {
    tag = last.slice(ti + 1);
    segs[segs.length - 1] = last.slice(0, ti);
  }
  const repo = segs.join('/');
  return repo ? { registry, repo, tag } : null;
}

async function fetchJsonWithTimeout(url: string, headers: Record<string, string>, ms = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// 探测 registry 上该 tag 是否存在及其 manifest digest。
// 关键（issue #114）：必须把「仓库确认没有(404)」与「连不上仓库(网络/超时/鉴权失败)」分开——
// 前者才能据以回退，后者只是未知，不能当作"不存在"（否则受限网络用户会被误判、回退到过期的 :latest）。
type ManifestProbe = { ok: true; digest: string } | { ok: false; reason: 'missing' | 'unreachable' };

async function probeManifest(ref: { registry: string; repo: string; tag: string }): Promise<ManifestProbe> {
  const accept =
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';
  let host = ref.registry;
  let token = '';
  try {
    if (ref.registry === 'docker.io') {
      host = 'registry-1.docker.io';
      const d = await fetchJsonWithTimeout(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ref.repo}:pull`,
        {},
      );
      token = d?.token || '';
    } else if (ref.registry === 'ghcr.io') {
      const d = await fetchJsonWithTimeout(`https://ghcr.io/token?service=ghcr.io&scope=repository:${ref.repo}:pull`, {});
      token = d?.token || '';
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      // HEAD 即可拿 Docker-Content-Digest（不下载 manifest 本体）
      const res = await fetch(`https://${host}/v2/${ref.repo}/manifests/${ref.tag}`, {
        method: 'HEAD',
        headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: ctrl.signal,
      });
      // 404 = 仓库明确回答"没有这个 tag"；其它非 2xx（401/5xx…）当作不可达，不敢断言不存在。
      if (res.status === 404) return { ok: false, reason: 'missing' };
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      const digest = res.headers.get('docker-content-digest');
      return digest ? { ok: true, digest } : { ok: false, reason: 'unreachable' };
    } finally {
      clearTimeout(t);
    }
  } catch {
    // 网络错误 / 超时 / 取 token 失败 → 未知，不是"不存在"
    return { ok: false, reason: 'unreachable' };
  }
}

// 创建 exec 实例。容器 init 未完成时，linuxserver 基镜像的 'abc' 用户可能还没建好，docker 会以
// 400「unable to find user abc: no matching entries in passwd file」直接拒绝创建 exec（见 issue #74）。
// 对这种"用户未就绪"错误短暂重试，给容器 init 一点时间；超时则抛清晰的中文错误，而非透传难懂的 docker 400。
async function execCreate(c: any, opts: any): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < 8; i++) {
    try {
      return await c.exec(opts);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!/no matching entries in passwd|unable to find user/i.test(msg)) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`容器仍在初始化（桌面用户未就绪），请等待约十几秒后重试（${lastErr?.message || lastErr}）`);
}

// 在实例容器内执行命令，返回 stdout；若命令失败，把 stderr 透出给调用方。
async function execCapture(inst: Instance, cmd: string[], user = 'abc'): Promise<string> {
  return execCaptureIn(docker.getContainer(inst.containerName), cmd, user);
}

// 同上，在任意容器里执行（整卷恢复要在临时辅助容器里执行）
async function execCaptureIn(c: any, cmd: string[], user: string): Promise<string> {
  const exec = await execCreate(c, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: user });
  const stream = await exec.start({ hijack: true, stdin: false });
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const stdout = { write: (b: Buffer) => { out += b.toString('utf8'); } } as any;
    const stderr = { write: (b: Buffer) => { err += b.toString('utf8'); } } as any;
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on('end', async () => {
      try {
        const info = await exec.inspect();
        if (info.ExitCode && info.ExitCode !== 0) {
          reject(new Error((err || out || `命令执行失败，退出码 ${info.ExitCode}`).trim()));
          return;
        }
        resolve(out || err);
      } catch (e) {
        reject(e);
      }
    });
    stream.on('error', reject);
  });
}

// 触发下载/安装（detached，立即返回，后台下载）。按实例 appType 分发：app-ctl.sh wechat → 委托回
// wechat-ctl.sh；telegram 等各自实现。兼容旧容器（升级前镜像里没有 /woc/app-ctl.sh）：有则用之，无则
// 回退老的 wechat-ctl.sh（旧实例都是微信）。appType 取值受 instanceAppType 约束，可安全内插进 shell。
export async function triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
  const c = docker.getContainer(inst.containerName);
  const at = instanceAppType(inst);
  const action = cmd === 'update' ? 'update' : 'install';
  const exec = await execCreate(c, {
    Cmd: ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`],
    AttachStdout: false,
    AttachStderr: false,
    User: 'abc',
  });
  const at0 = Math.floor(Date.now() / 1000); // 先取时间再启动：脚本写的状态都不会早于它
  await exec.start({ Detach: true });
  installTriggeredAt.set(inst.id, at0);
}

export interface WechatStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

const DEFAULT_STATUS: WechatStatus = { phase: 'idle', percent: 0, installed: false, version: '', message: '未安装', updatedAt: 0 };

// 下载安装 / 更新的结果写进面板日志和实例日志。此前面板日志只有「触发下载安装应用」一句，失败原因只显示在卡片上，
// 事后排查无从看起（#153）。面板触发过安装、之后读到的状态是触发以后写的「完成 / 失败」，就记一次：
// 被拒这类失败一两秒就结束，等不到面板下一次轮询，不能靠「看到进行中再看到结束」来判断。
export const BUSY_PHASES = new Set(['downloading', 'extracting', 'installing']);
const installTriggeredAt = new Map<string, number>(); // 实例 id → 触发安装的时间（秒，和状态文件的 updatedAt 同一时钟）
function noteAppStatus(inst: Instance, st: WechatStatus): void {
  const since = installTriggeredAt.get(inst.id);
  if (since === undefined || BUSY_PHASES.has(st.phase) || !(st.updatedAt >= since)) return;
  installTriggeredAt.delete(inst.id);
  if (st.phase === 'done') {
    const v = st.version ? `（版本 ${st.version}）` : '';
    appendPanelLog('INFO', `实例「${inst.name}」(id=${inst.id}) 应用安装完成${v}`);
    appendInstanceLog(inst.id, `应用安装完成${v}`);
  } else if (st.phase === 'error') {
    appendPanelLog('WARN', `实例「${inst.name}」(id=${inst.id}) 应用安装失败：${st.message}`);
    appendInstanceLog(inst.id, `应用安装失败：${st.message}（每一步的详情见诊断包里的 install.log）`);
  }
}

export async function wechatStatus(inst: Instance): Promise<WechatStatus> {
  try {
    // 兼容旧容器（无 /woc/app-ctl.sh）：有则按 appType 取状态，无则回退老的 wechat-ctl.sh（旧实例皆微信）。
    const at = instanceAppType(inst);
    const raw = await execCapture(inst, [
      'bash',
      '-c',
      `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} status; else /woc/wechat-ctl.sh status; fi`,
    ]);
    const st: WechatStatus = { ...DEFAULT_STATUS, ...JSON.parse(raw.trim()) };
    noteAppStatus(inst, st);
    return st;
  } catch {
    return DEFAULT_STATUS;
  }
}

// 拉取微信镜像（首次部署/更新镜像用）。
// 并发合并：创建实例/单实例升级/一键升级可能同时触发拉取，同一时刻只跑一个（后来者共享结果；
// 其 onProgress 不再接收进度，可接受——进度只影响创建向导的百分比显示）。
let pullInFlight: Promise<void> | null = null;
export function pullImage(onProgress?: (line: any) => void): Promise<void> {
  if (pullInFlight) return pullInFlight;
  pullInFlight = doPullImage(onProgress).finally(() => {
    pullInFlight = null;
    invalidateRemoteImageCache(); // 本地镜像可能已更新 → 远端新版检测缓存作废
  });
  return pullInFlight;
}

async function doPullImage(onProgress?: (line: any) => void): Promise<void> {
  // 无进度超时：NAS 直连 docker.io 常卡死（拉取流僵住、永不结束），旧版会让"创建实例"请求无限 hang，
  // 前端一直转圈、还删不掉（issue #99）。这里只要 N 分钟内没有任何进度就中止拉取，让创建带清晰错误快速失败、
  // 用户可重试/删除。默认 5 分钟，WOC_PULL_STALL_MIN 可调。
  const STALL_MS = 1000 * 60 * Math.max(2, Number(process.env.WOC_PULL_STALL_MIN) || 5);
  return await new Promise((resolve, reject) => {
    docker.pull(WECHAT_IMAGE, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (e: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        e ? reject(e) : resolve();
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            (stream as any).destroy?.();
          } catch {
            /* ignore */
          }
          finish(new Error(`拉取镜像 ${Math.round(STALL_MS / 60000)} 分钟无进度，判定网络卡死并中止（建议配置国内镜像源或预拉取，详见 README）`));
        }, STALL_MS);
      };
      arm();
      docker.modem.followProgress(
        stream,
        (e: any) => finish(e),
        (ev: any) => {
          arm(); // 每有进度就重置超时
          onProgress?.(ev);
        },
      );
    });
  });
}

// ---------- 文件中转（上传/下载） ----------
// 中转目录 = abc 家目录下的 Desktop（/config 持久卷）。上传落这里，微信文件选择器可直接选到；
// 反向：把微信收到的文件另存到桌面，即可在面板里下载。
const TRANSFER_DIR = '/config/Desktop';

// ---------- 诊断包 ----------
// 多文件 tar.gz（内存构建；诊断包通常仅数 MB）。
function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  return zlib.gzipSync(tarArchive(entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')))));
}

// 汇总诊断包：系统信息 + 面板全局日志 + 每个实例（容器状态 + 持久日志 + 实时日志）+ 全部 woc-* 容器清单。
// 日志按 sinceMs 时间裁剪。给排查"首个实例创建卡死 / 打开实例黑屏不可用 / 升级失败"等问题用。
export async function buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer> {
  const entries: { name: string; content: string | Buffer }[] = [];
  const stamp = new Date().toISOString();

  entries.push({
    name: 'README.txt',
    content: [
      '云微 · WechatOnCloud 诊断包',
      `生成时间: ${stamp}`,
      `时间范围: 最近 ${meta.range || '24h'}`,
      '',
      '内容：',
      '  system.txt        系统/Docker/镜像信息',
      '  panel.log         面板全局运维日志（创建/删除/升级/启停/镜像拉取/错误）',
      '  containers.txt    所有 woc-* 容器清单（含残留/未登记）',
      '  instances/<id>.log 每个实例：容器状态 + 持久日志 + 应用安装状态/日志 + 实时容器日志',
      '',
      '把本压缩包发给维护者即可协助排查（不含密码/密钥等敏感信息）。',
    ].join('\n'),
  });

  // 系统信息
  let sys = `生成时间: ${stamp}\n时间范围: 最近 ${meta.range || '24h'}\n\n`;
  for (const [k, v] of Object.entries(meta)) sys += `${k}: ${v}\n`;
  try {
    const ver: any = await docker.version();
    sys += `\nDocker 版本: ${ver.Version} (API ${ver.ApiVersion}, ${ver.Os}/${ver.Arch})\n`;
  } catch (e: any) {
    sys += `\nDocker 版本: 获取失败 ${e?.message || e}\n`;
  }
  try {
    const info: any = await docker.info();
    sys += `容器: ${info.Containers}（运行 ${info.ContainersRunning}） · 镜像: ${info.Images}\n`;
    sys += `内核: ${info.KernelVersion} · OS: ${info.OperatingSystem} · 架构: ${info.Architecture}\n`;
    sys += `CPU: ${info.NCPU} 核 · 内存: ${(info.MemTotal / 1073741824).toFixed(1)} GiB · 内存限制支持: ${info.MemoryLimit ? '是' : '否'} · Swap限制支持: ${info.SwapLimit ? '是' : '否'}\n`;
    // cgroup / 存储 / 安全选项：排查 Ubuntu server 上的内存限制不生效、apparmor/userns 限制、seccomp 等宿主级问题。
    sys += `cgroup: v${info.CgroupVersion ?? '?'}/${info.CgroupDriver ?? '?'} · 存储驱动: ${info.Driver}\n`;
    if (Array.isArray(info.SecurityOptions) && info.SecurityOptions.length)
      sys += `安全选项: ${info.SecurityOptions.map((o: string) => o.replace(/^name=/, '')).join(', ')}\n`;
    if (Array.isArray(info.Warnings) && info.Warnings.length) sys += `Docker 警告: ${info.Warnings.join('; ')}\n`;
  } catch (e: any) {
    sys += `Docker info: 获取失败 ${e?.message || e}\n`;
  }
  try {
    const img: any = await docker.getImage(WECHAT_IMAGE).inspect();
    sys += `\n实例镜像 ${WECHAT_IMAGE}: ${String(img.Id).slice(0, 19)} · 创建 ${img.Created}\n`;
  } catch {
    sys += `\n实例镜像 ${WECHAT_IMAGE}: 本地不存在（首次新建实例需联网拉取，可能在此卡住）\n`;
  }
  // 面板侧实例资源配置（排查内存：默认不设 docker 硬上限时，单实例涨太大会被宿主内核 OOM-killer 杀，
  // 在小内存 Ubuntu server 上尤其常见，表现为黑屏/502/反复重启）。
  sys += `\n面板实例配置: SHM=${(SHM_SIZE / 1073741824).toFixed(0)}GiB`;
  sys += ` · docker硬内存上限=${INSTANCE_MEM > 0 ? (INSTANCE_MEM / 1073741824).toFixed(1) + 'GiB' : '未设(不限，靠宿主 OOM 兜底)'}`;
  sys += ` · GPU=${ENABLE_GPU ? '开' : '关(软件渲染)'}\n`;
  sys += `内存自愈阈值(MiB): soft=${process.env.WOC_INSTANCE_MEM_SOFT_MB || '1500'} · hard=${process.env.WOC_INSTANCE_MEM_HARD_MB || '2500'}\n`;
  sys += `\n实例数: ${instances.length}\n`;
  entries.push({ name: 'system.txt', content: sys });

  // 面板全局日志（按范围裁剪）
  entries.push({ name: 'panel.log', content: filterSince(readPanelLog(), sinceMs) || '（无面板日志）' });

  // 每个实例
  for (const inst of instances) {
    let c = `实例: ${inst.name}\nID: ${inst.id}\n容器: ${inst.containerName}\n类型: ${instanceAppType(inst)}\n数据卷: ${inst.volumeName}（${await describeInstanceVolume(inst.volumeName)}）\n创建: ${inst.createdAt}\n\n`;
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      const s = info.State || {};
      c += `===== 容器状态 =====\n运行: ${s.Running} · 状态: ${s.Status} · 退出码: ${s.ExitCode}\n`;
      c += `OOMKilled: ${s.OOMKilled} · 重启次数: ${info.RestartCount} · 启动于: ${s.StartedAt}\n`;
      if (s.Error) c += `错误: ${s.Error}\n`;
      // 实时内存占用：配合宿主总内存/OOMKilled 一眼判断是不是内存不足（小内存 server 的高频成因）。
      if (s.Running) {
        try {
          const mem = await instanceMemoryMB(inst);
          if (mem > 0) c += `当前内存占用: ${mem} MiB\n`;
        } catch {
          /* stats 偶发不可用，忽略 */
        }
      }
      c += `镜像: ${String(info.Image).slice(0, 19)} · 健康: ${s.Health?.Status ?? 'n/a'}\n\n`;
    } catch (e: any) {
      c += `===== 容器状态 =====\n无法读取（容器可能未创建/已删除）：${e?.message || e}\n\n`;
    }
    c += `===== 持久化日志（最近 ${meta.range || '24h'}） =====\n${filterSince(readInstanceLog(inst.id), sinceMs) || '（无）'}\n\n`;
    // 应用安装状态 + 安装日志：排查「下载卡住/装不上」（此前诊断包里完全看不到安装为何失败）。
    // status.json = 面板轮询的进度/错误；install.log = wechat-ctl.sh 下载/解压每步（含 curl 退出码、已下字节）。
    try {
      // `|| true`：文件不存在时 cat/tail 会以非 0 退出，execCapture 视作失败抛错——加 || true 保证退出 0，
      // 拿到空串走下面的「（无）」分支，不因"还没装/旧镜像无日志"就整段丢失。
      const st = (await execCapture(inst, ['sh', '-c', 'cat /config/.woc-state/status.json 2>/dev/null || true'])).trim();
      c += `===== 应用安装状态（status.json） =====\n${st || '（无 / 尚未触发安装）'}\n\n`;
      const il = (await execCapture(inst, ['sh', '-c', 'tail -n 50 /config/.woc-state/install.log 2>/dev/null || true'])).trimEnd();
      c += `===== 安装日志（install.log 尾 50 行） =====\n${il || '（无 / 旧镜像未记录）'}\n\n`;
    } catch (e: any) {
      c += `===== 应用安装状态 / 安装日志 =====\n获取失败（容器可能未运行）：${e?.message || e}\n\n`;
    }
    try {
      c += `===== 本次容器日志（实时 tail 300） =====\n${(await instanceLogs(inst, 300)).trimEnd() || '（无）'}\n`;
    } catch (e: any) {
      c += `===== 本次容器日志 =====\n获取失败：${e?.message || e}\n`;
    }
    entries.push({ name: `instances/${inst.id}.log`, content: c });
  }

  // 全部 woc-* 容器清单（含未登记/残留，用于诊断"首次创建失败遗留"）
  try {
    const all = await docker.listContainers({ all: true });
    const known = new Set(instances.map((i) => i.containerName));
    let txt = '所有 woc-* 容器：\n\n';
    for (const ct of all) {
      const names = (ct.Names || []).map((n: string) => n.replace(/^\//, ''));
      if (!names.some((n) => n.startsWith('woc-'))) continue;
      const nm = names.join(',');
      const tag = nm.includes('woc-panel') ? '面板' : known.has(nm) ? '已登记实例' : '未登记/残留';
      txt += `[${tag}] ${nm} · ${ct.State}/${ct.Status} · ${ct.Image}\n`;
    }
    entries.push({ name: 'containers.txt', content: txt });
  } catch (e: any) {
    entries.push({ name: 'containers.txt', content: '获取失败：' + (e?.message || e) });
  }

  return buildTarGz(entries);
}

// 校验文件名为安全 basename（防路径穿越）。长度按字节算：Linux 文件名上限 255 字节，一个汉字占 3 字节。
function safeName(name: string): boolean {
  return !!name && Buffer.byteLength(name, 'utf8') <= 255 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}
function assertSafeName(name: string): void {
  if (Buffer.byteLength(name || '', 'utf8') > 255) throw new Error('文件名太长（最多 255 字节，约 85 个汉字），请改短后再上传');
  if (!safeName(name)) throw new Error('文件名不合法');
}

// 壁纸/字体文件名：在 safeName 基础上，额外拒绝 shell 元字符。这些名字会被拼进 `sh -c '...${name}...'`
// （xwallpaper/fc-scan 等），拒绝 ' " $ ` \ ; & | < > 及换行后，单引号内插值不可能被逃逸/注入，正常文件名
//（含空格/括号/中文）仍放行。
function safeMediaName(name: string): boolean {
  return safeName(name) && !/['"$`\\;&|<>\r\n]/.test(name);
}

// ---------- 流式写入单个文件 ----------
// 边收边打成 tar 交给 docker，面板内存不随文件大小增长。先写到 /config/.woc-upload 下的临时名，完整收到后才改名到
// 目标位置：上传中途断开（关页面、断网、取消）时 docker 已经写下了半截文件，此前这个半截文件就顶着正式文件名留在
// 桌面上，看着和正常文件一样，发出去才发现打不开。临时目录与目标同在 /config 卷上，改名是原子操作。
const UPLOAD_TMP_DIR = '/config/.woc-upload';

// putArchive 的响应体是空的，读掉以释放连接
async function putArchiveStream(inst: Instance, tar: NodeJS.ReadableStream, path: string): Promise<void> {
  await putArchiveTo(docker.getContainer(inst.containerName), tar, path);
}
async function putArchiveTo(c: any, tar: NodeJS.ReadableStream, path: string): Promise<void> {
  const res: any = await c.putArchive(tar, { path });
  if (res && typeof res.resume === 'function') res.resume();
}

// 目标所在磁盘的可用空间（字节）；查不到返回 null（不拦）
async function freeBytesIn(inst: Instance, dir: string): Promise<number | null> {
  try {
    const out = await execCapture(inst, ['df', '-Pk', dir]);
    const kb = Number(out.trim().split('\n').pop()?.trim().split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

async function assertFreeSpace(inst: Instance, dir: string, need: number): Promise<void> {
  const free = await freeBytesIn(inst, dir);
  if (free !== null && need + 64 * 1024 ** 2 > free) {
    throw Object.assign(new Error(`实例数据盘空间不足：需要 ${fmtBytes(need)}，只剩 ${fmtBytes(free)}`), { statusCode: 507 });
  }
}

// docker / 命令行的英文报错翻成能看懂的
function friendlyWriteError(e: any): Error {
  const msg = String(e?.message || e);
  if (/no space left on device/i.test(msg)) return Object.assign(new Error('实例数据盘空间不足，文件没能写完'), { statusCode: 507 });
  if (/is not running|container .* is restarting/i.test(msg)) return new Error('实例未运行，请先启动实例');
  if (/cannot overwrite directory|Is a directory/i.test(msg)) return new Error('目标位置已有同名文件夹');
  if (/File name too long/i.test(msg)) return new Error('文件名太长');
  // 解包时某个路径建不出来（比如包里的链接指向不存在的位置），docker 报的是这句，看不出原因
  if (/Could not find the file/i.test(msg)) return new Error('包里有写不进去的路径（比如链接指向了不存在的位置），写到一半中断了');
  return e instanceof Error ? e : new Error(msg);
}

async function putFileStream(inst: Instance, dir: string, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  assertSafeName(name);
  await execCapture(inst, ['mkdir', '-p', dir, UPLOAD_TMP_DIR]).catch((e) => {
    throw friendlyWriteError(e);
  });
  // 顺手清掉面板被重启等情况下没来得及删的临时文件；正在写的临时文件 mtime 一直在刷新，不会误删
  await execCapture(inst, ['find', UPLOAD_TMP_DIR, '-maxdepth', '1', '-type', 'f', '-mmin', '+180', '-delete'], 'root').catch(() => {});
  await assertFreeSpace(inst, UPLOAD_TMP_DIR, size);
  const tmp = `${UPLOAD_TMP_DIR}/part-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const tar = tarFileStream(tmp.slice(UPLOAD_TMP_DIR.length + 1), size, body);
  try {
    await putArchiveStream(inst, tar, UPLOAD_TMP_DIR);
    await execCapture(inst, ['mv', '-fT', '--', tmp, `${dir}/${name}`], 'root');
  } catch (e) {
    tar.destroy();
    await execCapture(inst, ['rm', '-f', '--', tmp], 'root').catch(() => {});
    throw friendlyWriteError(e);
  }
}

export async function uploadToInstance(inst: Instance, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  await putFileStream(inst, TRANSFER_DIR, name, size, body);
}

// QQ 手动上传的安装包（#153）：写到 app-ctl.sh 约定的位置，随后触发安装时它先装这个包（核对包名和架构，装完删掉）
export async function uploadAppPackage(inst: Instance, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  await putFileStream(inst, '/config/.woc-dl', 'qq-upload.deb', size, body);
}

export interface TransferFile {
  name: string;
  size: number;
  mtime: number; // 秒级 Unix 时间
}
export async function listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    'sh',
    '-c',
    `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\t%T@\\n' 2>/dev/null`,
  ]);
  // 按修改时间倒序：最常见的用法是「刚在微信里另存到桌面 → 马上来下载」，最新的应在最上面。
  // （此前是 find 的目录原始顺序，文件一多就得在乱序列表里找。）
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, size, mtime] = line.split('\t');
      return { name, size: Number(size) || 0, mtime: Math.round(Number(mtime) || 0) };
    })
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

export async function deleteInstanceFile(inst: Instance, name: string): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  // argv 数组直传，不经 shell；safeName 已排除路径穿越
  await execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
}

// 以流的形式读出容器里的一个普通文件，不整个读进内存。微信收到的视频、文件动辄几百 MB 到 GB，此前先把整个 tar 读进
// 内存再解出文件，面板进程峰值约为文件大小的两倍，NAS 上容易被 OOM 杀掉，所有人的桌面跟着断。
// 走 docker exec cat：输出按 docker 的 stdout/stderr 分帧，这里自己拆帧，并在下游写不动时暂停读取（慢速客户端不在内存里堆积）。
// 先 stat：只放行普通文件（不跟随符号链接，与 getArchive 一致），出错能在发出响应头之前报。
export async function streamRegularFile(inst: Instance, absPath: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const st = await execCapture(inst, ['stat', '-c', '%F|%s', '--', absPath], 'root').catch(() => '');
  if (!st) throw new Error('文件不存在或已被删除');
  const [kind, size] = st.trim().split('|');
  if (kind !== 'regular file' && kind !== 'regular empty file') throw new Error('不是普通文件');
  const exec = await execCreate(docker.getContainer(inst.containerName), {
    Cmd: ['cat', '--', absPath],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'root',
  });
  const raw = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream & { destroy?: () => void };
  const out = new PassThrough();
  let buf: Buffer = Buffer.alloc(0);
  let need = 0; // 当前帧还剩多少字节
  let type = 0; // 1 = stdout，2 = stderr
  raw.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (need === 0) {
        if (buf.length < 8) break;
        type = buf[0];
        need = buf.readUInt32BE(4);
        buf = buf.subarray(8);
        continue;
      }
      if (!buf.length) break;
      const part = buf.subarray(0, need);
      buf = buf.subarray(part.length);
      need -= part.length;
      if (type === 1 && !out.write(part)) {
        raw.pause();
        out.once('drain', () => raw.resume());
      }
    }
  });
  raw.on('end', () => out.end());
  raw.on('error', (e) => out.destroy(e as Error));
  out.on('close', () => raw.destroy?.()); // 客户端中途断开：停掉 cat
  return { size: Number(size) || 0, stream: out };
}

export async function downloadFromInstance(inst: Instance, name: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  if (!safeName(name)) throw new Error('文件名不合法');
  return streamRegularFile(inst, `${TRANSFER_DIR}/${name}`);
}

// 从 docker getArchive 返回的 tar 中取出第一个普通文件的内容。Docker(Go archive/tar) 在 mtime 含纳秒精度等
// 情况下会先写一个 PAX 扩展头块（typeflag 'x'），把它误当文件头会读到扩展记录长度 → 返回错误长度的数据
// （"大小不对"）。这里跳过 PAX/全局('x'/'g')与 GNU 长名('L'/'K')等扩展头，找到普通文件('0'/NUL)再取内容。
function extractSingleFileFromTar(tar: Buffer): Buffer {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break; // 归档结束（全零块）
    const sizeStr = header.toString('ascii', 124, 136).replace(/[^0-7]/g, '');
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = header[156]; // '0'(0x30) 或 NUL(0) = 普通文件
    const dataStart = off + 512;
    if (typeflag === 0x30 || typeflag === 0) {
      return tar.subarray(dataStart, dataStart + size);
    }
    // 扩展头/目录等：跳过其数据块（向上对齐 512）后继续
    off = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return Buffer.alloc(0);
}

// 拉取实例容器日志（末尾 N 行），供前端"查看/导出日志"排错。
export async function instanceLogs(inst: Instance, tail = 600): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const buf = (await c.logs({ stdout: true, stderr: true, tail, timestamps: true })) as unknown as Buffer;
  // docker 非 TTY 日志为多路复用流：每帧 8 字节头（[stream,0,0,0,size BE]）+ 负载；解出纯文本。
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (size < 0 || i + 8 + size > buf.length) break;
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out || buf.toString('utf8'); // 兜底：TTY 模式非多路复用
}

// ---------- 持久化日志 ----------
// 日志原语（appendInstanceLog / readInstanceLog / deleteInstanceLog / appendPanelLog 等）已抽到 logs.ts
// （无 docker 依赖，避免循环）。这里只保留需要 docker 的快照能力。

// 把"即将被删/重建"的容器最后日志快照进持久日志（否则随容器删除丢失）。
export async function snapshotContainerLog(inst: Instance, reason: string): Promise<void> {
  try {
    const logs = (await instanceLogs(inst, 200)).trimEnd();
    appendInstanceLog(inst.id, `──── ${reason} ────\n${logs}\n──── 上一容器日志快照结束 ────`);
  } catch {
    /* 容器可能已不可读，忽略 */
  }
}

// 在实例 X 桌面里跑命令的公共开头：定位 DISPLAY，确认镜像里有 xclip / xdotool。
// 服务端按键一律「先松开 xdotool 自己按住的修饰键，再按」，不用 --clearmodifiers（#151）。
// --clearmodifiers 会在按键前松开当前按着的修饰键、按完再「恢复」。用户按 Ctrl+V 粘贴时，粘贴桥截下 V、服务端替他按
// Ctrl+V，这时用户往往还按着 Ctrl：xdotool 按完后用它自己的虚拟键盘（XTEST）把 Ctrl 按回去，而用户松手是从 VNC 键盘
// 来的，XTEST 这边的 Ctrl 就一直按着。下一次 xdotool 再按 Ctrl 被当成重复按键吞掉，应用收到的是光秃秃的 v——
// 实测粘完图片接着打中文，发出去的是「v」。先 keyup 一遍既能清掉这种残留（包括旧版本留下的），又不会再按回去。
const XDO_RELEASE_MODS = 'xdotool keyup Control_L Control_R Shift_L Shift_R Alt_L Alt_R Meta_L Meta_R Super_L Super_R ISO_Level3_Shift';
const xdoKey = (key: string) => `${XDO_RELEASE_MODS}\nxdotool key ${key}`;

const X_PRELUDE = [
  'set -e',
  'display="${DISPLAY:-}"',
  'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
  'export DISPLAY="${display:-:1}"',
  'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
  'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
];

// ---------- 打字借用剪贴板，打完归还 ----------
// typeInInstance 靠「写容器剪贴板 + Ctrl+V」把文字贴进应用，副作用是容器剪贴板被换成刚打的字，KasmVNC 的无缝剪贴板
// 还会把它同步到用户本机剪贴板。实测：本机复制一个链接 → 进桌面打「看看」→ 本机、容器剪贴板都成了「看看」→
// Ctrl+V 贴出「看看」，链接没了；在应用里复制一条消息、打几个字再粘贴也一样。
// 做法：一轮打字的第一段先把容器剪贴板存下（只存一种最常用的格式：图片 > 文件列表 > 文字，应用私有格式还原不了），
// 最后一段打完 1 秒后，若剪贴板仍是我们放进去的字就原样放回；这期间用户自己复制了别的，就不动。
// 经面板按的 Ctrl+V（粘贴桥）会先立刻归还再粘贴；有意写入新内容的粘贴（本机图片 / 本机文字）则直接作废存档。
const CLIP_DIR = '/tmp/.woc-clip';
const CLIP_RESTORE_MS = 1000;
const CLIP_SAVE = `D=${CLIP_DIR}; mkdir -p "$D"
if [ ! -e "$D/saved.type" ] || [ $(( $(date +%s) - $(stat -c %Y "$D/saved.type") )) -gt 20 ]; then
  rm -f "$D"/saved.*; ty=none
  tg=$(timeout 1 xclip -o -selection clipboard -t TARGETS 2>/dev/null || true)
  for t in image/png text/uri-list x-special/gnome-copied-files UTF8_STRING text/plain STRING; do
    if printf '%s\\n' "$tg" | grep -qxF "$t"; then ty=$t; break; fi
  done
  if [ "$ty" != none ] && ! timeout 2 xclip -o -selection clipboard -t "$ty" > "$D/saved.data" 2>/dev/null; then ty=none; fi
  echo "$ty" > "$D/saved.type"
else
  touch "$D/saved.type"
fi`;
const CLIP_RESTORE = `D=${CLIP_DIR}
[ -e "$D/saved.type" ] || exit 0
ty=$(cat "$D/saved.type")
cur=$(timeout 1 xclip -o -selection clipboard -t UTF8_STRING 2>/dev/null || true)
if [ "$ty" != none ] && [ -e "$D/typed.txt" ] && [ "$cur" = "$(cat "$D/typed.txt")" ]; then
  xclip -selection clipboard -t "$ty" -i "$D/saved.data" >/dev/null 2>&1
fi
rm -f "$D"/saved.* "$D/typed.txt"`;
const CLIP_DISCARD = `rm -f ${CLIP_DIR}/saved.* ${CLIP_DIR}/typed.txt`;

// 同一实例的剪贴板操作（打字 / 归还 / 粘贴）串行执行，免得归还插在两段打字之间
const clipChains = new Map<string, Promise<unknown>>();
function withClipLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (clipChains.get(id) || Promise.resolve()).then(fn, fn);
  clipChains.set(id, run.catch(() => undefined));
  return run;
}
const clipTimers = new Map<string, ReturnType<typeof setTimeout>>();
function cancelClipRestore(id: string): boolean {
  const t = clipTimers.get(id);
  if (!t) return false;
  clearTimeout(t);
  clipTimers.delete(id);
  return true;
}
async function restoreClipboard(inst: Instance): Promise<void> {
  await execCapture(inst, ['bash', '-c', [...X_PRELUDE, CLIP_RESTORE].join('\n')]).catch(() => {});
}
function scheduleClipRestore(inst: Instance): void {
  cancelClipRestore(inst.id);
  const t = setTimeout(() => {
    clipTimers.delete(inst.id);
    void withClipLock(inst.id, () => restoreClipboard(inst));
  }, CLIP_RESTORE_MS);
  t.unref?.();
  clipTimers.set(inst.id, t);
}

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 写入剪贴板后 xdotool 模拟 Ctrl+V 粘贴；剪贴板打完归还（见上）。
export async function typeInInstance(inst: Instance, text: string): Promise<void> {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const cmd = [
    ...X_PRELUDE,
    CLIP_SAVE,
    `echo '${b64}' | base64 -d > ${CLIP_DIR}/typed.txt`,
    // xclip -i 会 daemon 化常驻持有剪贴板选区，并继承 exec 的 stdout/stderr；不重定向的话 docker exec
    // 要等这俩 fd 关闭，实测每次卡 ~2s。重定向到 /dev/null 后台后，整条链路从 ~2.1s 降到 ~0.08s。
    `xclip -selection clipboard -i ${CLIP_DIR}/typed.txt >/dev/null 2>&1`,
    xdoKey('ctrl+v'),
  ].join('\n');
  await withClipLock(inst.id, async () => {
    cancelClipRestore(inst.id);
    try {
      await execCapture(inst, ['bash', '-c', cmd]);
    } finally {
      scheduleClipRestore(inst);
    }
  });
}

// 把本机剪贴板里的文字粘进应用：粘贴桥判断本机剪贴板比容器的新时走这里（在别处复制后回来直接 Ctrl+V、
// 局域网 http 下浏览器不同步剪贴板）。与打字不同，这是用户有意换内容，贴完文字就留在容器剪贴板里。
// 文字可能很长，经文件传入（单个命令行参数有 128KB 上限）。
export async function pasteTextInInstance(inst: Instance, text: string): Promise<void> {
  const name = `woc-paste-${Date.now()}.txt`;
  await withClipLock(inst.id, async () => {
    cancelClipRestore(inst.id);
    await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, Buffer.from(text, 'utf8')), { path: '/tmp' });
    const cmd = [
      ...X_PRELUDE,
      CLIP_DISCARD,
      `xclip -selection clipboard -i /tmp/${name} >/dev/null 2>&1`,
      `rm -f /tmp/${name}`,
      xdoKey('ctrl+v'),
    ].join('\n');
    await execCapture(inst, ['bash', '-c', cmd]);
  });
}

// 把本机剪贴板里的图片（截图等）粘进应用（issue #91）：写入容器的 X 剪贴板（目标类型即图片 MIME），
// 再按一次 Ctrl+V，效果等同于在容器里复制了一张图片后粘贴。图片先落到 /tmp（非持久卷，重启即清），
// xclip -i 读完文件后会常驻持有剪贴板选区，文件本身随后即可删除；这里顺手清掉 10 分钟前的旧文件。
const PASTE_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
export async function pasteImageInInstance(inst: Instance, mime: string, content: Buffer): Promise<void> {
  const ext = PASTE_IMAGE_TYPES[mime];
  if (!ext) throw new Error('不支持的图片类型');
  const name = `woc-paste-${Date.now()}.${ext}`;
  await withClipLock(inst.id, async () => {
    cancelClipRestore(inst.id); // 有意换成这张图，之前打字借用的剪贴板不再归还
    await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: '/tmp' });
    const cmd = [
      ...X_PRELUDE,
      CLIP_DISCARD,
      "find /tmp -maxdepth 1 -name 'woc-paste-*' -mmin +10 -delete 2>/dev/null || true",
      // 同 typeInInstance：xclip 常驻后台持有选区，必须重定向 fd，否则 docker exec 要等它退出（~2s）
      `xclip -selection clipboard -t ${mime} -i /tmp/${name} >/dev/null 2>&1`,
      xdoKey('ctrl+v'),
    ].join('\n');
    await execCapture(inst, ['bash', '-c', cmd]);
  });
}

// 通过 xdotool 在实例容器内模拟一次按键（如 Return / BackSpace）。
// 用于「无感输入」模式：中文经 xclip 转发期间，把被截下的回车/退格按序送出，保证顺序、避免抢跑。
// key 为 xdotool keysym 名，可带至多 3 个修饰键前缀（如 ctrl+v、ctrl+shift+Tab）；
// 只允许字母 / 下划线 / 固定修饰键名与 "+"，杜绝 shell 注入。
export async function keyInInstance(inst: Instance, key: string): Promise<void> {
  if (!/^(?:(?:ctrl|shift|alt|super)\+){0,3}[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    xdoKey(key),
  ].join('\n');
  if (!/^ctrl\+v$/i.test(key)) {
    await execCapture(inst, ['bash', '-c', cmd]);
    return;
  }
  // 粘贴：打字借用的剪贴板若还没归还，先归还再按，免得贴出刚打的字
  await withClipLock(inst.id, async () => {
    if (cancelClipRestore(inst.id)) await restoreClipboard(inst);
    await execCapture(inst, ['bash', '-c', cmd]);
  });
}

// ---------- 数据卷管理（仅管理员；路由层用 requireAdmin 限制） ----------
// 数据卷 = 容器内 /config 持久卷，含微信全部数据（登录态、加密聊天库等）。提供浏览/上传/解压/下载/
// 改名/移动/删除 + 整卷备份/恢复。主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。
// 路径安全：所有相对路径经 safeVolPath 归一化并严格限制在 /config 内，禁止 .. 穿越。
const VOL_ROOT = '/config';

// 把用户给的相对路径安全解析为 /config 下的绝对路径；禁止 .. 与 NUL；剥离前导 /。
export function safeVolPath(rel: string): string {
  const raw = (rel ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new Error('路径不合法');
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error('路径不合法（禁止 ..）');
    parts.push(seg);
  }
  return parts.length ? `${VOL_ROOT}/${parts.join('/')}` : VOL_ROOT;
}
const relOf = (abs: string): string => (abs === VOL_ROOT ? '' : abs.slice(VOL_ROOT.length + 1));

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number; // epoch ms
}

// 列目录（仅一层）。dirs/files 混合返回，前端排序。
export async function listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }> {
  const abs = safeVolPath(rel);
  // GNU find -printf：%y 类型(d/f/l) \t %s 大小 \t %T@ mtime(秒.纳秒) \t %f 名字。argv 直传不经 shell，名字含空格/引号也安全。
  const out = await execCapture(inst, [
    'find', abs, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\n',
  ]);
  const entries: VolEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const i1 = line.indexOf('\t');
    const i2 = line.indexOf('\t', i1 + 1);
    const i3 = line.indexOf('\t', i2 + 1);
    if (i1 < 0 || i2 < 0 || i3 < 0) continue;
    const y = line.slice(0, i1);
    entries.push({
      type: y === 'd' ? 'dir' : y === 'f' ? 'file' : y === 'l' ? 'link' : 'other',
      size: Number(line.slice(i1 + 1, i2)) || 0,
      mtime: Math.round(parseFloat(line.slice(i2 + 1, i3)) * 1000) || 0,
      name: line.slice(i3 + 1),
    });
  }
  return { path: relOf(abs), entries };
}

export async function volMkdir(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('路径不合法');
  await execCapture(inst, ['mkdir', '-p', abs]);
}

export async function volMove(inst: Instance, fromRel: string, toRel: string): Promise<void> {
  const from = safeVolPath(fromRel);
  const to = safeVolPath(toRel);
  if (from === VOL_ROOT || to === VOL_ROOT) throw new Error('不能移动数据卷根目录');
  if (from === to) return;
  await execCapture(inst, ['mv', '-f', from, to]);
}

export async function volDelete(inst: Instance, rel: string): Promise<void> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能删除数据卷根目录');
  await execCapture(inst, ['rm', '-rf', abs]);
}

// 上传单个文件到指定目录（tar 头写 uid/gid 1000，落地即 abc 属主，微信可读）。流式写入，见 putFileStream。
export async function volUploadFile(inst: Instance, rel: string, name: string, size: number, body: AsyncIterable<Buffer>): Promise<void> {
  await putFileStream(inst, safeVolPath(rel), name, size, body);
}

// 上传的压缩包（已暂存在面板数据目录）写进实例前的整体校验：格式对、没被截断、gzip 没坏、路径不越出目标目录、
// 没有设备文件；整卷恢复还要求所有条目都在 config/ 下（本系统备份的格式）。此前不校验直接解到容器根目录，
// 传错了包（比如把 PC 微信文件夹的压缩包当备份传上去）就散落进容器的系统目录。
// 返回解压后普通文件的总字节数，用来预先检查目标盘空间。
export interface ArchiveInfo {
  gzip: boolean;
  bytes: number;
  tops: string[] | null; // 解出来的顶层条目名（解压后改属主用）；太多时为 null
}
export async function volCheckArchive(path: string, mode: 'extract' | 'restore'): Promise<ArchiveInfo> {
  const kind = await sniffArchive(path);
  if (kind === 'zip') throw new Error('暂不支持 zip，请打包成 .tar 或 .tar.gz 后再上传');
  if (kind === 'other') throw new Error('不是 .tar / .tar.gz 压缩包（或文件已损坏）');
  const gzip = kind === 'gzip';
  let entries = 0;
  let bytes = 0;
  const tops = new Set<string>();
  let manyTops = false;
  await scanArchive(path, gzip, (e) => {
    entries++;
    const segs = e.name.split('/').filter((x) => x && x !== '.');
    if (segs.length && !manyTops) {
      tops.add(segs[0]);
      if (tops.size > 200) manyTops = true;
    }
    if (segs.includes('..') || (e.type === '1' && e.linkname.split('/').includes('..'))) {
      throw new Error(`压缩包里有越出目标目录的路径（${e.name}），已拒绝`);
    }
    if (e.type === '3' || e.type === '4' || e.type === '6') throw new Error(`压缩包里有设备文件或管道（${e.name}），已拒绝`);
    if (mode === 'restore' && segs[0] !== 'config') {
      throw new Error(`这不是本系统导出的整卷备份：「${e.name}」不在 config/ 目录下。要导入别处的数据请用「上传并解压」`);
    }
    bytes += e.size;
  });
  if (!entries) throw new Error('压缩包是空的');
  return { gzip, bytes, tops: manyTops ? null : [...tops] };
}

// 上传压缩包并解压到指定目录（PC 微信数据迁移：用户把文件夹打成 .tar/.tar.gz 上传）。
// putArchive 把 tar 内容解到 dir 下，Docker 解包限制在 dir 内、防 .. 穿越。gzip 在面板里流式解开。
export async function volExtractArchive(inst: Instance, rel: string, archivePath: string, info: ArchiveInfo): Promise<void> {
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]).catch((e) => {
    throw friendlyWriteError(e);
  });
  await assertFreeSpace(inst, dir, info.bytes);
  const tar = openTarStream(archivePath, info.gzip);
  try {
    await putArchiveStream(inst, tar, dir);
  } catch (e) {
    throw friendlyWriteError(e);
  } finally {
    tar.destroy();
  }
  // putArchive 按压缩包里记录的属主落地：在 NAS 上用 root 打的包解出来是 root，Mac 上打的是 501。应用以 abc 运行，
  // 写不了这些文件——迁移过来的微信数据库打不开 / 写不进去。解完把这次解出来的东西改成 abc（-h：符号链接只改它自己，
  // 不跟过去）；实例的设备标识文件 .woc-machine-id 本来就属于 root，不动。
  const own = ['chown', '-R', '-h', 'abc:abc', '--'];
  let run: string[] | null;
  if (info.tops) {
    const paths = info.tops.filter((t) => !(dir === VOL_ROOT && t === '.woc-machine-id')).map((t) => `${dir}/${t}`);
    run = paths.length ? [...own, ...paths] : null;
  } else if (dir === VOL_ROOT) {
    // 顶层条目太多（>200）没记全：卷根下除设备标识外全部改一遍（卷里本来就都该是 abc 的）
    run = ['find', VOL_ROOT, '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.woc-machine-id', '-exec', ...own.slice(0, -1), '{}', '+'];
  } else {
    run = [...own, dir];
  }
  if (run) {
    await execCapture(inst, run, 'root').catch((e) => {
      throw new Error(`文件已解压，但没能把属主改成应用用户（${e?.message || e}），应用可能改不了这些文件，请重试`);
    });
  }
}

export async function volDownloadFile(inst: Instance, rel: string): Promise<{ size: number; stream: NodeJS.ReadableStream }> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
  return streamRegularFile(inst, abs);
}

// 整卷备份：把 /config 打成 tar 流并经 gzip 输出（路由直接 pipe 给响应，避免大文件入内存）。
// getArchive('/config') 的条目前缀为 config/，恢复时解到容器根即可落回 /config。
export async function volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
  const tar = (await docker.getContainer(inst.containerName).getArchive({ path: VOL_ROOT })) as NodeJS.ReadableStream;
  const gzip = zlib.createGzip();
  tar.on('error', (e) => gzip.destroy(e as Error));
  return tar.pipe(gzip);
}

// 整卷恢复：仅适用于本系统导出的备份（条目前缀 config/），解到容器根 → 落回 /config。
// 是「还原」而不是「覆盖」：先把 /config 现有的内容挪进卷里的 .woc-restore-old-<时间>（同一个卷，只是改名，
// 不多占空间），写完备份再删掉；写入失败就清掉写了一半的数据、把它挪回来。此前直接覆盖，备份里没有的文件原样
// 留着，把用过一阵的实例回滚到旧备份时新旧数据库文件混在一起，聊天记录可能打不开。
// 写之前先停掉实例、写完再启动（原本在运行的话）：在微信运行时覆盖它正开着的数据库容易写坏。实例停着时 exec
// 不进去，挪文件、写备份都在一个临时辅助容器里做（--volumes-from 实例，挂的是同一个 /config）。
// 与重启 / 升级 / 自愈共用同一把生命周期锁，恢复中途不会被别的操作把容器拉起来。
const RESTORE_OLD_PREFIX = '.woc-restore-old-';
export async function volRestoreArchive(
  inst: Instance,
  archivePath: string,
  info: { gzip: boolean; bytes: number },
  onStage: (stage: string) => void,
): Promise<void> {
  await withLifecycle(inst.id, async () => {
    const c = docker.getContainer(inst.containerName);
    const state: any = await c.inspect().catch(() => null);
    if (!state) throw new Error('实例容器不存在：请先在卡片上启动一次实例，再恢复');
    const helper = await startRestoreHelper(inst, state.Image);
    let wasRunning = false;
    try {
      // 旧数据要等备份写完才删，这段时间新旧两份同时在盘上。先查空间再停实例：不够就不必白停一次
      onStage('检查空间');
      const df = await execCaptureIn(helper, ['df', '-Pk', VOL_ROOT], '0').catch(() => '');
      const freeKb = Number(df.trim().split('\n').pop()?.trim().split(/\s+/)[3]);
      const need = info.bytes + 64 * 1024 ** 2; // 备份解开的大小，加一点余量
      if (Number.isFinite(freeKb) && need > freeKb * 1024) {
        throw Object.assign(
          new Error(`实例数据盘空间不足：恢复时现有数据要等备份写完才删，需要约 ${fmtBytes(need)} 空闲，只剩 ${fmtBytes(freeKb * 1024)}`),
          { statusCode: 507 },
        );
      }
      if (state.State?.Running) {
        onStage('停止实例');
        try {
          await c.stop({ t: 10 } as any);
        } catch (e: any) {
          if (e?.statusCode !== 304) throw e; // 304 = 已经停了
        }
        wasRunning = true;
        appendInstanceLog(inst.id, '整卷恢复：已停止实例');
      }
      await restoreInHelper(inst, helper, archivePath, info, onStage);
    } finally {
      await helper.remove({ force: true }).catch(() => {});
      if (wasRunning) {
        onStage('启动实例');
        await c.start().catch((e: any) => {
          if (e?.statusCode !== 304) appendInstanceLog(inst.id, `整卷恢复后启动实例失败：${e?.message || e}`);
        });
      }
    }
  });
}

// 恢复用的辅助容器：实例自己的镜像（本地一定有），什么都不跑、不联网，只挂实例的数据卷
async function startRestoreHelper(inst: Instance, image: string): Promise<any> {
  const name = `woc-restore-${inst.id}`;
  await docker.getContainer(name).remove({ force: true }).catch(() => {}); // 上次面板中途退出留下的
  const h = await docker.createContainer({
    name,
    Image: image,
    Entrypoint: ['sleep'],
    Cmd: ['infinity'],
    User: '0',
    Labels: { 'woc.helper': 'restore' },
    HostConfig: { VolumesFrom: [inst.containerName], NetworkMode: 'none' },
  } as any);
  try {
    await h.start();
  } catch (e) {
    await h.remove({ force: true }).catch(() => {});
    throw e;
  }
  return h;
}

// 在辅助容器里执行的几步（$1 = 旧数据目录名）。之前恢复中断留下的 .woc-restore-old-* 一律不碰
const SH_MOVE_ASIDE = `set -e; cd ${VOL_ROOT}; mkdir -p -- "$1"; find . -mindepth 1 -maxdepth 1 ! -name '${RESTORE_OLD_PREFIX}*' -exec mv -t "$1" -- {} +`;
// 把旧数据挪回 /config；$2=1 时先清掉写了一半的新数据
const SH_MOVE_BACK = `set -e; cd ${VOL_ROOT}; [ -d "$1" ] || exit 0
  if [ "$2" = 1 ]; then find . -mindepth 1 -maxdepth 1 ! -name '${RESTORE_OLD_PREFIX}*' -exec rm -rf -- {} +; fi
  find "$1" -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +
  rmdir -- "$1"`;
// 写完之后删旧数据。备份里没有设备标识（早期的备份）就沿用原来的：不然启动时会生成新的 machine-id，在微信看来像换了台设备
const SH_FINISH = `cd ${VOL_ROOT}
  if [ ! -e .woc-machine-id ] && [ -e "$1/.woc-machine-id" ]; then mv -- "$1/.woc-machine-id" . && echo kept; fi
  rm -rf -- "$1"`;

// 恢复进行到哪一步记在面板数据目录里。面板在恢复途中被重启（自更新、宿主重启、崩溃）时，下次启动先按它收尾，
// 再拉起实例：挪到一半、写到一半就挪回原来的数据，写完了就把旧数据删掉。不然实例会带着半截数据被拉起来，
// 设备标识文件也已被挪走、会被重新生成
type RestorePhase = 'moving' | 'writing' | 'cleanup';
const RESTORE_JOURNAL = `${dirname(process.env.PANEL_DATA || '/data/panel/accounts.json')}/restore-journal.json`;
function readRestoreJournal(): Record<string, { old: string; phase: RestorePhase }> {
  try {
    return JSON.parse(readFileSync(RESTORE_JOURNAL, 'utf8')) || {};
  } catch {
    return {};
  }
}
function setRestorePhase(instId: string, entry: { old: string; phase: RestorePhase } | null): void {
  const j = readRestoreJournal();
  if (entry) j[instId] = entry;
  else delete j[instId];
  try {
    if (!Object.keys(j).length) {
      rmSync(RESTORE_JOURNAL, { force: true });
      return;
    }
    writeFileSync(`${RESTORE_JOURNAL}.tmp`, JSON.stringify(j));
    renameSync(`${RESTORE_JOURNAL}.tmp`, RESTORE_JOURNAL);
  } catch {
    /* 记不下来不影响这次恢复本身，只是中途被打断时没法自动收尾 */
  }
}

async function restoreInHelper(
  inst: Instance,
  h: any,
  archivePath: string,
  info: { gzip: boolean; bytes: number },
  onStage: (stage: string) => void,
): Promise<void> {
  const sh = (script: string, ...args: string[]) => execCaptureIn(h, ['sh', '-c', script, 'sh', ...args], '0');
  const old = RESTORE_OLD_PREFIX + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // .woc-restore-old-20261001T041700
  const rollback = async (clean: boolean, cause: any): Promise<never> => {
    const fe: any = friendlyWriteError(cause);
    const why = fe.message;
    onStage('恢复失败，正在挪回原来的数据');
    try {
      await sh(SH_MOVE_BACK, old, clean ? '1' : '0');
    } catch (e: any) {
      setRestorePhase(inst.id, null); // 交给人工处理，面板重启时不要再自动动它
      appendInstanceLog(inst.id, `整卷恢复失败（${why}），原来的数据没能自动挪回，还在 /config/${old}：${e?.message || e}`);
      throw Object.assign(new Error(`恢复失败：${why}。原来的数据没能自动挪回，还在数据卷的 ${old} 目录里，可以在「数据卷」里把里面的内容移回根目录`), {
        statusCode: fe.statusCode,
      });
    }
    setRestorePhase(inst.id, null);
    appendInstanceLog(inst.id, `整卷恢复失败（${why}），已挪回原来的数据`);
    throw Object.assign(new Error(`恢复失败：${why}。已还原成恢复前的数据`), { statusCode: fe.statusCode });
  };

  onStage('挪开现有数据');
  setRestorePhase(inst.id, { old, phase: 'moving' });
  try {
    await sh(SH_MOVE_ASIDE, old);
  } catch (e) {
    await rollback(false, e); // 挪到一半：已挪走的挪回来（没有新数据要清）
  }
  appendInstanceLog(inst.id, `整卷恢复：原来的数据已挪到 /config/${old}，开始写入备份`);
  onStage('写入数据');
  setRestorePhase(inst.id, { old, phase: 'writing' });
  const tar = openTarStream(archivePath, info.gzip);
  try {
    await putArchiveTo(h, tar, '/');
  } catch (e) {
    tar.destroy();
    await rollback(true, e);
  }
  tar.destroy();
  onStage('清理旧数据');
  setRestorePhase(inst.id, { old, phase: 'cleanup' });
  const kept = await sh(SH_FINISH, old).catch((e: any) => {
    appendInstanceLog(inst.id, `整卷恢复：备份已写入，但删除旧数据 /config/${old} 失败，可以在「数据卷」里手动删除：${e?.message || e}`);
    return null;
  });
  setRestorePhase(inst.id, null);
  if (kept !== null) {
    appendInstanceLog(inst.id, `整卷恢复：备份已写入，原来的数据已删除${kept.includes('kept') ? '（备份里没有设备标识，沿用原来的）' : ''}`);
  }
}

// 面板启动时（此刻不可能有恢复在跑、实例还没被拉起）：清掉上次没来得及删的恢复辅助容器（不然一直占着实例的
// 数据卷），再给被打断的恢复收尾
export async function recoverInterruptedRestores(instances: Instance[]): Promise<void> {
  let list: Docker.ContainerInfo[] = [];
  try {
    list = await docker.listContainers({ all: true, filters: { label: ['woc.helper=restore'] } });
  } catch {
    /* Docker 不可达：下面的收尾也做不了，留到下次启动 */
    return;
  }
  for (const c of list) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  for (const [id, e] of Object.entries(readRestoreJournal())) {
    const inst = instances.find((i) => i.id === id);
    if (!inst || !e?.old?.startsWith(RESTORE_OLD_PREFIX) || e.old.includes('/')) {
      setRestorePhase(id, null);
      continue;
    }
    const what = e.phase === 'cleanup' ? '删掉了旧数据，恢复已完成' : '挪回了恢复前的数据';
    try {
      const c = docker.getContainer(inst.containerName);
      const st: any = await c.inspect();
      if (st.State?.Running) {
        try {
          await c.stop({ t: 10 } as any);
        } catch {
          /* 已经停了 */
        }
      }
      const h = await startRestoreHelper(inst, st.Image);
      try {
        if (e.phase === 'cleanup') await execCaptureIn(h, ['sh', '-c', SH_FINISH, 'sh', e.old], '0');
        else await execCaptureIn(h, ['sh', '-c', SH_MOVE_BACK, 'sh', e.old, e.phase === 'writing' ? '1' : '0'], '0');
      } finally {
        await h.remove({ force: true }).catch(() => {});
      }
      appendPanelLog('WARN', `实例「${inst.name}」(id=${id}) 上次整卷恢复被面板重启打断，已${what}`);
      appendInstanceLog(id, `整卷恢复被面板重启打断，已${what}`);
    } catch (err: any) {
      appendPanelLog('ERROR', `实例「${inst.name}」(id=${id}) 上次整卷恢复被面板重启打断，自动收尾失败：${err?.message || err}。恢复前的数据在它数据卷里的 ${e.old} 目录`);
    }
    setRestorePhase(id, null);
  }
}

// ---------- 桌面壁纸 ----------
const BG_DIR = '/config/backgrounds';
const WP_FILE = '/config/.wallpaper';

export async function listBackgrounds(inst: Instance): Promise<string[]> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `ls -1 ${BG_DIR} 2>/dev/null || true`]);
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

// 注：不再用 ImageMagick(convert) 生成缩略图（凭空胖 ~100MB + 引入注入点），直接回原图，前端按需缩放。
// thumb 参数保留以兼容调用方，忽略之。
export async function getBackgroundImage(inst: Instance, name: string, _thumb = false): Promise<Buffer> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  const path = `${BG_DIR}/${name}`;
  const stream = (await docker.getContainer(inst.containerName).getArchive({ path })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
}

export async function uploadBackground(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['mkdir', '-p', BG_DIR]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: BG_DIR });
}

// 检查实例容器内是否有某命令；没有则抛出友好错误（多为旧镜像未升级，避免用户看懵"退出码 127"）。
async function assertHasTool(inst: Instance, tool: string, msg: string): Promise<void> {
  let ok = false;
  try {
    const out = await execCapture(inst, ['sh', '-c', `command -v ${tool} >/dev/null 2>&1 && printf ok`]);
    ok = out.trim() === 'ok';
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(msg);
}

export async function applyBackground(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await assertHasTool(inst, 'xwallpaper', '该实例镜像过旧（缺壁纸组件 xwallpaper）。请先在「管理」对该实例点「升级」，再设置壁纸。');
  await execCapture(inst, ['sh', '-c', `DISPLAY=:1 xwallpaper --zoom '${BG_DIR}/${name}' 2>/dev/null`]);
  await execCapture(inst, ['sh', '-c', `echo '${name}' > '${WP_FILE}'`]);
}

export async function deleteBackground(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['rm', '-f', `${BG_DIR}/${name}`]);
  await execCapture(inst, ['sh', '-c', `if [ -f '${WP_FILE}' ] && [ "$(cat '${WP_FILE}')" = '${name}' ]; then rm -f '${WP_FILE}'; fi`]);
}

export async function getCurrentBackground(inst: Instance): Promise<string> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `cat ${WP_FILE} 2>/dev/null || true`]);
    return out.trim();
  } catch { return ''; }
}

export async function clearBackground(inst: Instance): Promise<void> {
  await execCapture(inst, ['sh', '-c', 'DISPLAY=:1 xsetroot -solid black 2>/dev/null']);
  await execCapture(inst, ['rm', '-f', WP_FILE]);
}

// ---------- 字体管理 ----------
const FONT_DIR = '/config/.fonts';

export async function listFonts(inst: Instance): Promise<string[]> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `ls -1 ${FONT_DIR} 2>/dev/null || true`]);
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

export async function uploadFont(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['mkdir', '-p', FONT_DIR]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: FONT_DIR });
  await execCapture(inst, ['fc-cache', '-f'], 'root');
}

export async function deleteFont(inst: Instance, name: string): Promise<void> {
  if (!safeMediaName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['rm', '-f', `${FONT_DIR}/${name}`]);
  await execCapture(inst, ['fc-cache', '-f'], 'root');
}

const FONT_SEL_FILE = '/config/.woc-font';

// 将字体的 fontconfig family name 设为用户首选（fallback 仍用文泉驿等系统字体）。
// 设空字符串或 "default" 则清除偏好，回退系统默认。
export async function applyFont(inst: Instance, fontFile: string): Promise<void> {
  if (fontFile && !safeMediaName(fontFile)) throw new Error('文件名不合法');
  if (fontFile && fontFile !== 'default') {
    // 用 fc-scan 读取字体实际 family name（取第一个）
    const out = await execCapture(inst, ['sh', '-c', `fc-scan --format='%{family[0]}' '${FONT_DIR}/${fontFile}' 2>/dev/null`]);
    const family = out.trim();
    if (!family) throw new Error('未能识别该字体的 family name');
    // 写 fontconfig 系统级配置（/etc/fonts/local.conf 保证被读取，用户级可能被 XDG 路径问题跳过）
    const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <!-- generic families -->
  <alias>
    <family>sans-serif</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>serif</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <!-- system CJK fonts that WeChat/CEF may request -->
  <alias>
    <family>WenQuanYi Micro Hei</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>WenQuanYi Zen Hei</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>Noto Sans CJK SC</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <alias>
    <family>Noto Sans CJK</family>
    <prefer><family>${family}</family></prefer>
  </alias>
  <!-- force user font for any zh text regardless of requested family -->
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${family}</string></edit>
  </match>
</fontconfig>`;
    await execCapture(inst, ['bash', '-c', `cat > /etc/fonts/local.conf << 'CONF'\n${xml}\nCONF`], 'root');
    execCapture(inst, ['bash', '-c', `cat > /config/.woc-fc-local.conf << 'CONF'\n${xml}\nCONF`], 'root').catch(() => {});
    await execCapture(inst, ['fc-cache', '-f'], 'root');
    await execCapture(inst, ['sh', '-c', `echo '${fontFile}' > ${FONT_SEL_FILE}`]);
    await execCapture(inst, ['bash', '-c', `cat > ${FONT_SEL_FILE}-family << 'FAMILYEOF'\n${family}\nFAMILYEOF`]);
    // 更新 xsettingsd 配置 → GTK/Qt 应用实时响应
    applyXsettingsFont(inst, family).catch(() => {});
  } else {
    // 清除偏好，回退默认（文泉驿等系统字体）
    await execCapture(inst, ['rm', '-f', '/etc/fonts/local.conf', '/config/.woc-fc-local.conf'], 'root');
    await execCapture(inst, ['rm', '-f', '/config/.config/fontconfig/fonts.conf']);
    await execCapture(inst, ['fc-cache', '-f'], 'root');
    await execCapture(inst, ['rm', '-f', FONT_SEL_FILE, `${FONT_SEL_FILE}-family`]);
    applyXsettingsFont(inst, 'WenQuanYi Micro Hei').catch(() => {});
  }
}

async function applyXsettingsFont(inst: Instance, family: string): Promise<void> {
  const conf = '/config/.xsettingsd';
  // ⚠️ XSETTINGS 规范里 Xft/DPI 单位是「DPI × 1024」：96 DPI 必须写 98304。误写 96 会让所有
  // Chromium 内核应用（系统 Chromium / 微信内嵌 CEF）把缩放因子算成≈0 → 变换矩阵不可逆 →
  // GPU 进程连崩 → 窗口秒关/黑屏（v1.2.9~v1.3.1 的总根因，issue #111）。
  const lines = [
    'Xft/Antialias 1',
    'Xft/Hinting 1',
    'Xft/HintStyle "hintslight"',
    'Xft/RGBA "rgb"',
    'Xft/DPI 98304',
    `Gtk/FontName "${family} 10"`,
  ];
  await execCapture(inst, ['sh', '-c', `printf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')} > ${conf}`]);
  await execCapture(inst, ['sh', '-c', 'pkill -HUP xsettingsd 2>/dev/null || xsettingsd --config=/config/.xsettingsd 2>/dev/null &']);
}

// 返回当前选中的字体文件名，空字符串表示默认
export async function getAppliedFont(inst: Instance): Promise<string> {
  try {
    const out = await execCapture(inst, ['sh', '-c', `cat ${FONT_SEL_FILE} 2>/dev/null || true`]);
    return out.trim();
  } catch { return ''; }
}

export async function getFontFamily(inst: Instance, fontFile: string): Promise<string> {
  if (!safeMediaName(fontFile)) throw new Error('文件名不合法');
  try {
    const out = await execCapture(inst, ['sh', '-c', `fc-scan '${FONT_DIR}/${fontFile}' 2>/dev/null | grep 'family:' | head -1 | cut -d'"' -f2`]);
    return out.trim();
  } catch { return ''; }
}

// 容器重建后从挂载卷恢复字体配置 & xsettingsd（不依赖 autostart 镜像版本）
async function restoreFontFromVolume(inst: Instance): Promise<void> {
  await execCapture(inst, ['bash', '-c', 'if [ -f /config/.woc-fc-local.conf ]; then cp /config/.woc-fc-local.conf /etc/fonts/local.conf && fc-cache -f; fi'], 'root').catch(() => {});
  const famOut = await execCapture(inst, ['sh', '-c', 'cat /config/.woc-font-family 2>/dev/null || true']).catch(() => '');
  const family = famOut.trim();
  if (family) applyXsettingsFont(inst, family).catch(() => {});
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  return `http://${inst.containerName}:3000`;
}

export { WECHAT_IMAGE };
