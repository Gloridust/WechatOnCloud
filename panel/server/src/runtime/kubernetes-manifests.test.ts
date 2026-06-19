import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstancePod, buildInstancePvc, buildInstanceService, instanceLabels } from './kubernetes-manifests.js';
import type { KubernetesRuntimeConfig } from './kubernetes-config.js';
import type { Instance } from '../store.js';

const inst: Instance = {
  id: 'abc123def0',
  name: '测试实例',
  appType: 'chromium',
  containerName: 'woc-wx-abc123def0',
  volumeName: 'woc-data-abc123def0',
  kasmUser: 'woc',
  kasmPassword: 'secret',
  createdAt: '2026-06-18T00:00:00.000Z',
  createdBy: 'admin',
};

const cfg: KubernetesRuntimeConfig = {
  namespace: 'wechat',
  instanceImage: 'example.com/wechat-on-cloud:1.2.3',
  puid: '1000',
  pgid: '1000',
  timezone: 'Asia/Hong_Kong',
  enableGpu: false,
  spoofOs: true,
  imagePullPolicy: 'Always',
  storageSize: '20Gi',
  storageClassName: 'fast',
  memoryLimitBytes: 2147483648,
};

test('instance labels are stable and searchable', () => {
  assert.deepEqual(instanceLabels(inst), {
    'app.kubernetes.io/name': 'wechat-on-cloud',
    'app.kubernetes.io/component': 'instance',
    'woc.gloridust.io/instance-id': 'abc123def0',
  });
});

test('buildInstancePvc creates persistent config storage', () => {
  const pvc = buildInstancePvc(inst, cfg);
  assert.equal(pvc.metadata?.name, 'woc-data-abc123def0');
  assert.equal(pvc.metadata?.namespace, 'wechat');
  assert.equal(pvc.spec?.resources?.requests?.storage, '20Gi');
  assert.equal(pvc.spec?.storageClassName, 'fast');
});

test('buildInstanceService exposes KasmVNC HTTP inside the namespace', () => {
  const svc = buildInstanceService(inst, cfg);
  assert.equal(svc.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(svc.spec?.ports?.[0]?.port, 3000);
  assert.equal(svc.spec?.selector?.['woc.gloridust.io/instance-id'], 'abc123def0');
});

test('buildInstancePod maps config PVC and shm memory volume', () => {
  const pod = buildInstancePod(inst, cfg);
  const container = pod.spec?.containers?.[0];

  assert.equal(pod.metadata?.name, 'woc-wx-abc123def0');
  assert.equal(pod.spec?.restartPolicy, 'Always');
  assert.equal(container?.name, 'instance');
  assert.equal(container?.image, 'example.com/wechat-on-cloud:1.2.3');
  assert.equal(container?.imagePullPolicy, 'Always');
  assert.equal(container?.ports?.[0]?.containerPort, 3000);
  assert.equal(container?.env?.some((e) => e.name === 'DISABLE_DRI' && e.value === '1'), true);
  assert.equal(container?.env?.some((e) => e.name === 'WOC_APP_TYPE' && e.value === 'chromium'), true);
  assert.equal(container?.resources?.limits?.memory, '2147483648');
  assert.equal(pod.spec?.securityContext?.seccompProfile?.type, 'Unconfined');
  assert.equal(pod.spec?.volumes?.some((v) => v.name === 'config' && v.persistentVolumeClaim?.claimName === 'woc-data-abc123def0'), true);
  assert.equal(pod.spec?.volumes?.some((v) => v.name === 'shm' && v.emptyDir?.medium === 'Memory'), true);
});
