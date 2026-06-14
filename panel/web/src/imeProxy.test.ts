/// <reference types="node" />

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImeCommitBuffer,
  ImeInstanceTextQueue,
  ImeDiagnostics,
  ImeRemoteTextSender,
  ImeTransportHealth,
  ImeTransportProbe,
  imeProxyCommitTransport,
  imeProxyEventPoint,
  imeProxyFrameMatchesInstance,
  imeProxyFrameRectFromViewportGeometry,
  imeProxyFrameViewportGeometry,
  imeProxyRemoteClickPoint,
  imeProxyClassName,
  imeProxyMobileViewportPosition,
  imeProxyPositionFromFrameClick,
  imeProxyShouldFocus,
  imeProxyShouldApplySwitchCleanup,
  imeProxyShortcutKey,
  imeProxyShouldProbeOnFocusActivation,
  imeProxyShouldPreClickRemoteFocus,
  imeProxyShouldActivateFromFrameClick,
  imeProxyShouldSkipDuplicateActivation,
} from './imeProxy';

test('commits latin text, numbers, and punctuation immediately', () => {
  const commits: string[] = [];
  const buffer = new ImeCommitBuffer((text) => commits.push(text));

  buffer.input('a');
  buffer.input('1');
  buffer.input(',');

  assert.deepEqual(commits, ['a', '1', ',']);
});

test('holds composing text until composition end', () => {
  const commits: string[] = [];
  const buffer = new ImeCommitBuffer((text) => commits.push(text));

  buffer.compositionStart();
  buffer.input('ni', true);
  buffer.input('你', true);
  buffer.compositionEnd('你');

  assert.deepEqual(commits, ['你']);
});

test('deduplicates the browser input event that follows composition end', () => {
  const commits: string[] = [];
  const buffer = new ImeCommitBuffer((text) => commits.push(text));

  buffer.compositionStart();
  buffer.input('zhong', true);
  buffer.compositionEnd('中');
  buffer.input('中');

  assert.deepEqual(commits, ['中']);
});

test('updates the commit target when switching instances', () => {
  const commits: string[] = [];
  const buffer = new ImeCommitBuffer((text) => commits.push(`a:${text}`));

  buffer.input('1');
  buffer.setCommit((text) => commits.push(`b:${text}`));
  buffer.input('2');

  assert.deepEqual(commits, ['a:1', 'b:2']);
});

test('clears composition dedupe state when switching instances', () => {
  const commits: string[] = [];
  const buffer = new ImeCommitBuffer((text) => commits.push(text));

  buffer.compositionStart();
  buffer.compositionEnd('中');
  buffer.reset();
  buffer.input('中');

  assert.deepEqual(commits, ['中', '中']);
});

test('drops queued text from the previous instance after switching instances', async () => {
  const sent: string[] = [];
  let releaseFirst: () => void = () => undefined;
  let markFirstStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstSend = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (text === 'old') markFirstStarted();
      if (text === 'old') await firstSend;
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.enqueue('a', 'old');
  queue.enqueue('a', 'stale');
  await firstStarted;
  queue.reset();
  queue.enqueue('b', 'fresh');
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old', 'b:fresh']);
});

test('updates queue send handler without dropping the current instance', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`old:${instanceId}:${text}`);
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.setHandlers(
    async (instanceId, text) => {
      sent.push(`new:${instanceId}:${text}`);
    },
    () => undefined,
  );
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['new:b:fresh']);
});

test('batches rapid text by default to avoid one remote call per latin character', async () => {
  const sent: string[] = [];
  let releaseBatch: () => void = () => undefined;
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      wait: async (ms) => {
        assert.equal(ms, 16);
        await new Promise<void>((resolve) => {
          releaseBatch = resolve;
        });
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  queue.enqueue('a', ',');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  releaseBatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:a1,']);
});

test('sends non-ascii committed text immediately by default', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      wait: async () => {
        throw new Error('non-ascii text should not wait for the batch timer');
      },
    },
  );

  queue.enqueue('a', '你');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:你']);
});

test('flushes pending latin batch before sending non-ascii text immediately', async () => {
  const sent: string[] = [];
  let flushBatch: () => void = () => undefined;
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      wait: async () => {
        await new Promise<void>((resolve) => {
          flushBatch = resolve;
        });
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  await new Promise((resolve) => setTimeout(resolve, 0));

  queue.enqueue('a', '你');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:a1', 'a:你']);

  flushBatch();
});

test('does not block a different instance behind a slow send', async () => {
  const sent: string[] = [];
  let releaseA: () => void = () => undefined;
  let markAStarted: () => void = () => undefined;
  const aStarted = new Promise<void>((resolve) => {
    markAStarted = resolve;
  });
  const aSend = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (instanceId === 'a') {
        markAStarted();
        await aSend;
      }
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.enqueue('a', 'slow');
  await aStarted;
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:slow', 'b:fresh']);

  releaseA();
});

test('keeps sends ordered within the same instance', async () => {
  const sent: string[] = [];
  let releaseFirst: () => void = () => undefined;
  let markFirstStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstSend = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (text === 'first') {
        markFirstStarted();
        await firstSend;
      }
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.enqueue('a', 'first');
  await firstStarted;
  queue.enqueue('a', 'second');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:first']);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:first', 'a:second']);
});

