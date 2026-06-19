import type { RuntimeKind } from './types.js';
import { dockerRuntime } from './docker-runtime.js';

export function runtimeKindFromEnv(value: string | undefined): RuntimeKind {
  const normalized = (value || 'docker').trim().toLowerCase();
  if (!normalized || normalized === 'docker') return 'docker';
  if (normalized === 'kubernetes' || normalized === 'k8s') return 'kubernetes';
  throw new Error(`Unsupported WOC_RUNTIME="${value}". Expected "docker" or "kubernetes".`);
}

const selectedKind = runtimeKindFromEnv(process.env.WOC_RUNTIME);

// Task 9/11 replaces the kubernetes branch with the real kubernetesRuntime.
export const runtime = selectedKind === 'docker'
  ? dockerRuntime
  : dockerRuntime;

// Methods are re-exported bound to `runtime` so that a class-based driver
// (the Kubernetes runtime) keeps its `this` when called as a free function.
export const ensureNetwork = runtime.ensureRuntimeReady.bind(runtime);
export const runInstance = runtime.runInstance.bind(runtime);
export const ensureRunning = runtime.ensureRunning.bind(runtime);
export const upgradeInstance = runtime.upgradeInstance.bind(runtime);
export const regenInstanceMachineId = runtime.regenInstanceMachineId.bind(runtime);
export const stopInstance = runtime.stopInstance.bind(runtime);
export const removeInstance = runtime.removeInstance.bind(runtime);
export const listOrphanVolumes = runtime.listOrphanVolumes.bind(runtime);
export const removeVolume = runtime.removeVolume.bind(runtime);
export const listOrphanContainers = runtime.listOrphanContainers.bind(runtime);
export const removeContainerById = runtime.removeContainerById.bind(runtime);
export const instanceMemoryMB = runtime.instanceMemoryMB.bind(runtime);
export const instanceHttpHealthy = runtime.instanceHttpHealthy.bind(runtime);
export const instanceRuntime = runtime.instanceRuntime.bind(runtime);
export const triggerWechat = runtime.triggerWechat.bind(runtime);
export const wechatStatus = runtime.wechatStatus.bind(runtime);
export const buildDiagnostics = runtime.buildDiagnostics.bind(runtime);
export const uploadToInstance = runtime.uploadToInstance.bind(runtime);
export const listInstanceFiles = runtime.listInstanceFiles.bind(runtime);
export const deleteInstanceFile = runtime.deleteInstanceFile.bind(runtime);
export const downloadFromInstance = runtime.downloadFromInstance.bind(runtime);
export const instanceLogs = runtime.instanceLogs.bind(runtime);
export const typeInInstance = runtime.typeInInstance.bind(runtime);
export const keyInInstance = runtime.keyInInstance.bind(runtime);
export const listVolume = runtime.listVolume.bind(runtime);
export const volMkdir = runtime.volMkdir.bind(runtime);
export const volMove = runtime.volMove.bind(runtime);
export const volDelete = runtime.volDelete.bind(runtime);
export const volUploadFile = runtime.volUploadFile.bind(runtime);
export const volExtractArchive = runtime.volExtractArchive.bind(runtime);
export const volDownloadFile = runtime.volDownloadFile.bind(runtime);
export const volBackupStream = runtime.volBackupStream.bind(runtime);
export const volRestoreArchive = runtime.volRestoreArchive.bind(runtime);
export const instanceTarget = runtime.instanceTarget.bind(runtime);
