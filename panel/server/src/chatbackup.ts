// 微信 / QQ 聊天消息备份（全量 + 增量）。
// 设计见 doc/聊天消息备份设计.md。要点：
//  - 聊天库是 SQLCipher 加密的，只能原样备份文件，不能读库内容；恢复依赖 .woc-machine-id。
//  - 一致性靠「冻结应用进程」：备份前 SIGSTOP 应用进程（停止写库 → db+wal 快照一致，且不触发 autostart），
//    打包后 SIGCONT 恢复。容器全程运行（docker exec 需要），只在几秒内应用不可操作。
//    ⚠ 必须用 pkill -x <精确进程名>，不能用 -f（会匹配到 exec 自身的命令行，把自己冻住）。
//  - 增量以文件 mtime+size 为粒度；加密库无法做页级差异。
//  - docker API 只在 docker.ts：枚举/打包/解包都走这里导出的 helper。
import Docker from 'dockerode';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { instanceAppType, type Instance } from './store.js';
import {
  execCapture,
  execCreate,
  putArchiveStream,
  stopInstance,
  ensureRunning,
  instanceRuntime,
} from './docker.js';
import { appendInstanceLog } from './logs.js';

const docker = new Docker();

// 面板容器内备份根目录（挂 data-panel 卷 → 宿主 ./data-panel/chat-backups）。
const BACKUP_ROOT = process.env.WOC_CHAT_BACKUP_DIR || '/data/chat-backups';

// 每类应用要备份的 /config 下相对路径（目录或文件）。
// 微信：xwechat_files（聊天库+资源，4.1G）、.xwechat（运行时/索引 723M）、.woc-machine-id（解密 key）、Desktop（收的文件 71M）。
// QQ：.config/QQ（含 nt_db 消息库）。
const TARGETS: Record<string, string[]> = {
  wechat: ['xwechat_files', '.xwechat', '.woc-machine-id', 'Desktop'],
  qq: ['.config/QQ'],
  telegram: ['.config/telegram'],
};

// 每类应用的精确进程名（comm，用于 pkill -x）。必须是 ps comm 里的精确名，且 ≤15 字符。
// 微信主进程 comm=wechat；WeChatAppEx 子进程不直接写聊天库，冻结主进程即可让它停下写入。
// 关键：用 -x（精确匹配 comm），绝不用 -f（匹配整条命令行会命中执行 pkill 的 sh 自身）。
const APP_PROCS: Record<string, string[]> = {
  wechat: ['wechat'],
  qq: ['qq'],
  telegram: ['Telegram'],
};

// 冻结应用进程（SIGSTOP）。返回解冻函数；无论成功失败，调用方必须在 finally 里执行它。
// -x 精确匹配进程名，不会匹配到执行这些命令的 sh（comm=sh）本身。
async function freezeApp(inst: Instance): Promise<{ resume: () => Promise<void>; frozen: boolean }> {
  const procs = APP_PROCS[instanceAppType(inst)] || APP_PROCS.wechat!;
  let frozen = false;
  for (const name of procs) {
    try {
      // pgrep -x 精确名；有进程才 STOP。rc=0 表示匹配到并成功发出信号。
      const r = await execCapture(inst, ['sh', '-c', `pgrep -x ${name} >/dev/null 2>&1 && pkill -STOP -x ${name} && echo yes || echo no`], 'root');
      if (r.trim() === 'yes') frozen = true;
    } catch { /* 应用未运行时忽略 */ }
  }
  return {
    frozen,
    resume: async () => {
      for (const name of procs) {
        try {
          await execCapture(inst, ['sh', '-c', `pkill -CONT -x ${name} 2>/dev/null || true`], 'root');
        } catch { /* 容器已不在则忽略 */ }
      }
    },
  };
}

export type BackupKind = 'full' | 'inc';

export interface FileRec {
  p: string; // /config 下相对路径
  m: number; // mtime 秒
  s: number; // size 字节
}

export interface BackupEntry {
  id: string;
  kind: BackupKind;
  file: string; // 目录内文件名
  createdAt: number;
  bytes: number;
  fileCount: number;
  map: Record<string, [number, number]>; // 备份完成时的完整文件快照 { path: [mtime, size] }
  base?: string; // 增量基于的 entry id
  removed?: string[]; // 相对上一个快照被删除的文件（恢复时按需清理）
}

export interface Chain {
  version: 1;
  appType: string;
  entries: BackupEntry[];
}

function chainPath(instId: string): string {
  return join(BACKUP_ROOT, instId, 'chain.json');
}
function backupDir(instId: string): string {
  return join(BACKUP_ROOT, instId);
}