test('keeps same-instance order after switching away and back', async () => {
  const sent: string[] = [];
  let releaseFirst: () => void = () => undefined;
  let markFirstStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstSend = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (instanceId === 'a' && text === 'first') {
        markFirstStarted();
        await firstSend;
      }
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.enqueue('a', 'first');
  await firstStarted;
  queue.reset();
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.reset();
  queue.enqueue('a', 'second');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:first', 'b:fresh']);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:first', 'b:fresh', 'a:second']);
});

test('batches consecutive text for the same instance into one send', async () => {
  const sent: string[] = [];
  let flushBatch: () => void = () => undefined;
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      batchMs: 10,
      wait: async (ms) => {
        if (ms === 10) {
          await new Promise<void>((resolve) => {
            flushBatch = resolve;
          });
        }
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  queue.enqueue('a', ',');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  flushBatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:a1,']);
});

test('records diagnostics for queued batch delay before sending', async () => {
  let now = 1_000;
  const diagnostics = new ImeDiagnostics({ now: () => now });
  const sent: string[] = [];
  let flushBatch: () => void = () => undefined;
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      now = 1_020;
    },
    () => undefined,
    {
      diagnostics,
      batchMs: 10,
      wait: async (ms) => {
        assert.equal(ms, 10);
        await new Promise<void>((resolve) => {
          flushBatch = resolve;
        });
        now = 1_010;
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  queue.enqueue('a', ',');
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushBatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:a1,']);
  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      durationMs: entry.durationMs,
      textLength: entry.textLength,
    })),
    [
      {
        event: 'queue-batch-start',
        instanceId: 'a',
        durationMs: undefined,
        textLength: 1,
      },
      {
        event: 'queue-batch-flush',
        instanceId: 'a',
        durationMs: 10,
        textLength: 3,
      },
      {
        event: 'queue-send-start',
        instanceId: 'a',
        durationMs: 10,
        textLength: 3,
      },
      {
        event: 'queue-send-complete',
        instanceId: 'a',
        durationMs: 20,
        textLength: 3,
      },
    ],
  );
});

test('flushes pending batched text before resetting to another instance', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    { batchMs: 10, wait: async () => undefined },
  );

  queue.enqueue('a', 'old');
  queue.reset();
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['b:fresh']);
});

test('can flush pending batched text before an instance switch reset', async () => {
  const sent: string[] = [];
  let releaseBatch: () => void = () => undefined;
  const batchReady = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      wait: async () => {
        await batchReady;
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  await queue.flushAndReset();
  queue.enqueue('b', 'fresh');

  assert.deepEqual(sent, ['a:a1']);

  releaseBatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:a1', 'b:fresh']);
});

test('does not let an old async reset drop text typed after switching instances', async () => {
  const sent: string[] = [];
  let releaseASend: () => void = () => undefined;
  const aSend = new Promise<void>((resolve) => {
    releaseASend = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (instanceId === 'a') await aSend;
    },
    () => undefined,
    {
      batchMs: 0,
    },
  );

  queue.enqueue('a', 'old');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const switching = queue.flushAndReset();
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old', 'b:fresh']);

  releaseASend();
  await switching;
  queue.enqueue('b', 'later');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old', 'b:fresh', 'b:later']);
});

test('does not let an old async reset drop a new instance pending batch', async () => {
  const sent: string[] = [];
  let releaseASend: () => void = () => undefined;
  let releaseBatch: () => void = () => undefined;
  const aSend = new Promise<void>((resolve) => {
    releaseASend = resolve;
  });
  const batchReady = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      if (instanceId === 'a') await aSend;
    },
    () => undefined,
    {
      wait: async () => {
        await batchReady;
      },
    },
  );

  queue.enqueue('a', 'old');
  const switching = queue.flushAndReset();
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old']);

  releaseASend();
  await switching;
  releaseBatch();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old', 'b:fresh']);
});

test('skips stale switch cleanup after new proxy activity', () => {
  assert.equal(
    imeProxyShouldApplySwitchCleanup({
      alive: true,
      startedSeq: 4,
      currentSeq: 5,
    }),
    false,
  );
});

test('applies switch cleanup while still current', () => {
  assert.equal(
    imeProxyShouldApplySwitchCleanup({
      alive: true,
      startedSeq: 4,
      currentSeq: 4,
    }),
    true,
  );
});

test('skips switch cleanup after effect disposal', () => {
  assert.equal(
    imeProxyShouldApplySwitchCleanup({
      alive: false,
      startedSeq: 4,
      currentSeq: 4,
    }),
    false,
  );
});

