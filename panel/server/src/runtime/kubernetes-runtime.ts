import http from 'node:http';
import zlib from 'node:zlib';
import * as k8s from '@kubernetes/client-node';
import { appendInstanceLog, deleteInstanceLog, filterSince, readInstanceLog, readPanelLog } from '../logs.js';
import { instanceAppType, type Instance } from '../store.js';
import type { RuntimeDriver, RuntimeState, TransferFile, VolEntry, WechatStatus } from './types.js';
import { loadKubernetesConfig, parseKubernetesRuntimeConfig } from './kubernetes-config.js';
import { INSTANCE_CONTAINER_NAME, buildInstancePod, buildInstancePvc, buildInstanceService } from './kubernetes-manifests.js';
import {
  KubernetesExecHelper,
  TRANSFER_DIR,
  VOL_ROOT,
  extractSingleFileFromTar,
  maybeGunzip,
  relOf,
  safeName,
  safeVolPath,
  tarSingleFile,
} from './kubernetes-exec.js';

const DEFAULT_STATUS: WechatStatus = { phase: 'idle', percent: 0, installed: false, version: '', message: '未安装', updatedAt: 0 };

export function isNotFoundError(e: any): boolean {
  return e?.response?.statusCode === 404 || e?.statusCode === 404 || e?.code === 404;
}

function isConflictError(e: any): boolean {
  return e?.response?.statusCode === 409 || e?.statusCode === 409 || e?.code === 409;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function podPhaseToRuntimeState(phase: string | undefined): RuntimeState {
  return phase === 'Running' ? 'running' : 'stopped';
}

async function ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }
}

export class KubernetesRuntime implements RuntimeDriver {
  readonly kind = 'kubernetes' as const;
  private readonly cfg = parseKubernetesRuntimeConfig();
  // The Kubernetes client is created lazily so that importing this module in
  // Docker mode (the facade statically imports both runtimes) never loads a
  // kubeconfig or contacts the API server.
  private _kubeConfig?: k8s.KubeConfig;
  private _core?: k8s.CoreV1Api;
  private _exec?: KubernetesExecHelper;

  private get kubeConfig(): k8s.KubeConfig {
    return (this._kubeConfig ??= loadKubernetesConfig());
  }

  private get core(): k8s.CoreV1Api {
    return (this._core ??= this.kubeConfig.makeApiClient(k8s.CoreV1Api));
  }

  private get exec(): KubernetesExecHelper {
    return (this._exec ??= new KubernetesExecHelper(this.kubeConfig, this.cfg.namespace));
  }

  async ensureRuntimeReady(): Promise<void> {
    await this.core.readNamespace({ name: this.cfg.namespace });
  }

  async runInstance(inst: Instance): Promise<void> {
    await this.ensurePvc(inst);
    await this.ensureService(inst);
    await this.snapshotPodLog(inst);
    await this.deletePod(inst);
    await this.createPod(inst);
    appendInstanceLog(inst.id, 'Pod 已启动');
  }

