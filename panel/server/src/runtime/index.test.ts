import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeKindFromEnv } from './index.js';

test('runtime defaults to docker', () => {
  assert.equal(runtimeKindFromEnv(undefined), 'docker');
  assert.equal(runtimeKindFromEnv(''), 'docker');
});

test('runtime accepts docker and kubernetes', () => {
  assert.equal(runtimeKindFromEnv('docker'), 'docker');
  assert.equal(runtimeKindFromEnv('kubernetes'), 'kubernetes');
});

test('runtime trims and lowercases env input', () => {
  assert.equal(runtimeKindFromEnv(' Kubernetes '), 'kubernetes');
});

test('runtime rejects unknown input', () => {
  assert.throws(() => runtimeKindFromEnv('compose'), /Unsupported WOC_RUNTIME/);
});