function readChain(instId: string): Chain {
  const p = chainPath(instId);
  if (!existsSync(p)) return { version: 1, appType: '', entries: [] };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Chain;
    if (c.version !== 1 || !Array.isArray(c.entries)) throw new Error('bad chain');
    return c;
  } catch {
    return { version: 1, appType: '', entries: [] };
  }
}

function writeChain(instId: string, chain: Chain): void {
  const dir = backupDir(instId);
  mkdirSync(dir, { recursive: true });
  const p = chainPath(instId);
  const tmp = `${p}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(chain));
  renameSync(tmp, p);
}

function targetsFor(inst: Instance): string[] {
  const app = instanceAppType(inst);
  return TARGETS[app] || TARGETS.wechat!;
}

// 列目标目录下的所有普通文件（含隐藏），输出 /config 相对路径、mtime 秒、size。
// 用 find -printf，argv 直传不经 shell，路径里有空格也安全；-type f 跳过目录/软链。
async function enumerateFiles(inst: Instance): Promise<FileRec[]> {
  const targets = targetsFor(inst);
  const abs = targets.map((t) => `/config/${t}`);
  const out = await execCapture(inst, [
    'find', ...abs, '-type', 'f', '-printf', '%p\\t%T@\\t%s\\n',
  ], 'root');
  const recs: FileRec[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const path = parts[0].replace(/^\/config\//, '');
    const mtime = Math.floor(parseFloat(parts[1]) || 0);
    const size = Number(parts[2]) || 0;
    if (path && mtime > 0) recs.push({ p: path, m: mtime, s: size });
  }
  return recs;
}

function snapshot(recs: FileRec[]): Record<string, [number, number]> {
  const snap: Record<string, [number, number]> = {};
  for (const r of recs) snap[r.p] = [r.m, r.s];
  return snap;
}

// 计算本次要打包的文件与删除列表。
function diffFiles(recs: FileRec[], prev: Record<string, [number, number]> | null): { include: FileRec[]; removed: string[] } {
  if (!prev) return { include: recs, removed: [] };
  const include: FileRec[] = [];
  for (const r of recs) {
    const old = prev[r.p];
    if (!old || old[0] !== r.m || old[1] !== r.s) include.push(r);
  }
  const now = new Set(recs.map((r) => r.p));
  const removed = Object.keys(prev).filter((p) => !now.has(p));
  return { include, removed };
}

// 把给定文件列表从实例容器打包成 tar.gz 流（不整包入内存）。
// 文件多时先写清单到容器临时文件，再 tar -T，避免 argv 过长（E2BIG）。
async function packStream(inst: Instance, files: FileRec[]): Promise<NodeJS.ReadableStream> {
  if (!files.length) throw new Error('没有需要备份的文件');
  const listFile = `/config/.woc-chatbk-list-${randomUUID().slice(0, 8)}`;
  // 清单：相对路径（不含前导 /），每行一个；路径安全由 enumerateFiles 的 find 保证（源自容器内真实文件）。
  const manifest = files.map((f) => f.p).join('\n') + '\n';
  await putTextInContainer(inst, listFile, manifest);
  const exec = await execCreate(docker.getContainer(inst.containerName), {
    Cmd: ['tar', '-czf', '-', '-C', '/config', '--no-recursion', '--ignore-failed-read', '-T', listFile],
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    User: 'root',
  });
  const raw = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream & { destroy?: () => void };
  const out = new PassThrough();
  let buf: Buffer = Buffer.alloc(0);
  let need = 0;
  let type = 0;
  let stderr = '';
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
      const part = buf.subarray(0, Math.min(need, buf.length));
      buf = buf.subarray(part.length);
      need -= part.length;
      if (type === 1) {
        if (!out.write(part)) {
          raw.pause();
          out.once('drain', () => raw.resume());
        }
      } else if (type === 2) {
        stderr += part.toString('utf8');
      }
    }
  });
  raw.on('end', async () => {
    // 清理容器里的清单文件（best-effort）
    execCapture(inst, ['rm', '-f', listFile], 'root').catch(() => undefined);
    // 用 tar 退出码判成败，不看 stderr：--ignore-failed-read 会让冻结瞬间消失的 WAL 等瞬态文件
    // 只产生 warning（stderr 非空）但仍成功退出。只有真正非零退出才算失败。
    try {
      const info = await exec.inspect();
      if (info.ExitCode && info.ExitCode !== 0) {
        out.destroy(new Error(`打包失败（tar 退出码 ${info.ExitCode}）：${stderr.trim().slice(0, 300) || '无错误输出'}`));
      } else {
        if (stderr.trim()) appendInstanceLog(inst.id, `聊天备份打包告警（已忽略）：${stderr.trim().slice(0, 300)}`);
        out.end();
      }
    } catch (e) {
      out.destroy(e as Error);
    }
  });
  raw.on('error', (e) => out.destroy(e as Error));
  out.on('close', () => raw.destroy?.());
  return out;
}

// 用 putArchive 写一个小文本文件到容器（复用现有 helper）。
async function putTextInContainer(inst: Instance, absPath: string, text: string): Promise<void> {
  const { tarSingleFile } = await import('./tar.js');
  const name = absPath.replace(/^\//, '');
  await putArchiveStream(inst, Readable.from([tarSingleFile(name, Buffer.from(text, 'utf8'))]), '/');
}

function nowId(kind: BackupKind): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${kind}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupResult {
  entry: BackupEntry;
  skipped: boolean; // 增量无变化时为 true
}

// 执行一次备份。停实例 → 枚举 → 比对 → 打包落盘 → 写 chain → 恢复实例。
// 任何异常都在 finally 恢复实例运行（若原本在运行），绝不把用户实例留在停止态。
export async function runBackup(
  inst: Instance,
  kind: BackupKind,
  onStage: (s: string) => void,
  autoKeep?: number,
): Promise<BackupResult> {
  const chain = readChain(inst.id);
  const last = chain.entries.length ? chain.entries[chain.entries.length - 1] : null;
  if (kind === 'inc' && !last) throw new Error('尚无可用的全量备份，请先执行一次全量备份');
  const dir = backupDir(inst.id);
  mkdirSync(dir, { recursive: true });

  const runtime = await instanceRuntime(inst);
  if (runtime !== 'running') throw new Error('实例未运行（备份需要 docker exec，请先启动实例）');
  onStage('冻结应用（一致快照）');
  const froze = await freezeApp(inst);
  let pendingFile: string | null = null; // 已落盘但还没写进 chain 的包；失败时清理，避免残留 GB 级垃圾
  try {
    onStage('枚举聊天文件');
    const recs = await enumerateFiles(inst);
    if (!recs.length) throw new Error('实例内未找到可备份的聊天数据');
    const { include, removed } = diffFiles(recs, kind === 'inc' && last ? last.map : null);
    if (kind === 'inc' && include.length === 0 && removed.length === 0) {
      onStage('无变化，跳过');
      return { entry: last!, skipped: true };
    }

    const id = nowId(kind);
    const file = `${id}.tar.gz`;
    const dest = join(dir, file);
    onStage(`打包 ${include.length} 个文件`);
    pendingFile = dest;
    const stream = await packStream(inst, include);
    await pipeline(stream, createWriteStream(dest));
    const bytes = statSync(dest).size;
    const snap = snapshot(recs);
    const entry: BackupEntry = {
      id,
      kind,
      file,
      createdAt: Date.now(),
      bytes,
      fileCount: include.length,
      map: snap,
      ...(kind === 'inc' ? { base: last!.id, removed } : {}),
    };
    chain.appType = instanceAppType(inst);
    chain.entries.push(entry);
    writeChain(inst.id, chain);
    pendingFile = null; // 已纳入 chain，归 chain 的保留策略管理
    appendInstanceLog(inst.id, `聊天备份完成：${id}（${kind}，${entry.fileCount} 文件，${(bytes / 1048576).toFixed(1)} MB）`);

    // 保留策略：KEEP = 额外保留的「旧轮次」条目数（默认 0 = 只保留当前轮次）。
    // 绝不删最后一个 full 基线及其后的增量——否则基线被删，后续 inc 无法恢复。
    // 一轮 = 一个 full + 它后面直到下一个 full 之前的所有 inc。
    const keep = autoKeep ?? parseKeep();
    const lastFull = chain.entries.map((e) => e.kind).lastIndexOf('full');
    const canDrop = Math.max(0, lastFull - keep); // 下标 < lastFull 的都是旧轮次
    if (canDrop > 0) {
      const drop = chain.entries.splice(0, canDrop);
      for (const e of drop) {
        try { unlinkSync(join(dir, e.file)); } catch { /* 已删 */ }
      }
      writeChain(inst.id, chain);
    }
    return { entry, skipped: false };
  } finally {
    // 失败且包未纳入 chain 时删除半成品，避免每次失败残留 GB 级文件。
    if (pendingFile) {
      try { unlinkSync(pendingFile); } catch { /* 文件可能不存在 */ }
    }
    // 无论成功失败都必须解冻应用；否则用户微信会一直卡住（这是最严重的事故）。
    onStage('恢复应用运行');
    await froze.resume().catch((e) => appendInstanceLog(inst.id, `聊天备份后恢复应用失败：${(e as any)?.message || e}`));
  }
}

function parseKeep(): number {
  const n = Number(process.env.WOC_CHAT_BACKUP_KEEP || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function listBackups(instId: string): Chain {
  return readChain(instId);
}

export function backupFilePath(instId: string, entryId: string): string | null {
  const chain = readChain(instId);
  const e = chain.entries.find((x) => x.id === entryId);
  if (!e) return null;
  const dir = backupDir(instId);
  const p = join(dir, e.file);
  return existsSync(p) ? p : null;
}

export function deleteBackup(instId: string, entryId: string): boolean {
  const chain = readChain(instId);
  const idx = chain.entries.findIndex((x) => x.id === entryId);
  if (idx < 0) return false;
  const e = chain.entries[idx];
  try { unlinkSync(join(backupDir(instId), e.file)); } catch { /* 已删 */ }
  chain.entries.splice(idx, 1);
  writeChain(instId, chain);
  return true;
}

// 恢复到指定 entry：从它所属的 full 基线开始，按 chain 顺序依次解包每个 inc 到 /config。
// 解包停/启实例；增量包里的 removed 文件按记录删除（best-effort）。
export async function restoreBackup(
  inst: Instance,
  entryId: string,
  onStage: (s: string) => void,
): Promise<void> {
  const chain = readChain(inst.id);
  const idx = chain.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('备份记录不存在（面板可能清理过）');
  const wasRunning = (await instanceRuntime(inst)) === 'running';
  if (wasRunning) {
    onStage('停止实例');
    await stopInstance(inst);
  }
  try {
    // 找到目标 entry 所属的 full 基线
    let baseIdx = idx;
    while (baseIdx > 0 && chain.entries[baseIdx].kind !== 'full') baseIdx--;
    const seq = chain.entries.slice(baseIdx, idx + 1);
    for (const e of seq) {
      const p = backupFilePath(inst.id, e.id);
      if (!p) throw new Error(`备份文件缺失：${e.id}`);
      onStage(`恢复 ${e.id}（${e.kind}）`);
      const tar = createReadStream(p);
      const gunzip = (await import('node:zlib')).default.createGunzip();
      tar.on('error', (err) => gunzip.destroy(err));
      await putArchiveStream(inst, tar.pipe(gunzip), '/');
      // 增量：删除相对上一快照被移除的文件
      if (e.kind === 'inc' && e.removed?.length) {
        onStage('清理已删除的文件');
        for (const rel of e.removed) {
          await execCapture(inst, ['rm', '-f', `/config/${rel}`], 'root').catch(() => undefined);
        }
      }
    }
    appendInstanceLog(inst.id, `聊天备份恢复完成：恢复到 ${entryId}`);
  } finally {
    if (wasRunning) {
      onStage('启动实例');
      await ensureRunning(inst).catch((e) => appendInstanceLog(inst.id, `聊天备份恢复后启动失败：${(e as any)?.message || e}`));
    }
  }
}

// 后台自动增量调度：每 interval 分钟对所有运行中的实例做一次增量；没有全量基线的先建全量。
// 与 version.ts / watchdog 一致用 setInterval().unref()，默认关闭（WOC_CHAT_BACKUP_AUTO=1 才启）。
export function startChatBackupScheduler(instances: () => Instance[], log: (s: string) => void): void {
  if (process.env.WOC_CHAT_BACKUP_AUTO !== '1') return;
  const minutes = Number(process.env.WOC_CHAT_BACKUP_CRON_MIN || 360);
  const ms = (Number.isFinite(minutes) && minutes > 0 ? minutes : 360) * 60 * 1000;
  const tick = async () => {
    for (const inst of instances()) {
      const chain = readChain(inst.id);
      const kind: BackupKind = chain.entries.length ? 'inc' : 'full';
      try {
        const r = await runBackup(inst, kind, () => undefined);
        log(`[chat-backup] ${inst.name} ${kind} ${r.skipped ? '无变化' : '完成'}`);
      } catch (e: any) {
        log(`[chat-backup] ${inst.name} ${kind} 失败：${e?.message || e}`);
      }
    }
  };
  setTimeout(() => void tick(), ms).unref();
  setInterval(() => void tick(), ms).unref();
  log(`[chat-backup] 自动备份已启用 · 间隔 ${minutes} 分钟`);
}
