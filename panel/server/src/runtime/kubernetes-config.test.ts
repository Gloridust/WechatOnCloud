import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKubernetesRuntimeConfig } from './kubernetes-config.js';

test('kubernetes runtime config has practical defaults', () => {
  const cfg = parseKubernetesRuntimeConfig({});
  assert.equal(cfg.namespace, 'default');
  assert.equal(cfg.instanceImage, 'ghcr.io/gloridust/wechat-on-cloud:latest');
  assert.equal(cfg.puid, '1000');
  assert.equal(cfg.pgid, '1000');
  assert.equal(cfg.timezone, 'Asia/Shanghai');
  assert.equal(cfg.enableGpu, false);
  assert.equal(cfg.spoofOs, true);
  assert.equal(cfg.imagePullPolicy, 'IfNotPresent');
  assert.equal(cfg.storageSize, '10Gi');
  assert.equal(cfg.storageClassName, undefined);
});

test('kubernetes runtime config reads env overrides', () => {
  const cfg = parseKubernetesRuntimeConfig({
    WOC_K8S_NAMESPACE: 'wechat',
    WOC_WECHAT_IMAGE: 'example.com/woc/wechat:1.2.3',
    PUID: '1001',
    PGID: '1002',
    TZ: 'Asia/Hong_Kong',
    WOC_ENABLE_GPU: '1',
    WOC_SPOOF_OS: '0',
    WOC_K8S_IMAGE_PULL_POLICY: 'Always',
    WOC_K8S_STORAGE_SIZE: '25Gi',
    WOC_K8S_STORAGE_CLASS: 'fast',
    WOC_INSTANCE_MEM_GB: '3',
  });

  assert.equal(cfg.namespace, 'wechat');
  assert.equal(cfg.instanceImage, 'example.com/woc/wechat:1.2.3');
  assert.equal(cfg.puid, '1001');
  assert.equal(cfg.pgid, '1002');
  assert.equal(cfg.timezone, 'Asia/Hong_Kong');
  assert.equal(cfg.enableGpu, true);
  assert.equal(cfg.spoofOs, false);
  assert.equal(cfg.imagePullPolicy, 'Always');
  assert.equal(cfg.storageSize, '25Gi');
  assert.equal(cfg.storageClassName, 'fast');
  assert.equal(cfg.memoryLimitBytes, 3221225472);
});
