import { hostname } from 'node:os';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { appendInstanceLog, deleteInstanceLog, appendPanelLog, readInstanceLog, readPanelLog, filterSince } from './logs.js';
import http from 'node:http';
import zlib from 'node:zlib';
import Docker from 'dockerode';
import { instanceAppType, type Instance } from './store.js';

const WECHAT_IMAGE = process.env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest';
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const TZ = process.env.TZ || 'Asia/Shanghai';
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

const DATA_ROOT = (process.env.WOC_DATA_ROOT || '').replace(/\/+$/, '');

// 默认关闭 KasmVNC 的 GPU 硬件编码（baseimage 检测到 /dev/dri/renderD* 时会给 Xvnc 加 -hw3d）：
// 在 WSL2 / 虚拟 GPU 环境下该路径会导致 Xvnc 内存持续膨胀（实测反馈 21h 涨到 ~9GB）。
// 我们已设 LIBGL_ALWAYS_SOFTWARE=1 走软件渲染，hw3d 对微信这类静态界面收益甚微。
// 真实可用 GPU 想启用硬件编码：面板侧设 WOC_ENABLE_GPU=1。
const ENABLE_GPU = process.env.WOC_ENABLE_GPU === '1';

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

// 面板自身所在的 docker 网络名；新实例都 attach 到它，便于按容器名互访。
let networkName: string | null = process.env.WOC_DOCKER_NETWORK || null;

export type RuntimeState = 'running' | 'stopped' | 'missing';

// 启动时探测面板自身网络（容器内 hostname = 容器短 id）。失败不致命：
// 退回 WOC_DOCKER_NETWORK 或 null（null 时用 docker 默认 bridge，靠 IP 不靠名字会有问题，故尽量探测成功）。
export async function ensureNetwork(): Promise<string | null> {
  if (networkName) return networkName;
  try {
    const self = docker.getContainer(hostname());
    const info = await self.inspect();
    const nets = Object.keys(info.NetworkSettings?.Networks || {}).filter((n) => n !== 'none' && n !== 'host');
    if (nets.length > 0) networkName = nets[0];
  } catch (e: any) {
    console.warn('[docker] 无法探测面板网络（本地开发或缺少 docker.sock 时正常）:', e?.message || e);
  }
  return networkName;
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
  return env;
}

// 确保微信镜像在本地存在；缺失则从 GHCR 拉取（首次新建实例时镜像通常还没拉过）。
async function ensureImage(): Promise<void> {
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
  } catch (e: any) {
    appendPanelLog('ERROR', `实例镜像拉取失败 ${WECHAT_IMAGE}（耗时 ${Math.round((Date.now() - t0) / 1000)}s）：${e?.message || e}`);
    throw e;
  }
}