test('flushes a pending batch before remote shortcut keys run', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      wait: async () => {
        await new Promise<void>(() => undefined);
      },
    },
  );

  queue.enqueue('a', 'a');
  queue.enqueue('a', '1');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  await queue.flush('a');

  assert.deepEqual(sent, ['a:a1']);
});

test('flushes pending batched text before starting a different instance batch', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    { batchMs: 10, wait: async () => undefined },
  );

  queue.enqueue('a', 'old');
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:old', 'b:fresh']);
});

test('passes the latest remote focus after the remote click is ready', async () => {
  const sent: string[] = [];
  let releaseFocus: () => void = () => undefined;
  const focusReady = new Promise<void>((resolve) => {
    releaseFocus = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text, focus) => {
      sent.push(`${instanceId}:${text}:${focus?.xRatio}:${focus?.yRatio}`);
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.setFocus(
    'a',
    { xRatio: 0.5, yRatio: 0.8 },
    focusReady,
  );
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  releaseFocus();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:hello:0.5:0.8']);
});

test('records diagnostics when remote focus is set for an instance', () => {
  const diagnostics = new ImeDiagnostics({ now: () => 1_000 });
  const queue = new ImeInstanceTextQueue(
    async () => undefined,
    () => undefined,
    { diagnostics, batchMs: 0 },
  );

  queue.setFocus(
    'b',
    { xRatio: 0.42, yRatio: 0.88 },
    Promise.resolve(),
  );

  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      xRatio: entry.xRatio,
      yRatio: entry.yRatio,
    })),
    [
      {
        event: 'queue-focus-set',
        instanceId: 'b',
        xRatio: 0.42,
        yRatio: 0.88,
      },
    ],
  );
});

test('waits briefly for remote focus before sending text', async () => {
  const sent: string[] = [];
  let releaseFocus: () => void = () => undefined;
  const focusReady = new Promise<void>((resolve) => {
    releaseFocus = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.setFocus('a', { xRatio: 0.5, yRatio: 0.8 }, focusReady);
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  releaseFocus();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:hello']);
});

test('uses a short default remote focus wait budget', async () => {
  const sent: string[] = [];
  let waitedMs: number | null = null;
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    {
      batchMs: 0,
      wait: async (ms) => {
        waitedMs = ms;
      },
    },
  );

  queue.setFocus('a', { xRatio: 0.5, yRatio: 0.8 }, new Promise(() => undefined));
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(waitedMs, 20);
  assert.deepEqual(sent, ['a:hello']);
});

test('records diagnostics for focus wait before queued send', async () => {
  let now = 1_000;
  const diagnostics = new ImeDiagnostics({ now: () => now });
  const sent: string[] = [];
  let releaseFocus: () => void = () => undefined;
  const focusReady = new Promise<void>((resolve) => {
    releaseFocus = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
      now = 1_020;
    },
    () => undefined,
    { diagnostics, batchMs: 0 },
  );

  queue.setFocus('a', { xRatio: 0.5, yRatio: 0.8 }, focusReady);
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));

  now = 1_012;
  releaseFocus();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:hello']);
  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      durationMs: entry.durationMs,
      textLength: entry.textLength,
    })),
    [
      {
        event: 'queue-focus-set',
        instanceId: 'a',
        durationMs: undefined,
        textLength: undefined,
      },
      {
        event: 'queue-send-start',
        instanceId: 'a',
        durationMs: 0,
        textLength: 5,
      },
      {
        event: 'queue-focus-wait',
        instanceId: 'a',
        durationMs: 12,
        textLength: 5,
      },
      {
        event: 'queue-send-complete',
        instanceId: 'a',
        durationMs: 20,
        textLength: 5,
      },
    ],
  );
});

test('continues sending when remote focus exceeds the short focus budget', async () => {
  const sent: string[] = [];
  let releaseFocusGate: () => void = () => undefined;
  const focusGate = new Promise<void>((resolve) => {
    releaseFocusGate = resolve;
  });
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text, focus) => {
      sent.push(`${instanceId}:${text}:${focus?.xRatio}:${focus?.yRatio}`);
    },
    () => undefined,
    {
      batchMs: 0,
      focusWaitMs: 20,
      wait: async (ms) => {
        if (ms === 20) await focusGate;
      },
    },
  );

  queue.setFocus(
    'a',
    { xRatio: 0.5, yRatio: 0.8 },
    new Promise<void>(() => undefined),
  );
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, []);

  releaseFocusGate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:hello:0.5:0.8']);
});

test('does not let stale focus from the previous instance block the next instance', async () => {
  const sent: string[] = [];
  const neverFocused = new Promise<void>(() => undefined);
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text) => {
      sent.push(`${instanceId}:${text}`);
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.setFocus('a', { xRatio: 0.5, yRatio: 0.8 }, neverFocused);
  queue.reset();
  queue.enqueue('b', 'fresh');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['b:fresh']);
});

