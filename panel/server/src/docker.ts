import { hostname } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import Docker from 'dockerode';
import type { Instance } from './store.js';

const WECHAT_IMAGE = process.env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest';
const PUID = process.env.PUID || '1000';
const PGID = process.env.PGID || '1000';
const TZ = process.env.TZ || 'Asia/Shanghai';
const SHM_SIZE = 1024 * 1024 * 1024; // 1gb

// 默认关闭 KasmVNC 的 GPU 硬件编码（baseimage 检测到 /dev/dri/renderD* 时会给 Xvnc 加 -hw3d）：
// 在 WSL2 / 虚拟 GPU 环境下该路径会导致 Xvnc 内存持续膨胀（实测反馈 21h 涨到 ~9GB）。
// 我们已设 LIBGL_ALWAYS_SOFTWARE=1 走软件渲染，hw3d 对微信这类静态界面收益甚微。
// 真实可用 GPU 想启用硬件编码：面板侧设 WOC_ENABLE_GPU=1。
const ENABLE_GPU = process.env.WOC_ENABLE_GPU === '1';

// 可选：给每个实例容器设内存上限（GiB），作为 Xvnc 等异常增长时的兜底，避免拖垮宿主。
// 默认 0 = 不限制（保持原行为）。命中上限时容器内 OOM 杀进程、由 s6 自动重启 VNC。
const INSTANCE_MEM_GB = Number(process.env.WOC_INSTANCE_MEM_GB) || 0;
const INSTANCE_MEM = INSTANCE_MEM_GB > 0 ? Math.floor(INSTANCE_MEM_GB * 1024 * 1024 * 1024) : 0;

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
  await pullImage();
}

// 创建并启动一个微信实例容器。若同名容器已存在则先移除（仅容器，不动卷）。
export async function runInstance(inst: Instance): Promise<void> {
  const net = await ensureNetwork();
  await ensureImage();
  try {
    const existing = docker.getContainer(inst.containerName);
    await existing.inspect();
    await existing.remove({ force: true });
  } catch {
    /* 不存在，正常 */
  }
  // 摄像头设备（探测不到则为空数组 → 仅摄像头不可用，音频/麦克风照常）
  const vids = videoDevices();
  const hostConfig: Docker.HostConfig = {
    Binds: [`${inst.volumeName}:/config`],
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
  const container = await docker.createContainer({
    name: inst.containerName,
    Image: WECHAT_IMAGE,
    Hostname: inst.containerName,
    Env: envList(inst),
    ExposedPorts: { '3000/tcp': {} },
    HostConfig: hostConfig,
  });
  await container.start();
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

// 停止实例容器（保留容器与数据卷，可再启动）。
export async function stopInstance(inst: Instance): Promise<void> {
  try {
    await docker.getContainer(inst.containerName).stop({ t: 5 } as any);
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
      await docker.getVolume(inst.volumeName).remove({ force: true } as any);
    } catch {
      /* 卷可能不存在 */
    }
  }
}

// 列出"未被任何实例引用的 woc-data-* 数据卷"。删除实例时默认保留卷（聊天记录），但 panel 里没有
// UI 能看到这些孤儿卷；本接口让管理员可显式：在新建实例时复用旧卷继承聊天记录，或彻底删除。
// 仅看名字前缀 + docker 卷视角，不读卷内文件（避免提权访问）。
export async function listOrphanVolumes(referencedVolumes: Set<string>): Promise<
  Array<{ name: string; createdAt?: string; sizeBytes?: number }>
> {
  const { Volumes } = (await (docker as any).listVolumes()) || { Volumes: [] };
  if (!Array.isArray(Volumes)) return [];
  return Volumes
    .filter((v: any) => typeof v?.Name === 'string' && v.Name.startsWith('woc-data-') && !referencedVolumes.has(v.Name))
    .map((v: any) => ({
      name: v.Name,
      createdAt: v.CreatedAt,
      // UsageData 仅在 docker engine 启用 -v size=true 时返回，常见情况下没有；缺失就不展示，避免一次 inspect 风暴
      sizeBytes: typeof v?.UsageData?.Size === 'number' && v.UsageData.Size >= 0 ? v.UsageData.Size : undefined,
    }))
    .sort((a, b) => (a.createdAt && b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : 0));
}

// 显式删除一个数据卷（管理员清理孤儿卷用）。调用方负责确认它不被现存实例引用。
export async function removeVolume(name: string): Promise<void> {
  await docker.getVolume(name).remove({ force: true } as any);
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

// 触发下载/安装（detached，立即返回，后台下载）。
export async function triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
  const c = docker.getContainer(inst.containerName);
  const exec = await c.exec({
    Cmd: ['/woc/wechat-ctl.sh', cmd === 'update' ? 'update' : 'install'],
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
    const raw = await execCapture(inst, ['/woc/wechat-ctl.sh', 'status']);
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
  const tar = Buffer.concat(chunks);
  if (tar.length < 512) return Buffer.alloc(0);
  const sizeStr = tar.toString('ascii', 124, 135).replace(/\0/g, '').trim();
  const size = parseInt(sizeStr, 8) || 0;
  return tar.subarray(512, 512 + size);
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
    `echo '${b64}' | base64 -d | xclip -selection clipboard -i`,
    'xdotool key --clearmodifiers ctrl+v',
  ].join('; ');
  await execCapture(inst, ['bash', '-c', cmd]);
}

// 实例容器名（供反代构造 target）。
export function instanceTarget(inst: Instance): string {
  return `http://${inst.containerName}:3000`;
}

export { WECHAT_IMAGE };
