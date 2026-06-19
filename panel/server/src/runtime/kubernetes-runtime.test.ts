import test from 'node:test';
import assert from 'node:assert/strict';
import { podPhaseToRuntimeState, isNotFoundError } from './kubernetes-runtime.js';

test('pod phase maps to runtime state', () => {
  assert.equal(podPhaseToRuntimeState('Running'), 'running');
  assert.equal(podPhaseToRuntimeState('Pending'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Succeeded'), 'stopped');
  assert.equal(podPhaseToRuntimeState('Failed'), 'stopped');
  assert.equal(podPhaseToRuntimeState(undefined), 'stopped');
});

test('isNotFoundError recognizes kubernetes 404 shapes', () => {
  assert.equal(isNotFoundError({ response: { statusCode: 404 } }), true);
  assert.equal(isNotFoundError({ statusCode: 404 }), true);
  assert.equal(isNotFoundError({ code: 404 }), true);
  assert.equal(isNotFoundError({ response: { statusCode: 500 } }), false);
});
