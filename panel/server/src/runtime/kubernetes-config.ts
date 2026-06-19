import { existsSync, readFileSync } from 'node:fs';
import * as k8s from '@kubernetes/client-node';

const SERVICEACCOUNT_NAMESPACE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

export interface KubernetesRuntimeConfig {
  namespace: string;
  instanceImage: string;
  puid: string;
  pgid: string;
  timezone: string;
  enableGpu: boolean;
  spoofOs: boolean;
  imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never';
  storageSize: string;
  storageClassName?: string;
  memoryLimitBytes: number;
}

function readNamespaceFromServiceAccount(): string | undefined {
  try {
    if (!existsSync(SERVICEACCOUNT_NAMESPACE)) return undefined;
    const ns = readFileSync(SERVICEACCOUNT_NAMESPACE, 'utf8').trim();
    return ns || undefined;
  } catch {
    return undefined;
  }
}

function imagePullPolicy(value: string | undefined): 'Always' | 'IfNotPresent' | 'Never' {
  if (value === 'Always' || value === 'IfNotPresent' || value === 'Never') return value;
  return 'IfNotPresent';
}

export function parseKubernetesRuntimeConfig(env: NodeJS.ProcessEnv = process.env): KubernetesRuntimeConfig {
  const memGb = Number(env.WOC_INSTANCE_MEM_GB) || 0;
  const storageClassName = (env.WOC_K8S_STORAGE_CLASS || '').trim() || undefined;
  return {
    namespace: (env.WOC_K8S_NAMESPACE || readNamespaceFromServiceAccount() || 'default').trim(),
    instanceImage: env.WOC_WECHAT_IMAGE || 'ghcr.io/gloridust/wechat-on-cloud:latest',
    puid: env.PUID || '1000',
    pgid: env.PGID || '1000',
    timezone: env.TZ || 'Asia/Shanghai',
    enableGpu: env.WOC_ENABLE_GPU === '1',
    spoofOs: env.WOC_SPOOF_OS !== '0',
    imagePullPolicy: imagePullPolicy(env.WOC_K8S_IMAGE_PULL_POLICY),
    storageSize: env.WOC_K8S_STORAGE_SIZE || '10Gi',
    storageClassName,
    memoryLimitBytes: memGb > 0 ? Math.floor(memGb * 1024 * 1024 * 1024) : 0,
  };
}

export function loadKubernetesConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}