  async ensureRunning(inst: Instance): Promise<void> {
    try {
      const pod = await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName });
      if (pod.status?.phase === 'Running' || pod.status?.phase === 'Pending') return;
      await this.runInstance(inst);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.runInstance(inst);
    }
  }

  async upgradeInstance(inst: Instance): Promise<void> {
    await this.runInstance(inst);
  }

  async regenInstanceMachineId(inst: Instance): Promise<void> {
    // Old images lack the identity hook, so a restart would NOT roll a new machine-id — reject loudly
    // instead of silently no-op'ing (parity with the Docker runtime).
    const hasHook = (await this.exec.execCapture(inst, ['sh', '-c', 'test -f /custom-cont-init.d/00-woc-identity && echo yes || echo no'])).trim();
    if (hasHook !== 'yes') {
      throw new Error('该实例运行的是旧镜像（无设备身份模块），请先「升级实例」后再重置设备 ID');
    }
    await this.exec.execCapture(inst, ['sh', '-c', 'rm -f /config/.woc-machine-id']);
    await this.stopInstance(inst);
    await this.runInstance(inst);
  }

  async stopInstance(inst: Instance): Promise<void> {
    await this.deletePod(inst);
    appendInstanceLog(inst.id, 'Pod 已停止');
  }

  async removeInstance(inst: Instance, purgeVolume: boolean): Promise<void> {
    await this.deletePod(inst);
    await ignoreNotFound(() => this.core.deleteNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName }));
    if (purgeVolume) {
      await ignoreNotFound(() => this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName }));
      deleteInstanceLog(inst.id);
    }
  }

  async listOrphanVolumes(referencedVolumes: Set<string>) {
    const pvcs = await this.core.listNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace });
    return (pvcs.items || [])
      .filter((pvc) => pvc.metadata?.name?.startsWith('woc-data-') && !referencedVolumes.has(pvc.metadata.name))
      .map((pvc) => ({
        name: pvc.metadata!.name!,
        createdAt: pvc.metadata?.creationTimestamp ? new Date(pvc.metadata.creationTimestamp).toISOString() : undefined,
      }));
  }

  async removeVolume(name: string): Promise<void> {
    await this.core.deleteNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name });
  }

  async listOrphanContainers(knownContainerNames: Set<string>) {
    const pods = await this.core.listNamespacedPod({ namespace: this.cfg.namespace });
    return (pods.items || [])
      .filter((pod) => pod.metadata?.name?.startsWith('woc-wx-') && !knownContainerNames.has(pod.metadata.name))
      .map((pod) => ({
        id: pod.metadata?.uid || pod.metadata!.name!,
        name: pod.metadata!.name!,
        status: pod.status?.phase || '',
        volumeName: pod.spec?.volumes?.find((v) => v.persistentVolumeClaim?.claimName?.startsWith('woc-data-'))?.persistentVolumeClaim?.claimName,
      }));
  }

  async removeContainerById(idOrName: string): Promise<void> {
    await this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: idOrName });
  }

  async instanceMemoryMB(): Promise<number> {
    return 0;
  }

  async instanceHttpHealthy(inst: Instance, timeoutMs = 8000): Promise<boolean> {
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
          const ok = !!res.statusCode && res.statusCode < 500;
          res.resume();
          done(ok);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    });
  }

  async instanceRuntime(inst: Instance): Promise<RuntimeState> {
    try {
      const pod = await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName });
      return podPhaseToRuntimeState(pod.status?.phase);
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      const hasData = await this.hasPvcOrService(inst);
      return hasData ? 'stopped' : 'missing';
    }
  }

  async triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void> {
    const at = instanceAppType(inst);
    const action = cmd === 'update' ? 'update' : 'install';
    // Docker fires install/update with a detached exec and returns immediately while it runs (the UI
    // polls wechatStatus for progress). Mirror that: background the work with detached stdio and exit
    // the foreground shell so the exec session closes right away, instead of blocking the HTTP request
    // for the whole multi-minute install (which would hang or time out). at/action come from fixed
    // enums, so the interpolation is safe.
    const inner = `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} ${action}; else /woc/wechat-ctl.sh ${action}; fi`;
    await this.exec.execCapture(inst, ['sh', '-c', `nohup sh -c '${inner}' >/dev/null 2>&1 </dev/null & exit 0`]);
  }

  async wechatStatus(inst: Instance): Promise<WechatStatus> {
    try {
      const at = instanceAppType(inst);
      const raw = await this.exec.execCapture(inst, ['bash', '-c', `if [ -x /woc/app-ctl.sh ]; then /woc/app-ctl.sh ${at} status; else /woc/wechat-ctl.sh status; fi`]);
      return { ...DEFAULT_STATUS, ...JSON.parse(raw.trim()) };
    } catch {
      return DEFAULT_STATUS;
    }
  }

  async buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer> {
    const entries: { name: string; content: string | Buffer }[] = [];
    entries.push({ name: 'README.txt', content: `云微 · WechatOnCloud Kubernetes 诊断包\n生成时间: ${new Date().toISOString()}\n` });
    entries.push({ name: 'panel.log', content: filterSince(readPanelLog(), sinceMs) || '（无面板日志）' });
    let system = `runtime: kubernetes\nnamespace: ${this.cfg.namespace}\nimage: ${this.cfg.instanceImage}\n`;
    for (const [k, v] of Object.entries(meta)) system += `${k}: ${v}\n`;
    entries.push({ name: 'system.txt', content: system });
    for (const inst of instances) {
      let text = `实例: ${inst.name}\nID: ${inst.id}\nPod: ${inst.containerName}\n类型: ${instanceAppType(inst)}\nPVC: ${inst.volumeName}\n创建: ${inst.createdAt}\n\n`;
      text += `===== 持久化日志 =====\n${filterSince(readInstanceLog(inst.id), sinceMs) || '（无）'}\n\n`;
      try {
        text += `===== Pod 日志 =====\n${await this.instanceLogs(inst, 300)}\n`;
      } catch (e: any) {
        text += `===== Pod 日志 =====\n获取失败：${e?.message || e}\n`;
      }
      entries.push({ name: `instances/${inst.id}.log`, content: text });
    }
    return buildTarGz(entries);
  }

  async uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.putTar(inst, TRANSFER_DIR, tarSingleFile(name, content));
  }

  async listInstanceFiles(inst: Instance): Promise<TransferFile[]> {
    const out = await this.exec.execCapture(inst, ['sh', '-c', `find ${TRANSFER_DIR} -maxdepth 1 -type f -printf '%f\\t%s\\n' 2>/dev/null`]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, size] = line.split('\t');
      return { name, size: Number(size) || 0 };
    });
  }

  async deleteInstanceFile(inst: Instance, name: string): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.execCapture(inst, ['rm', '-f', `${TRANSFER_DIR}/${name}`]);
  }

  async downloadFromInstance(inst: Instance, name: string): Promise<Buffer> {
    if (!safeName(name)) throw new Error('文件名不合法');
    return extractSingleFileFromTar(await this.exec.getTar(inst, `${TRANSFER_DIR}/${name}`));
  }

  async instanceLogs(inst: Instance, tail = 600): Promise<string> {
    return await this.core.readNamespacedPodLog({ namespace: this.cfg.namespace, name: inst.containerName, container: INSTANCE_CONTAINER_NAME, tailLines: tail, timestamps: true });
  }

  async typeInInstance(inst: Instance, text: string): Promise<void> {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const cmd = [
      'set -e',
      'display="${DISPLAY:-}"',
      'if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":${x##*X}"; break; done; fi',
      'export DISPLAY="${display:-:1}"',
      'command -v xclip >/dev/null 2>&1 || { echo "xclip not installed in instance image" >&2; exit 127; }',
      'command -v xdotool >/dev/null 2>&1 || { echo "xdotool not installed in instance image" >&2; exit 127; }',
      `echo '${b64}' | base64 -d | xclip -selection clipboard -i >/dev/null 2>&1`,
      'xdotool key --clearmodifiers ctrl+v',
    ].join('; ');
    await this.exec.execCapture(inst, ['bash', '-c', cmd]);
  }

  async keyInInstance(inst: Instance, key: string): Promise<void> {
    if (!/^[A-Za-z_]{1,20}$/.test(key)) throw new Error('按键名不合法');
    await this.exec.execCapture(inst, ['bash', '-c', `xdotool key --clearmodifiers ${key}`]);
  }

  async listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }> {
    const abs = safeVolPath(rel);
    const out = await this.exec.execCapture(inst, ['find', abs, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\n']);
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

  async volMkdir(inst: Instance, rel: string): Promise<void> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('路径不合法');
    await this.exec.execCapture(inst, ['mkdir', '-p', abs]);
  }

  async volMove(inst: Instance, fromRel: string, toRel: string): Promise<void> {
    const from = safeVolPath(fromRel);
    const to = safeVolPath(toRel);
    if (from === VOL_ROOT || to === VOL_ROOT) throw new Error('不能移动数据卷根目录');
    if (from === to) return;
    await this.exec.execCapture(inst, ['mv', '-f', from, to]);
  }

  async volDelete(inst: Instance, rel: string): Promise<void> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('不能删除数据卷根目录');
    await this.exec.execCapture(inst, ['rm', '-rf', abs]);
  }

  async volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void> {
    if (!safeName(name)) throw new Error('文件名不合法');
    await this.exec.putTar(inst, safeVolPath(rel), tarSingleFile(name, content));
  }

  async volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void> {
    await this.exec.putTar(inst, safeVolPath(rel), maybeGunzip(archive));
  }

  async volDownloadFile(inst: Instance, rel: string): Promise<Buffer> {
    const abs = safeVolPath(rel);
    if (abs === VOL_ROOT) throw new Error('不能下载整个根目录，请用整卷备份');
    return extractSingleFileFromTar(await this.exec.getTar(inst, abs));
  }

  async volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream> {
    // Stream the tar straight through gzip to the HTTP response instead of buffering the whole
    // /config volume (and its gzip) in panel memory — mirrors Docker's getArchive().pipe(createGzip()).
    const tarStream = await this.exec.getTarStream(inst, VOL_ROOT);
    const gzip = zlib.createGzip();
    tarStream.on('error', (e) => gzip.destroy(e));
    return tarStream.pipe(gzip);
  }

  async volRestoreArchive(inst: Instance, archive: Buffer): Promise<void> {
    await this.exec.putTar(inst, '/', maybeGunzip(archive));
  }

  instanceTarget(inst: Instance): string {
    return `http://${inst.containerName}:3000`;
  }

  private async ensurePvc(inst: Instance): Promise<void> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName });
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      await this.core.createNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, body: buildInstancePvc(inst, this.cfg) });
    }
  }

  private async ensureService(inst: Instance): Promise<void> {
    try {
      // The selector/ports never change between rebuilds, so an existing Service is left as-is.
      // Replacing it with a fresh body would clear the immutable spec.clusterIP → rejected with 422.
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName });
      return;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    await this.core.createNamespacedService({ namespace: this.cfg.namespace, body: buildInstanceService(inst, this.cfg) });
  }

  private async createPod(inst: Instance): Promise<void> {
    const body = buildInstancePod(inst, this.cfg);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.core.createNamespacedPod({ namespace: this.cfg.namespace, body });
        return;
      } catch (e) {
        // A prior Pod with the same name may still be Terminating; wait for it to disappear and retry.
        if (isConflictError(e) && attempt < 30) {
          await this.waitForPodGone(inst.containerName, 1000);
          continue;
        }
        throw e;
      }
    }
  }

  private async deletePod(inst: Instance): Promise<void> {
    try {
      // gracePeriodSeconds: 0 force-deletes immediately (parity with Docker's remove({ force: true })).
      await this.core.deleteNamespacedPod({ namespace: this.cfg.namespace, name: inst.containerName, gracePeriodSeconds: 0 });
    } catch (e) {
      if (isNotFoundError(e)) return;
      throw e;
    }
    // Deletion is asynchronous — the API accepts it while the Pod lingers in Terminating. Wait until it
    // is actually gone so a same-named create on rebuild/upgrade/self-heal does not hit a 409 conflict.
    await this.waitForPodGone(inst.containerName);
  }

  private async waitForPodGone(name: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.core.readNamespacedPod({ namespace: this.cfg.namespace, name });
      } catch (e) {
        if (isNotFoundError(e)) return;
        throw e;
      }
      if (Date.now() >= deadline) return;
      await delay(300);
    }
  }

  private async snapshotPodLog(inst: Instance): Promise<void> {
    // Persist the dying Pod's last lines before a rebuild so "上次为何停/崩" survives (parity with
    // Docker's snapshotContainerLog). Best-effort: on first create there is no Pod yet.
    try {
      const logs = (await this.instanceLogs(inst, 200)).trimEnd();
      if (logs) {
        appendInstanceLog(inst.id, `──── 容器重建（重启/升级/自愈），保留上一容器最后日志 ────\n${logs}\n──── 上一容器日志快照结束 ────`);
      }
    } catch {
      /* 首次创建时尚无 Pod，忽略 */
    }
  }

  private async hasPvcOrService(inst: Instance): Promise<boolean> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ namespace: this.cfg.namespace, name: inst.volumeName });
      return true;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
    }
    try {
      await this.core.readNamespacedService({ namespace: this.cfg.namespace, name: inst.containerName });
      return true;
    } catch (e) {
      if (!isNotFoundError(e)) throw e;
      return false;
    }
  }
}

function tarEntry(name: string, content: Buffer): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([h, content, Buffer.alloc(pad, 0)]);
}

function buildTarGz(entries: { name: string; content: string | Buffer }[]): Buffer {
  const parts = entries.map((e) => tarEntry(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8')));
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

export const kubernetesRuntime = new KubernetesRuntime();