test('passes the focused remote point to reliable typing', async () => {
  const sent: string[] = [];
  const queue = new ImeInstanceTextQueue(
    async (instanceId, text, focus) => {
      sent.push(`${instanceId}:${text}:${focus?.xRatio}:${focus?.yRatio}`);
    },
    () => undefined,
    { batchMs: 0 },
  );

  queue.setFocus('a', { xRatio: 0.5, yRatio: 0.8 }, Promise.resolve());
  queue.enqueue('a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(sent, ['a:hello:0.5:0.8']);
});

test('uses the low latency clipboard transport before server fallback', () => {
  assert.equal(imeProxyCommitTransport(), 'clipboard');
});

test('tracks clipboard transport health per instance', () => {
  const health = new ImeTransportHealth();

  assert.equal(health.canUseClipboard('a'), false);
  assert.equal(health.canUseClipboard('b'), false);
  assert.equal(health.shouldProbeClipboard('a'), true);

  health.markClipboardFailed('b');

  assert.equal(health.canUseClipboard('a'), false);
  assert.equal(health.canUseClipboard('b'), false);
  assert.equal(health.shouldProbeClipboard('b'), false);

  health.markClipboardOk('b');

  assert.equal(health.canUseClipboard('b'), true);
  assert.equal(health.shouldProbeClipboard('b'), false);
});

test('allows clipboard transport to be re-probed after a failure cooldown', () => {
  let now = 1_000;
  const health = new ImeTransportHealth({
    now: () => now,
    failureCooldownMs: 500,
  });

  health.markClipboardFailed('b');

  assert.equal(health.canUseClipboard('b'), false);
  assert.equal(health.shouldProbeClipboard('b'), false);

  now = 1_501;

  assert.equal(health.shouldProbeClipboard('b'), true);
});

test('uses server typing until an instance clipboard transport is verified', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => {
        calls.push('push');
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '你好');

  assert.deepEqual(calls, ['type:b:你好']);
});

test('restores server-typed clipboard to the original instance after switching pages', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let marker = '';
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: (instanceId, text) => {
      marker = text;
      calls.push(
        `probe-push:${instanceId}:${text.startsWith('__woc_ime_probe_a_')}`,
      );
      return true;
    },
    readClipboard: async (instanceId) => {
      calls.push(`probe-read:${instanceId}`);
      return marker;
    },
    wait: async () => undefined,
  });
  let visibleInstance = 'a';
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: (instanceId, text) => {
        calls.push(`restore:${instanceId}:${text}:visible-${visibleInstance}`);
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
        visibleInstance = 'b';
      },
    },
  );

  await sender.send('a', 'A段');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    'type:a:A段',
    'probe-push:a:true',
    'probe-read:a',
    'restore:a:A段:visible-b',
  ]);
});

test('matches clipboard writes only to the iframe for that instance', () => {
  assert.equal(
    imeProxyFrameMatchesInstance({
      instanceId: 'a',
      frameSrc: '/desktop/a/vnc/index.html?path=desktop/a/websockify',
    }),
    true,
  );
  assert.equal(
    imeProxyFrameMatchesInstance({
      instanceId: 'a',
      frameSrc:
        'http://localhost/desktop/b/vnc/index.html?path=desktop/b/websockify',
    }),
    false,
  );
  assert.equal(
    imeProxyFrameMatchesInstance({
      instanceId: 'a/b',
      frameSrc: '/desktop/a%2Fb/vnc/index.html',
    }),
    true,
  );
});

test('does not mark clipboard failed when the instance iframe is temporarily unavailable', async () => {
  const health = new ImeTransportHealth();
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: () => 'unavailable',
    readClipboard: async () => '',
    wait: async () => undefined,
  });

  await probe.ensure('a');

  assert.equal(health.canUseClipboard('a'), false);
  assert.equal(health.shouldProbeClipboard('a'), true);
});

test('re-probes clipboard after reliable server typing so the next send can become low latency', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let marker = '';
  let probe: ImeTransportProbe | null = null;
  probe = new ImeTransportProbe({
    health,
    pushClipboard: (_instanceId, text) => {
      marker = text;
      calls.push(`probe-push:${text.startsWith('__woc_ime_probe_b_')}`);
      return true;
    },
    readClipboard: async (instanceId) => {
      calls.push(`probe-read:${instanceId}`);
      return marker;
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: (_instanceId, text) => {
        calls.push(`push:${text}`);
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '第一段');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(health.canUseClipboard('b'), true);

  await sender.send('b', '第二段');

  assert.deepEqual(calls, [
    'type:b:第一段',
    'probe-push:true',
    'probe-read:b',
    'push:第一段',
    'push:第二段',
    'key:b:Paste',
  ]);
});

test('restores the latest server-typed text after a successful background probe', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let marker = '';
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: (_instanceId, text) => {
      marker = text;
      calls.push(`probe-push:${text.startsWith('__woc_ime_probe_b_')}`);
      return true;
    },
    readClipboard: async (instanceId) => {
      calls.push(`probe-read:${instanceId}`);
      return marker;
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: (_instanceId, text) => {
        calls.push(`push:${text}`);
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '已经上屏');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    'type:b:已经上屏',
    'probe-push:true',
    'probe-read:b',
    'push:已经上屏',
  ]);
});

