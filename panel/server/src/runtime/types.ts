import type { Instance } from '../store.js';

export type RuntimeKind = 'docker' | 'kubernetes';
export type RuntimeState = 'running' | 'stopped' | 'missing';

export interface WechatStatus {
  phase: string;
  percent: number;
  installed: boolean;
  version: string;
  message: string;
  updatedAt: number;
}

export interface TransferFile {
  name: string;
  size: number;
}

export interface VolEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
}

export interface OrphanVolume {
  name: string;
  createdAt?: string;
  sizeBytes?: number;
}

export interface OrphanContainer {
  id: string;
  name: string;
  status: string;
  volumeName?: string;
}

export interface RuntimeDriver {
  kind: RuntimeKind;
  ensureRuntimeReady(): Promise<void>;
  runInstance(inst: Instance): Promise<void>;
  ensureRunning(inst: Instance): Promise<void>;
  upgradeInstance(inst: Instance): Promise<void>;
  regenInstanceMachineId(inst: Instance): Promise<void>;
  stopInstance(inst: Instance): Promise<void>;
  removeInstance(inst: Instance, purgeVolume: boolean): Promise<void>;
  listOrphanVolumes(referencedVolumes: Set<string>): Promise<OrphanVolume[]>;
  removeVolume(name: string): Promise<void>;
  listOrphanContainers(knownContainerNames: Set<string>): Promise<OrphanContainer[]>;
  removeContainerById(idOrName: string): Promise<void>;
  instanceMemoryMB(inst: Instance): Promise<number>;
  instanceHttpHealthy(inst: Instance, timeoutMs?: number): Promise<boolean>;
  instanceRuntime(inst: Instance): Promise<RuntimeState>;
  triggerWechat(inst: Instance, cmd: 'install' | 'update'): Promise<void>;
  wechatStatus(inst: Instance): Promise<WechatStatus>;
  buildDiagnostics(instances: Instance[], sinceMs: number, meta: Record<string, string>): Promise<Buffer>;
  uploadToInstance(inst: Instance, name: string, content: Buffer): Promise<void>;
  listInstanceFiles(inst: Instance): Promise<TransferFile[]>;
  deleteInstanceFile(inst: Instance, name: string): Promise<void>;
  downloadFromInstance(inst: Instance, name: string): Promise<Buffer>;
  instanceLogs(inst: Instance, tail?: number): Promise<string>;
  typeInInstance(inst: Instance, text: string): Promise<void>;
  keyInInstance(inst: Instance, key: string): Promise<void>;
  listVolume(inst: Instance, rel: string): Promise<{ path: string; entries: VolEntry[] }>;
  volMkdir(inst: Instance, rel: string): Promise<void>;
  volMove(inst: Instance, fromRel: string, toRel: string): Promise<void>;
  volDelete(inst: Instance, rel: string): Promise<void>;
  volUploadFile(inst: Instance, rel: string, name: string, content: Buffer): Promise<void>;
  volExtractArchive(inst: Instance, rel: string, archive: Buffer): Promise<void>;
  volDownloadFile(inst: Instance, rel: string): Promise<Buffer>;
  volBackupStream(inst: Instance): Promise<NodeJS.ReadableStream>;
  volRestoreArchive(inst: Instance, archive: Buffer): Promise<void>;
  instanceTarget(inst: Instance): string;
}