// 创建并启动一个微信实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
export async function runInstance(inst: Instance): Promise<void> {
  const net = await ensureNetwork();
  await ensureImage();
  // 如果配置了自定义数据根目录，确保宿主目录存在
  if (DATA_ROOT) {
    const hostDataDir = `${DATA_ROOT}/${inst.volumeName}`;
    mkdirSync(hostDataDir, { recursive: true });
  }
  try {
    const existing = docker.getContainer(inst.containerName);
    await existing.inspect();
    // 删除前先把旧容器最后日志快照进持久日志，否则随容器删除就看不到"上次为何停/崩"。
    await snapshotContainerLog(inst, '容器重建（重启/升级/自愈），保留上一容器最后日志');
    await existing.remove({ force: true });
  } catch {
    /* 不存在，正常 */
  }
  // 摄像头设备（探测不到则为空数组 → 仅摄像头不可用，音频/麦克风照常）
  const vids = videoDevices();
  const hostConfig: Docker.HostConfig = {
    Binds: [DATA_ROOT ? `${DATA_ROOT}/${inst.volumeName}:/config` : `${inst.volumeName}:/config`],
    NetworkMode: net || undefined,
    SecurityOpt: ['seccomp=unconfined'],
    ShmSize: SHM_SIZE,
    RestartPolicy: { Name: 'unless-stopped' },
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
  // 伪装成真实有线网卡 MAC（厂商 OUI），替代容器默认的本地管理位 MAC。
  const mac = realisticMac(inst.id);
  const createOpts: Docker.ContainerCreateOptions = {
    name: inst.containerName,
    Image: WECHAT_IMAGE,
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
export async function ensureRunning(inst: Instance): Promise<void> {
  try {
    const c = docker.getContainer(inst.containerName);
    const info = await c.inspect();
    if (!info.State?.Running) await c.start();
  } catch {
    await runInstance(inst);
  }
}

// 升级实例：拉取最新微信镜像后重建容器（保留数据卷 → 登录态不丢）。
// 拉取失败（本地自构建 / 离线 / 仓库不可达）则用本地现有镜像重建，不阻断。
export async function upgradeInstance(inst: Instance): Promise<void> {
  try {
    await pullImage();
  } catch (e: any) {
    console.warn('[docker] 升级时拉取镜像失败，改用本地镜像重建:', e?.message || e);
  }
  await runInstance(inst);
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
  await runInstance(inst);
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
  if (purgeVolume && !DATA_ROOT) {
    try {
      await docker.getVolume(inst.volumeName).remove({ force: true } as any);
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
  await docker.getVolume(name).remove({ force: true } as any);
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

// 在实例容器内执行命令，返回 stdout；若命令失败，把 stderr 透出给调用方。
async function execCapture(inst: Instance, cmd: string[]): Promise<string> {
  const c = docker.getContainer(inst.containerName);
  const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, User: 'abc' });
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
  const exec = await c.exec({
    Cmd: ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`],
    AttachStdout: false,
    AttachStderr: false,
    User: 'abc',
  });
  await exec.start({ Detach: true });
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

export async function wechatStatus(inst: Instance): Promise<WechatStatus> {
  try {
    // 兼容旧容器（无 /woc/app-ctl.sh）：有则按 appType 取状态，无则回退老的 wechat-ctl.sh（旧实例皆微信）。
    const at = instanceAppType(inst);
    const raw = await execCapture(inst, [
      'bash',
      '-c',
      `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} status; else /woc/wechat-ctl.sh status; fi`,
    ]);
    const json = JSON.parse(raw.trim());
    return { ...DEFAULT_STATUS, ...json };
  } catch {
    return DEFAULT_STATUS;
  }
}

// 拉取微信镜像（首次部署/更新镜像用）。返回拉取日志的最后状态。
export async function pullImage(onProgress?: (line: any) => void): Promise<void> {
  return await new Promise((resolve, reject) => {
    docker.pull(WECHAT_IMAGE, (err: any, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (e: any) => (e ? reject(e) : resolve()),
        (ev: any) => onProgress?.(ev),
      );
    });
  });
}

// ---------- 文件中转（上传/下载） ----------
// 中转目录 = abc 家目录下的 Desktop（/config 持久卷）。上传落这里，微信文件选择器可直接选到；
// 反向：把微信收到的文件另存到桌面，即可在面板里下载。
const TRANSFER_DIR = '/config/Desktop';

// 极简单文件 tar 编码（putArchive 需要 tar；避免引入第三方依赖）。
function tarSingleFile(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8'); // name
  h.write('0000644\0', 100); // mode
  h.write('0001750\0', 108); // uid 1000(octal 1750)
  h.write('0001750\0', 116); // gid 1000
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124); // size
  h.write('00000000000\0', 136); // mtime
  h.write('        ', 148); // checksum 占位（8 空格）
  h.write('0', 156); // typeflag 普通文件
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); // 真实校验和
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]);
}

// ---------- 诊断包 ----------
// 单个 tar entry（USTAR header + 内容 + 512 对齐填充），复用与 tarSingleFile 相同的格式。
function tarEntry(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148); // checksum 占位
  h.write('0', 156); // typeflag 普通文件
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0)]);
}

// 多文件 tar.gz（内存构建；诊断包通常仅数 MB）。文件名用 ASCII 路径避免 utf8 超 100 字节。
function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')));
  parts.push(Buffer.alloc(1024, 0)); // 两个空块标记归档结束
  return zlib.gzipSync(Buffer.concat(parts));
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
      '  instances/<id>.log 每个实例：容器状态 + 持久日志 + 实时容器日志',
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
    sys += `CPU: ${info.NCPU} 核 · 内存: ${(info.MemTotal / 1073741824).toFixed(1)} GiB\n`;
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
  sys += `\n实例数: ${instances.length}\n`;
  entries.push({ name: 'system.txt', content: sys });

  // 面板全局日志（按范围裁剪）
  entries.push({ name: 'panel.log', content: filterSince(readPanelLog(), sinceMs) || '（无面板日志）' });

  // 每个实例
  for (const inst of instances) {
    let c = `实例: ${inst.name}\nID: ${inst.id}\n容器: ${inst.containerName}\n类型: ${instanceAppType(inst)}\n数据卷: ${inst.volumeName}\n创建: ${inst.createdAt}\n\n`;
    try {
      const info: any = await docker.getContainer(inst.containerName).inspect();
      const s = info.State || {};
      c += `===== 容器状态 =====\n运行: ${s.Running} · 状态: ${s.Status} · 退出码: ${s.ExitCode}\n`;
      c += `OOMKilled: ${s.OOMKilled} · 重启次数: ${info.RestartCount} · 启动于: ${s.StartedAt}\n`;
      if (s.Error) c += `错误: ${s.Error}\n`;
      c += `镜像: ${String(info.Image).slice(0, 19)} · 健康: ${s.Health?.Status ?? 'n/a'}\n\n`;
    } catch (e: any) {
      c += `===== 容器状态 =====\n无法读取（容器可能未创建/已删除）：${e?.message || e}\n\n`;
    }
    c += `===== 持久化日志（最近 ${meta.range || '24h'}） =====\n${filterSince(readInstanceLog(inst.id), sinceMs) || '（无）'}\n\n`;
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

// 校验文件名为安全 basename（防路径穿越）。
function safeName(name: string): boolean {
  return !!name && name.length <= 200 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..';
}

export async function uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  await execCapture(inst, ['sh', '-c', `mkdir -p ${TRANSFER_DIR}`]); // abc 家目录可写
  const c = docker.getContainer(inst.containerName);
  await c.putArchive(tarSingleFile(name, content), { path: TRANSFER_DIR });
}

export interface TransferFile {
  name: string;
  size: number;
}
export async function listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
  const out = await execCapture(inst, [
    'sh',
    '-c',
    `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, size] = line.split('\t');
      return { name, size: Number(size) || 0 };
    });
}

export async function deleteInstanceFile(inst: Instance, name: string): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  // argv 数组直传，不经 shell；safeName 已排除路径穿越
  await execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
}

export async function downloadFromInstance(inst: Instance, name: string): Promise<Buffer> {
  if (!safeName(name)) throw new Error('文件名不合法');
  const c = docker.getContainer(inst.containerName);
  const stream = (await c.getArchive({ path: `${TRANSFER_DIR}/${name}` })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
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

// 通过 xdotool 在实例容器内输入文字（绕过 VNC keysym 限制，解决中文 IME 吞字问题）。
// 用 base64 传递文本避免 shell 转义问题，xclip 写入剪贴板后 xdotool 模拟 Ctrl+V 粘贴。
export async function typeInInstance(inst: Instance, text: string): Promise<void> {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    // xclip -i 会 daemon 化常驻持有剪贴板选区，并继承 exec 的 stdout/stderr；不重定向的话 docker exec
    // 要等这俩 fd 关闭，实测每次卡 ~2s。重定向到 /dev/null 后台后，整条链路从 ~2.1s 降到 ~0.08s。
    `echo '${b64}' | base64 -d | xclip -selection clipboard -i >/dev/null 2>&1`,
    'xdotool key --clearmodifiers ctrl+v',
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// 通过 xdotool 在实例容器内模拟一次按键（如 Return / BackSpace）。
// 用于「无感输入」模式：中文经 xclip 转发期间，把被截下的回车/退格按序送出，保证顺序、避免抢跑。
// key 仅允许字母与下划线（xdotool keysym 名），杜绝注入。
export async function keyInInstance(inst: Instance, key: string): Promise<void> {
  if (!/^[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
  const cmd = [
    'set -e',
    'display="${DISPLAY:-}"',
    'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
    'export DISPLAY="${display:-:1}"',
    'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
    `xdotool key --clearmodifiers ${key}`,
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// ---------- 数据卷管理（仅管理员；路由层用 requireAdmin 限制） ----------
// 数据卷 = 容器内 /config 持久卷，含微信全部数据（登录态、加密聊天库等）。提供浏览/上传/解压/下载/
// 改名/移动/删除 + 整卷备份/恢复。主要场景：把 PC 微信数据迁移上来、跨实例迁移、离线备份。
// 路径安全：所有相对路径经 safeVolPath 归一化并严格限制在 /config 内，禁止 .. 穿越。
const VOL_ROOT = '/config';

// 把用户给的相对路径安全解析为 /config 下的绝对路径；禁止 .. 与 NUL；剥离前导 /。
function safeVolPath(rel: string): string {
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
// gzip 魔数自动识别（用户上传可能是 .tar 或 .tar.gz；本系统备份恒为 .gz）。
const maybeGunzip = (buf: Buffer): Buffer =>
  buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;

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

// 上传单个文件到指定目录（tarSingleFile 写入 uid/gid 1000，落地即 abc 属主，微信可读）。
export async function volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void> {
  if (!safeName(name)) throw new Error('文件名不合法');
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]);
  await docker.getContainer(inst.containerName).putArchive(tarSingleFile(name, content), { path: dir });
}

// 上传压缩包并解压到指定目录（PC 微信数据迁移：用户把文件夹打成 .tar/.tar.gz 上传）。
// putArchive 把 tar 内容解到 dir 下，Docker 解包限制在 dir 内、防 .. 穿越。
export async function volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void> {
  const dir = safeVolPath(rel);
  await execCapture(inst, ['mkdir', '-p', dir]);
  await docker.getContainer(inst.containerName).putArchive(maybeGunzip(archive), { path: dir });
}

export async function volDownloadFile(inst: Instance, rel: string): Promise<Buffer> {
  const abs = safeVolPath(rel);
  if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
  const stream = (await docker.getContainer(inst.containerName).getArchive({ path: abs })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer) => chunks.push(d));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return extractSingleFileFromTar(Buffer.concat(chunks));
}

// 整卷备份：把 /config 打成 tar 流并经 gzip 输出（路由直接 pipe 给响应，避免大文件入内存）。
// getArchive('/config') 的条目前缀为 config/，恢复时解到容器根即可落回 /config。
export async function volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
  const tar = (await docker.getContainer(inst.containerName).getArchive({ path: VOL_ROOT })) as NodeJS.ReadableStream;
  const gzip = zlib.createGzip();
  tar.on('error', (e) => gzip.destroy(e as Error));
  return tar.pipe(gzip);
}

// 整卷恢复：仅适用于本系统导出的备份（条目前缀 config/），解到容器根 → 落回 /config。要求实例已停止。
export async function volRestoreArchive(inst: Instance, archive: Buffer): Promise<void> {
  await docker.getContainer(inst.containerName).putArchive(maybeGunzip(archive), { path: '/' });
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  return `http://${inst.containerName}:3000`;
}

export { WECHAT_IMAGE };