test('keeps restore sequencing when sender handlers are updated between renders', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let marker = '';
  let finishProbe: () => void = () => undefined;
  const probeReadWait = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: (_instanceId, text) => {
      marker = text;
      calls.push(`probe-push:${text.startsWith('__woc_ime_probe_b_')}`);
      return true;
    },
    readClipboard: async (instanceId) => {
      calls.push(`probe-read:${instanceId}`);
      await probeReadWait;
      return marker;
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: (_instanceId, text) => {
        calls.push(`old-restore:${text}`);
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`old-key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`old-type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '旧段');
  sender.setHandlers({
    pushClipboard: (_instanceId, text) => {
      calls.push(`new-restore:${text}`);
      return true;
    },
    sendKey: async (instanceId, key) => {
      calls.push(`new-key:${instanceId}:${key}`);
    },
    typeText: async (instanceId, text) => {
      calls.push(`new-type:${instanceId}:${text}`);
    },
    readClipboard: async () => '',
  });
  await sender.send('b', '新段');
  finishProbe();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    'old-type:b:旧段',
    'probe-push:true',
    'probe-read:b',
    'new-type:b:新段',
    'new-restore:新段',
  ]);
});

test('uses low latency clipboard after that instance transport is verified', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('a');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => {
        calls.push('push');
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '你好',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('a', '你好');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['push', 'key:a:Paste']);
});

test('does not add a fixed delay before pasting after clipboard push succeeds', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('a');
  const calls: string[] = [];
  let releaseWait: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const sender = new ImeRemoteTextSender(
    {
      health,
      wait: async () => {
        calls.push('wait');
        await wait;
      },
    },
    {
      pushClipboard: () => {
        calls.push('push');
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  const send = sender.send('a', '你好');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, ['push', 'key:a:Paste']);

  releaseWait();
  await send;
});

test('uses focused paste for low latency clipboard sends when a focus point is available', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('a');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => {
        calls.push('push');
        return true;
      },
      pasteClipboard: async (instanceId, focus, expectedText) => {
        calls.push(
          `paste:${instanceId}:${focus.xRatio}:${focus.yRatio}:${expectedText}`,
        );
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('a', '你好', { xRatio: 0.5, yRatio: 0.8 });

  assert.deepEqual(calls, ['push', 'paste:a:0.5:0.8:你好']);
});

test('probes clipboard transport in the background and marks failure per instance', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: (_instanceId, text) => {
      calls.push(`push:${text.startsWith('__woc_ime_probe_b_')}`);
      return true;
    },
    readClipboard: async (instanceId) => {
      calls.push(`read:${instanceId}`);
      return '';
    },
  });

  await probe.ensure('b');

  assert.equal(health.canUseClipboard('b'), false);
  assert.deepEqual(calls, ['push:true', 'read:b']);
});

test('keeps clipboard unverified when probe marker was likely replaced by real text', async () => {
  const health = new ImeTransportHealth();
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: () => true,
    readClipboard: async () => '用户刚输入的文字',
    wait: async () => undefined,
  });

  await probe.ensure('a');

  assert.equal(health.canUseClipboard('a'), false);
  assert.equal(health.shouldProbeClipboard('a'), true);
});

test('updates probe handlers without dropping an active probe', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: () => true,
    readClipboard: async () => {
      calls.push('old-read');
      return 'old';
    },
    wait: async () => undefined,
  });

  const active = probe.ensure('b');
  probe.setHandlers({
    pushClipboard: () => true,
    readClipboard: async () => {
      calls.push('new-read');
      return 'new';
    },
  });

  assert.equal(probe.active('b'), active);
  await active;

  assert.deepEqual(calls, ['old-read']);
});

test('does not wait for an active probe before reliable typing', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let finishProbe: () => void = () => undefined;
  let markProbeRead: () => void = () => undefined;
  const probeRead = new Promise<void>((resolve) => {
    markProbeRead = resolve;
  });
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: () => true,
    readClipboard: async () => {
      markProbeRead();
      await new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
      return '';
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: () => {
        calls.push('push-text');
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => 'old',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  void probe.ensure('b');
  await probeRead;
  await sender.send('b', '你好');

  assert.deepEqual(calls, ['type:b:你好']);
});

test('does not delay reliable typing behind an active clipboard probe', async () => {
  const health = new ImeTransportHealth();
  const calls: string[] = [];
  let markProbeRead: () => void = () => undefined;
  const probeRead = new Promise<void>((resolve) => {
    markProbeRead = resolve;
  });
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: () => true,
    readClipboard: async () => {
      markProbeRead();
      await new Promise<void>(() => undefined);
      return '';
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: () => {
        calls.push('push-text');
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => 'old',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  void probe.ensure('b');
  await probeRead;
  await sender.send('b', '你好');

  assert.deepEqual(calls, ['type:b:你好']);
});

test('does not verify every low latency send after clipboard transport is proven', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('a');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => true,
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async (instanceId) => {
        calls.push(`read:${instanceId}`);
        return '';
      },
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('a', '你好');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(health.canUseClipboard('a'), true);
  assert.deepEqual(calls, ['key:a:Paste']);
});

test('keeps using proven clipboard transport without reading later real text', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('a');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => true,
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => {
        calls.push('read');
        return '第二段真实输入';
      },
      typeText: async () => undefined,
    },
  );

  await sender.send('a', '第一段');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(health.canUseClipboard('a'), true);
  assert.deepEqual(calls, ['key:a:Paste']);
});

