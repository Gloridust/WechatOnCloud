import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeDriver, RuntimeState, WechatStatus } from './types.js';

test('runtime states are compatible with the existing API contract', () => {
  const states: RuntimeState[] = ['running', 'stopped', 'missing'];
  assert.deepEqual(states, ['running', 'stopped', 'missing']);
});

test('runtime driver can be implemented by a plain object', () => {
  const status: WechatStatus = {
    phase: 'idle',
    percent: 0,
    installed: false,
    version: '',
    message: '未安装',
    updatedAt: 0,
  };

  assert.equal(status.phase, 'idle');

  const keys = [
    'kind',
    'ensureRuntimeReady',
    'runInstance',
    'ensureRunning',
    'upgradeInstance',
    'regenInstanceMachineId',
    'stopInstance',
    'removeInstance',
    'listOrphanVolumes',
    'removeVolume',
    'listOrphanContainers',
    'removeContainerById',
    'instanceMemoryMB',
    'instanceHttpHealthy',
    'instanceRuntime',
    'triggerWechat',
    'wechatStatus',
    'buildDiagnostics',
    'uploadToInstance',
    'listInstanceFiles',
    'deleteInstanceFile',
    'downloadFromInstance',
    'instanceLogs',
    'typeInInstance',
    'keyInInstance',
    'listVolume',
    'volMkdir',
    'volMove',
    'volDelete',
    'volUploadFile',
    'volExtractArchive',
    'volDownloadFile',
    'volBackupStream',
    'volRestoreArchive',
    'instanceTarget',
  ] satisfies Array<keyof RuntimeDriver>;

  assert.equal(keys.includes('instanceTarget'), true);
});
