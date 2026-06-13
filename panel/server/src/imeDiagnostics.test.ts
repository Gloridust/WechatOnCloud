/// <reference types="node" />

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImeServerDiagnostics,
  normalizeImeDiagnosticError,
} from './imeDiagnostics';

test('records bounded ime server diagnostics without storing input text', () => {
  let now = 1_000;
  const diagnostics = new ImeServerDiagnostics({ limit: 2, now: () => now });

  diagnostics.record({
    action: 'type',
    instanceId: 'a',
    startedAt: 990,
    ok: true,
    textLength: 8,
  });
  now = 1_020;
  diagnostics.record({
    action: 'paste',
    instanceId: 'b',
    startedAt: 1_000,
    ok: false,
    textLength: 2,
    error: 'clipboard did not sync expected text',
  });
  now = 1_050;
  diagnostics.record({
    action: 'click',
    instanceId: 'b',
    startedAt: 1_025,
    ok: true,
    xRatio: 0.4,
    yRatio: 0.8,
  });

  assert.deepEqual(diagnostics.entries(), [
    {
      at: 1_020,
      action: 'paste',
      instanceId: 'b',
      durationMs: 20,
      ok: false,
      textLength: 2,
      error: 'clipboard did not sync expected text',
    },
    {
      at: 1_050,
      action: 'click',
      instanceId: 'b',
      durationMs: 25,
      ok: true,
      xRatio: 0.4,
      yRatio: 0.8,
    },
  ]);
  assert.equal(JSON.stringify(diagnostics.entries()).includes('你好'), false);
});

test('normalizes ime diagnostic errors to safe short messages', () => {
  assert.equal(
    normalizeImeDiagnosticError(new Error('clipboard did not sync expected text')),
    'clipboard did not sync expected text',
  );
  assert.equal(
    normalizeImeDiagnosticError({ message: 'x'.repeat(200) }),
    'x'.repeat(117) + '...',
  );
  assert.equal(normalizeImeDiagnosticError(null), 'unknown error');
});