test('falls back to server typing when clipboard paste command fails synchronously', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => true,
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
        throw new Error('paste failed');
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '你好');

  assert.equal(health.canUseClipboard('b'), false);
  assert.deepEqual(calls, ['key:b:Paste', 'type:b:你好']);
});

test('records diagnostics when low latency paste falls back to reliable typing', async () => {
  let now = 1_000;
  const diagnostics = new ImeDiagnostics({
    now: () => now,
  });
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0, diagnostics },
    {
      pushClipboard: () => true,
      pasteClipboard: async () => {
        now = 1_012;
        throw new Error('clipboard did not sync expected text');
      },
      sendKey: async () => undefined,
      readClipboard: async () => '',
      typeText: async () => {
        now = 1_025;
      },
    },
  );

  await sender.send('b', '你好', { xRatio: 0.5, yRatio: 0.8 });

  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      transport: entry.transport,
      ok: entry.ok,
      durationMs: entry.durationMs,
      textLength: entry.textLength,
      error: entry.error,
    })),
    [
      {
        event: 'send-start',
        instanceId: 'b',
        transport: 'clipboard',
        ok: undefined,
        durationMs: undefined,
        textLength: 2,
        error: undefined,
      },
      {
        event: 'send-failed',
        instanceId: 'b',
        transport: 'clipboard',
        ok: false,
        durationMs: 12,
        textLength: 2,
        error: 'clipboard did not sync expected text',
      },
      {
        event: 'send-complete',
        instanceId: 'b',
        transport: 'type',
        ok: true,
        durationMs: 25,
        textLength: 2,
        error: undefined,
      },
    ],
  );
});

test('marks clipboard failed when focused low latency paste fails', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => true,
      pasteClipboard: async () => {
        throw new Error('clipboard did not sync expected text');
      },
      sendKey: async () => undefined,
      readClipboard: async () => '',
      typeText: async () => undefined,
    },
  );

  await sender.send('b', '你好', { xRatio: 0.5, yRatio: 0.8 });

  assert.equal(health.canUseClipboard('b'), false);
});

test('records diagnostics when clipboard push is unavailable before reliable typing', async () => {
  const diagnostics = new ImeDiagnostics({ now: () => 1_000 });
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0, diagnostics },
    {
      pushClipboard: () => 'unavailable',
      sendKey: async () => undefined,
      readClipboard: async () => '',
      typeText: async () => undefined,
    },
  );

  await sender.send('b', '你好');

  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      transport: entry.transport,
      ok: entry.ok,
      error: entry.error,
    })),
    [
      {
        event: 'send-start',
        instanceId: 'b',
        transport: 'clipboard',
        ok: undefined,
        error: undefined,
      },
      {
        event: 'send-failed',
        instanceId: 'b',
        transport: 'clipboard',
        ok: false,
        error: 'push:unavailable',
      },
      {
        event: 'send-complete',
        instanceId: 'b',
        transport: 'type',
        ok: true,
        error: undefined,
      },
    ],
  );
});

test('records diagnostics when clipboard push explicitly fails before reliable typing', async () => {
  const diagnostics = new ImeDiagnostics({ now: () => 1_000 });
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0, diagnostics },
    {
      pushClipboard: () => 'failed',
      sendKey: async () => undefined,
      readClipboard: async () => '',
      typeText: async () => undefined,
    },
  );

  await sender.send('b', '你好');

  assert.equal(health.canUseClipboard('b'), false);
  assert.deepEqual(
    diagnostics.entries().map((entry) => ({
      event: entry.event,
      instanceId: entry.instanceId,
      transport: entry.transport,
      ok: entry.ok,
      error: entry.error,
    })),
    [
      {
        event: 'send-start',
        instanceId: 'b',
        transport: 'clipboard',
        ok: undefined,
        error: undefined,
      },
      {
        event: 'send-failed',
        instanceId: 'b',
        transport: 'clipboard',
        ok: false,
        error: 'push:failed',
      },
      {
        event: 'send-complete',
        instanceId: 'b',
        transport: 'type',
        ok: true,
        error: undefined,
      },
    ],
  );
});

test('keeps diagnostics bounded to the latest entries', () => {
  const diagnostics = new ImeDiagnostics({ limit: 2, now: () => 1_000 });

  diagnostics.record({ event: 'send-start', instanceId: 'a' });
  diagnostics.record({ event: 'send-start', instanceId: 'b' });
  diagnostics.record({ event: 'send-start', instanceId: 'c' });

  assert.deepEqual(
    diagnostics.entries().map((entry) => entry.instanceId),
    ['b', 'c'],
  );
});

test('marks clipboard failed when a verified iframe clipboard push fails', async () => {
  const health = new ImeTransportHealth();
  health.markClipboardOk('b');
  const calls: string[] = [];
  const sender = new ImeRemoteTextSender(
    { health, clipboardSettleMs: 0 },
    {
      pushClipboard: () => 'failed',
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '你好');

  assert.equal(health.canUseClipboard('b'), false);
  assert.deepEqual(calls, ['type:b:你好']);
});

test('recovers low latency clipboard transport after a transient paste failure', async () => {
  let now = 1_000;
  const health = new ImeTransportHealth({
    now: () => now,
    failureCooldownMs: 500,
  });
  health.markClipboardOk('b');
  const calls: string[] = [];
  let marker = '';
  const probe = new ImeTransportProbe({
    health,
    pushClipboard: (_instanceId, text) => {
      marker = text;
      calls.push(text.startsWith('__woc_ime_probe_b_') ? 'probe-push' : `push:${text}`);
      return true;
    },
    readClipboard: async () => {
      calls.push('probe-read');
      return marker;
    },
    wait: async () => undefined,
  });
  const sender = new ImeRemoteTextSender(
    { health, probe, clipboardSettleMs: 0 },
    {
      pushClipboard: (_instanceId, text) => {
        calls.push(`push:${text}`);
        return true;
      },
      sendKey: async (instanceId, key) => {
        calls.push(`key:${instanceId}:${key}`);
        if (key === 'Paste') throw new Error('transient paste failed');
      },
      readClipboard: async () => '',
      typeText: async (instanceId, text) => {
        calls.push(`type:${instanceId}:${text}`);
      },
    },
  );

  await sender.send('b', '第一段');
  now = 1_501;
  await sender.send('b', '第二段');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(health.canUseClipboard('b'), true);
  assert.deepEqual(calls, [
    'push:第一段',
    'key:b:Paste',
    'type:b:第一段',
    'type:b:第二段',
    'probe-push',
    'probe-read',
    'push:第二段',
  ]);
});

test('maps iframe click coordinates to remote desktop ratios', () => {
  assert.deepEqual(
    imeProxyRemoteClickPoint({
      clientX: 400,
      clientY: 720,
      frameWidth: 800,
      frameHeight: 900,
    }),
    { xRatio: 0.5, yRatio: 0.8 },
  );
});

test('maps viewport click coordinates relative to the iframe', () => {
  assert.deepEqual(
    imeProxyRemoteClickPoint({
      clientX: 500,
      clientY: 770,
      frameLeft: 100,
      frameTop: 50,
      frameWidth: 800,
      frameHeight: 900,
    }),
    { xRatio: 0.5, yRatio: 0.8 },
  );
});

test('maps iframe-local click coordinates without parent frame offsets', () => {
  assert.deepEqual(
    imeProxyRemoteClickPoint({
      clientX: 400,
      clientY: 720,
      frameLeft: 100,
      frameTop: 50,
      frameWidth: 800,
      frameHeight: 900,
      coordinateSpace: 'frame',
    }),
    { xRatio: 0.5, yRatio: 0.8 },
  );
});

test('uses the inner noVNC canvas geometry when mapping remote click ratios', () => {
  const geometry = imeProxyFrameViewportGeometry({
    frame: { left: 100, top: 50, width: 1000, height: 900 },
    canvas: { left: 180, top: 140, width: 800, height: 720 },
  });

  assert.deepEqual(geometry, {
    frameLeft: 180,
    frameTop: 140,
    frameWidth: 800,
    frameHeight: 720,
  });
  assert.deepEqual(
    imeProxyRemoteClickPoint({
      clientX: 580,
      clientY: 716,
      ...geometry,
    }),
    { xRatio: 0.5, yRatio: 0.8 },
  );
});

test('falls back to the iframe geometry when noVNC canvas geometry is unavailable', () => {
  assert.deepEqual(
    imeProxyFrameViewportGeometry({
      frame: { left: 100, top: 50, width: 1000, height: 900 },
      canvas: null,
    }),
    {
      frameLeft: 100,
      frameTop: 50,
      frameWidth: 1000,
      frameHeight: 900,
    },
  );
});

test('clamps remote click ratios inside the desktop', () => {
  assert.deepEqual(
    imeProxyRemoteClickPoint({
      clientX: 900,
      clientY: -20,
      frameWidth: 800,
      frameHeight: 900,
    }),
    { xRatio: 1, yRatio: 0 },
  );
});

test('positions proxy near the iframe click in parent viewport coordinates', () => {
  const pos = imeProxyPositionFromFrameClick({
    frame: { left: 100, right: 900, top: 50 },
    clientX: 320,
    clientY: 420,
    viewportWidth: 1000,
    viewportHeight: 800,
  });

  assert.deepEqual(pos, { x: 420, y: 470 });
});

test('keeps proxy fully inside the parent viewport near the right edge', () => {
  const pos = imeProxyPositionFromFrameClick({
    frame: { left: 100, right: 900, top: 50 },
    clientX: 790,
    clientY: 420,
    viewportWidth: 1000,
    viewportHeight: 800,
    proxyWidth: 420,
  });

  assert.deepEqual(pos, { x: 568, y: 470 });
});

test('activates proxy only in the likely WeChat message input area', () => {
  const frame = { left: 100, right: 900, top: 50, bottom: 850 };

  assert.equal(
    imeProxyShouldActivateFromFrameClick({ frame, clientX: 520, clientY: 720 }),
    true,
  );
  assert.equal(
    imeProxyShouldActivateFromFrameClick({ frame, clientX: 520, clientY: 260 }),
    false,
  );
  assert.equal(
    imeProxyShouldActivateFromFrameClick({ frame, clientX: 80, clientY: 720 }),
    false,
  );
});

test('activates proxy against the inner noVNC canvas area when it is offset', () => {
  const canvasGeometry = imeProxyFrameViewportGeometry({
    frame: { left: 0, top: 0, width: 1000, height: 900 },
    canvas: { left: 80, top: 120, width: 800, height: 720 },
  });
  const canvasFrame = imeProxyFrameRectFromViewportGeometry(canvasGeometry);

  assert.equal(
    imeProxyShouldActivateFromFrameClick({
      frame: canvasFrame,
      clientX: 500,
      clientY: 700,
    }),
    true,
  );
  assert.equal(
    imeProxyShouldActivateFromFrameClick({
      frame: canvasFrame,
      clientX: 500,
      clientY: 850,
    }),
    false,
  );
});

test('pre-clicks remote focus on all devices before text arrives', () => {
  assert.equal(imeProxyShouldPreClickRemoteFocus({ mobile: false }), true);
  assert.equal(imeProxyShouldPreClickRemoteFocus({ mobile: true }), true);
});

test('does not probe clipboard transport while focusing the remote input area', () => {
  assert.equal(imeProxyShouldProbeOnFocusActivation({ mobile: false }), false);
  assert.equal(imeProxyShouldProbeOnFocusActivation({ mobile: true }), false);
});

test('skips the mousedown activation that follows the same pointerdown', () => {
  assert.equal(
    imeProxyShouldSkipDuplicateActivation({
      eventType: 'mousedown',
      clientX: 520,
      clientY: 720,
      now: 1_040,
      last: {
        eventType: 'pointerdown',
        clientX: 520,
        clientY: 720,
        at: 1_000,
      },
    }),
    true,
  );
});

test('keeps distinct mouse activations after pointerdown available', () => {
  assert.equal(
    imeProxyShouldSkipDuplicateActivation({
      eventType: 'mousedown',
      clientX: 560,
      clientY: 760,
      now: 1_040,
      last: {
        eventType: 'pointerdown',
        clientX: 520,
        clientY: 720,
        at: 1_000,
      },
    }),
    false,
  );
});

test('maps local select-all shortcut to the remote desktop shortcut', () => {
  assert.equal(
    imeProxyShortcutKey({
      key: 'a',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      isComposing: false,
    }),
    'Ctrl+A',
  );
  assert.equal(
    imeProxyShortcutKey({
      key: 'a',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
    }),
    'Ctrl+A',
  );
  assert.equal(
    imeProxyShortcutKey({
      key: 'a',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      isComposing: true,
    }),
    null,
  );
});

test('docks mobile proxy to the viewport bottom', () => {
  const pos = imeProxyMobileViewportPosition({
    viewportWidth: 390,
    viewportHeight: 844,
    visualViewportTop: 0,
    visualViewportHeight: 520,
    proxyHeight: 40,
  });

  assert.deepEqual(pos, { x: 12, y: null });
});

test('reads click coordinates from touch events', () => {
  const point = imeProxyEventPoint({
    touches: [{ clientX: 120, clientY: 680 }],
  });

  assert.deepEqual(point, { clientX: 120, clientY: 680 });
});

test('marks proxy active after focusing the remote input area', () => {
  assert.equal(
    imeProxyClassName({ mobile: true, typing: false, active: true }),
    'iv-ime-proxy mobile active',
  );
});

test('does not focus the proxy before a remote input area is activated', () => {
  assert.equal(
    imeProxyShouldFocus({
      enabled: true,
      showVnc: true,
      frameLoaded: true,
      blockedByControl: false,
      hasRemoteFocus: false,
    }),
    false,
  );
  assert.equal(
    imeProxyShouldFocus({
      enabled: true,
      showVnc: true,
      frameLoaded: true,
      blockedByControl: false,
      hasRemoteFocus: true,
    }),
    true,
  );
});
