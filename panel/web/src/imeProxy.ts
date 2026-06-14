export type CommitText = (text: string) => void;
export interface ImeRemoteFocusPoint {
  xRatio: number;
  yRatio: number;
}

export type SendTextToInstance = (
  instanceId: string,
  text: string,
  focus?: ImeRemoteFocusPoint,
) => Promise<void>;
export type HandleImeSendError = (error: unknown) => void;
export type ImeClipboardPushResult = boolean | 'ok' | 'unavailable' | 'failed';

export type ImeDiagnosticEvent =
  | 'queue-batch-start'
  | 'queue-batch-flush'
  | 'queue-focus-set'
  | 'queue-send-start'
  | 'queue-focus-wait'
  | 'queue-send-complete'
  | 'send-start'
  | 'send-failed'
  | 'send-complete';

export type ImeDiagnosticTransport = 'clipboard' | 'type';

export interface ImeDiagnosticEntry {
  at: number;
  event: ImeDiagnosticEvent;
  instanceId: string;
  transport?: ImeDiagnosticTransport;
  ok?: boolean;
  durationMs?: number;
  textLength?: number;
  xRatio?: number;
  yRatio?: number;
  error?: string;
}

export class ImeDiagnostics {
  private events: ImeDiagnosticEntry[] = [];
  private readonly limit: number;
  private readonly now: () => number;

  constructor(
    options: {
      limit?: number;
      now?: () => number;
    } = {},
  ) {
    this.limit = Math.max(1, Math.floor(options.limit ?? 80));
    this.now = options.now ?? (() => Date.now());
  }

  timestamp(): number {
    return this.now();
  }

  record(entry: Omit<ImeDiagnosticEntry, 'at'>) {
    this.events.push({ at: this.timestamp(), ...entry });
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  entries(): ImeDiagnosticEntry[] {
    return [...this.events];
  }

  clear() {
    this.events = [];
  }
}

export class ImeCommitBuffer {
  private composing = false;
  private lastCompositionCommit = '';

  constructor(private commit: CommitText) {}

  setCommit(commit: CommitText) {
    this.commit = commit;
  }

  reset() {
    this.composing = false;
    this.lastCompositionCommit = '';
  }

  compositionStart() {
    this.composing = true;
    this.lastCompositionCommit = '';
  }

  compositionEnd(text: string) {
    this.composing = false;
    if (!text) return;
    this.lastCompositionCommit = text;
    this.commit(text);
  }

  input(text: string, isComposing = false) {
    if (!text) return;
    if (this.composing || isComposing) return;
    if (this.lastCompositionCommit === text) {
      this.lastCompositionCommit = '';
      return;
    }
    this.lastCompositionCommit = '';
    this.commit(text);
  }
}

export function imeProxyCommitTransport(): 'clipboard' {
  return 'clipboard';
}

export class ImeTransportHealth {
  private clipboardOk = new Set<string>();
  private clipboardFailedAt = new Map<string, number>();

  constructor(
    private readonly options: {
      now?: () => number;
      failureCooldownMs?: number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private failureCooldownMs(): number {
    return this.options.failureCooldownMs ?? 3_000;
  }

  canUseClipboard(instanceId: string): boolean {
    return (
      this.clipboardOk.has(instanceId) && !this.clipboardFailedAt.has(instanceId)
    );
  }

  shouldProbeClipboard(instanceId: string): boolean {
    if (this.clipboardOk.has(instanceId)) return false;
    const failedAt = this.clipboardFailedAt.get(instanceId);
    if (failedAt === undefined) return true;
    return this.now() - failedAt >= this.failureCooldownMs();
  }

  markClipboardFailed(instanceId: string) {
    this.clipboardOk.delete(instanceId);
    this.clipboardFailedAt.set(instanceId, this.now());
  }

  markClipboardOk(instanceId: string) {
    this.clipboardOk.add(instanceId);
    this.clipboardFailedAt.delete(instanceId);
  }
}

export interface ImeTransportProbeOptions {
  health: ImeTransportHealth;
  pushClipboard: (instanceId: string, text: string) => ImeClipboardPushResult;
  readClipboard: (instanceId: string) => Promise<string>;
  onVerified?: (instanceId: string) => void;
  wait?: (ms: number) => Promise<void>;
  settleMs?: number;
}

export interface ImeTransportProbeHandlers {
  pushClipboard: (instanceId: string, text: string) => ImeClipboardPushResult;
  readClipboard: (instanceId: string) => Promise<string>;
}

export class ImeTransportProbe {
  private readonly wait: (ms: number) => Promise<void>;
  private readonly settleMs: number;
  private pending = new Map<string, Promise<void>>();
  private handlers: ImeTransportProbeHandlers;

  constructor(private readonly options: ImeTransportProbeOptions) {
    this.wait =
      options.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.settleMs = options.settleMs ?? 80;
    this.handlers = {
      pushClipboard: options.pushClipboard,
      readClipboard: options.readClipboard,
    };
  }

  setHandlers(handlers: ImeTransportProbeHandlers) {
    this.handlers = handlers;
  }

  ensure(instanceId: string): Promise<void> {
    if (!this.options.health.shouldProbeClipboard(instanceId))
      return Promise.resolve();
    const pending = this.pending.get(instanceId);
    if (pending) return pending;
    const marker = `__woc_ime_probe_${instanceId}_${Date.now()}__`;
    const handlers = this.handlers;
    const probe = this.run(instanceId, marker, handlers).finally(() =>
      this.pending.delete(instanceId),
    );
    this.pending.set(instanceId, probe);
    return probe;
  }

  active(instanceId: string): Promise<void> | null {
    return this.pending.get(instanceId) ?? null;
  }

  private async run(
    instanceId: string,
    marker: string,
    handlers: ImeTransportProbeHandlers,
  ) {
    try {
      const pushed = handlers.pushClipboard(instanceId, marker);
      if (pushed === 'unavailable') return;
      if (pushed === false || pushed === 'failed') {
        this.options.health.markClipboardFailed(instanceId);
        return;
      }
      await this.wait(this.settleMs);
      const text = await handlers.readClipboard(instanceId);
      if (text === marker) {
        this.options.health.markClipboardOk(instanceId);
        this.options.onVerified?.(instanceId);
      } else if (!text) this.options.health.markClipboardFailed(instanceId);
    } catch {
      this.options.health.markClipboardFailed(instanceId);
    }
  }
}

export interface ImeRemoteTextSenderOptions {
  health: ImeTransportHealth;
  probe?: ImeTransportProbe;
  wait?: (ms: number) => Promise<void>;
  clipboardSettleMs?: number;
  diagnostics?: ImeDiagnostics;
}

export interface ImeRemoteTextSenderHandlers {
  pushClipboard: (instanceId: string, text: string) => ImeClipboardPushResult;
  pasteClipboard?: (
    instanceId: string,
    focus: ImeRemoteFocusPoint,
    expectedText?: string,
  ) => Promise<void>;
  sendKey: (instanceId: string, key: string) => Promise<void>;
  typeText: (
    instanceId: string,
    text: string,
    focus?: ImeRemoteFocusPoint,
  ) => Promise<void>;
  readClipboard: (instanceId: string) => Promise<string>;
}

export class ImeRemoteTextSender {
  private readonly wait: (ms: number) => Promise<void>;
  private readonly clipboardSettleMs: number;
  private restoreSeq = new Map<string, number>();
  private handlers: ImeRemoteTextSenderHandlers;

  constructor(
    private readonly options: ImeRemoteTextSenderOptions,
    handlers: ImeRemoteTextSenderHandlers,
  ) {
    this.wait =
      options.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clipboardSettleMs = options.clipboardSettleMs ?? 0;
    this.handlers = handlers;
  }

  setHandlers(handlers: ImeRemoteTextSenderHandlers) {
    this.handlers = handlers;
  }

  async send(
    instanceId: string,
    text: string,
    focus?: ImeRemoteFocusPoint,
  ): Promise<void> {
    if (!text) return;
    const startedAt = this.now();
    this.options.diagnostics?.record({
      event: 'send-start',
      instanceId,
      transport: this.options.health.canUseClipboard(instanceId)
        ? 'clipboard'
        : 'type',
      textLength: text.length,
    });
    if (
      imeProxyCommitTransport() === 'clipboard' &&
      this.options.health.canUseClipboard(instanceId)
    ) {
      try {
        const pushed = this.handlers.pushClipboard(instanceId, text);
        if (pushed === true || pushed === 'ok') {
          if (this.clipboardSettleMs > 0) await this.wait(this.clipboardSettleMs);
          if (focus && this.handlers.pasteClipboard)
            await this.handlers.pasteClipboard(instanceId, focus, text);
          else await this.handlers.sendKey(instanceId, 'Paste');
          this.recordSendComplete(
            instanceId,
            'clipboard',
            text.length,
            startedAt,
          );
          return;
        }
        if (pushed === 'unavailable') {
          this.recordSendFailure(
            instanceId,
            text.length,
            startedAt,
            'push:unavailable',
          );
          return await this.reliableType(instanceId, text, focus, startedAt);
        }
        if (pushed === false || pushed === 'failed') {
          this.options.health.markClipboardFailed(instanceId);
          this.recordSendFailure(
            instanceId,
            text.length,
            startedAt,
            'push:failed',
          );
        }
      } catch (error) {
        this.options.health.markClipboardFailed(instanceId);
        this.recordSendFailure(
          instanceId,
          text.length,
          startedAt,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.reliableType(instanceId, text, focus, startedAt);
  }

  private async reliableType(
    instanceId: string,
    text: string,
    focus: ImeRemoteFocusPoint | undefined,
    startedAt: number,
  ) {
    await this.handlers.typeText(instanceId, text, focus);
    this.recordSendComplete(instanceId, 'type', text.length, startedAt);
    this.probeAfterReliableSend(instanceId, text);
  }

  private recordSendComplete(
    instanceId: string,
    transport: ImeDiagnosticTransport,
    textLength: number,
    startedAt: number,
  ) {
    this.options.diagnostics?.record({
      event: 'send-complete',
      instanceId,
      transport,
      ok: true,
      durationMs: this.now() - startedAt,
      textLength,
    });
  }

  private recordSendFailure(
    instanceId: string,
    textLength: number,
    startedAt: number,
    error: string,
  ) {
    this.options.diagnostics?.record({
      event: 'send-failed',
      instanceId,
      transport: 'clipboard',
      ok: false,
      durationMs: this.now() - startedAt,
      textLength,
      error,
    });
  }

  private now(): number {
    return this.options.diagnostics?.timestamp() ?? Date.now();
  }

  private probeAfterReliableSend(instanceId: string, text: string) {
    const probe = this.options.probe;
    if (!probe || !this.options.health.shouldProbeClipboard(instanceId)) return;
    const seq = (this.restoreSeq.get(instanceId) ?? 0) + 1;
    this.restoreSeq.set(instanceId, seq);
    void probe.ensure(instanceId).then(() => {
      if (!this.options.health.canUseClipboard(instanceId)) return;
      if (this.restoreSeq.get(instanceId) !== seq) return;
      this.handlers.pushClipboard(instanceId, text);
    });
  }
}

export class ImeInstanceTextQueue {
  private chains = new Map<string, Promise<void>>();
  private generation = 0;
  private focus: {
    instanceId: string;
    generation: number;
    point: ImeRemoteFocusPoint;
    promise: Promise<void>;
  } | null = null;
  private batch: {
    instanceId: string;
    generation: number;
    text: string;
    startedAt: number;
  } | null = null;
  private batchSeq = 0;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly batchMs: number;
  private readonly focusWaitMs: number;

  constructor(
    private send: SendTextToInstance,
    private onError: HandleImeSendError,
    options: {
      wait?: (ms: number) => Promise<void>;
      batchMs?: number;
      focusWaitMs?: number;
      diagnostics?: ImeDiagnostics;
    } = {},
  ) {
    this.wait =
      options.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.batchMs = options.batchMs ?? 16;
    this.focusWaitMs = options.focusWaitMs ?? 20;
    this.diagnostics = options.diagnostics;
  }

  private diagnostics?: ImeDiagnostics;

  setHandlers(send: SendTextToInstance, onError: HandleImeSendError) {
    this.send = send;
    this.onError = onError;
  }

  reset() {
    this.generation++;
    this.focus = null;
    this.batch = null;
    this.batchSeq++;
  }

  flush(instanceId?: string): Promise<void> {
    if (!instanceId || this.batch?.instanceId === instanceId) this.flushBatch();
    return instanceId
      ? (this.chains.get(instanceId) ?? Promise.resolve())
      : Promise.all(Array.from(this.chains.values())).then(() => undefined);
  }

  async flushAndReset(): Promise<void> {
    const generation = this.generation;
    this.flushBatch();
    await this.flush();
    if (this.generation === generation && !this.batch) this.reset();
  }

  setFocus(
    instanceId: string,
    point: ImeRemoteFocusPoint,
    promise: Promise<void>,
  ) {
    this.focus = { instanceId, generation: this.generation, point, promise };
    this.diagnostics?.record({
      event: 'queue-focus-set',
      instanceId,
      xRatio: point.xRatio,
      yRatio: point.yRatio,
    });
  }

  enqueue(instanceId: string, text: string) {
    const generation = this.generation;
    if (this.batchMs <= 0 || imeTextShouldSendImmediately(text)) {
      this.flushBatch();
      this.enqueueBatch(instanceId, text, generation);
      return;
    }
    if (
      this.batch &&
      this.batch.instanceId === instanceId &&
      this.batch.generation === generation
    ) {
      this.batch.text += text;
      return;
    }
    this.flushBatch();
    const startedAt = this.now();
    this.batch = { instanceId, generation, text, startedAt };
    this.record('queue-batch-start', instanceId, text.length);
    const batchSeq = ++this.batchSeq;
    void this.wait(this.batchMs).then(() => {
      if (this.batchSeq !== batchSeq) return;
      this.flushBatch();
    });
  }

  private flushBatch() {
    const batch = this.batch;
    if (!batch) return;
    this.batch = null;
    this.batchSeq++;
    this.record(
      'queue-batch-flush',
      batch.instanceId,
      batch.text.length,
      batch.startedAt,
    );
    this.enqueueBatch(
      batch.instanceId,
      batch.text,
      batch.generation,
      batch.startedAt,
    );
  }

  private enqueueBatch(
    instanceId: string,
    text: string,
    generation: number,
    queuedAt = this.now(),
  ) {
    const chain = this.chains.get(instanceId) ?? Promise.resolve();
    const next = chain
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.generation) return;
        this.record('queue-send-start', instanceId, text.length, queuedAt);
        const focus = this.focus;
        const focusPoint =
          focus?.instanceId === instanceId && focus.generation === generation
            ? focus.point
            : undefined;
        if (
          focusPoint &&
          focus?.instanceId === instanceId &&
          focus.generation === generation &&
          this.focusWaitMs > 0
        ) {
          const focusWaitStartedAt = this.now();
          await Promise.race([
            focus.promise.catch(() => undefined),
            this.wait(this.focusWaitMs),
          ]);
          this.record(
            'queue-focus-wait',
            instanceId,
            text.length,
            focusWaitStartedAt,
          );
        } else {
          void focus?.promise.catch(() => undefined);
        }
        if (generation !== this.generation) return;
        await this.send(instanceId, text, focusPoint);
        this.record('queue-send-complete', instanceId, text.length, queuedAt);
      })
      .catch((error) => this.onError(error))
      .finally(() => {
        if (this.chains.get(instanceId) === next)
          this.chains.delete(instanceId);
      });
    this.chains.set(instanceId, next);
  }

  private now(): number {
    return this.diagnostics?.timestamp() ?? Date.now();
  }

  private record(
    event: ImeDiagnosticEvent,
    instanceId: string,
    textLength: number,
    startedAt?: number,
  ) {
    this.diagnostics?.record({
      event,
      instanceId,
      durationMs: startedAt === undefined ? undefined : this.now() - startedAt,
      textLength,
    });
  }
}

export function imeTextShouldSendImmediately(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

export interface ImeProxyRemoteClickInput {
  clientX: number;
  clientY: number;
  frameWidth: number;
  frameHeight: number;
  frameLeft?: number;
  frameTop?: number;
  coordinateSpace?: 'frame' | 'viewport';
}

export function imeProxyRemoteClickPoint(input: ImeProxyRemoteClickInput): {
  xRatio: number;
  yRatio: number;
} {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const useViewport = input.coordinateSpace !== 'frame';
  const x = useViewport
    ? input.clientX - (input.frameLeft ?? 0)
    : input.clientX;
  const y = useViewport ? input.clientY - (input.frameTop ?? 0) : input.clientY;
  const xRatio = input.frameWidth > 0 ? x / input.frameWidth : 0;
  const yRatio = input.frameHeight > 0 ? y / input.frameHeight : 0;
  return {
    xRatio: clamp(xRatio),
    yRatio: clamp(yRatio),
  };
}

export interface ImeProxyFrameGeometryInput {
  frame: { left: number; top: number; width: number; height: number };
  canvas?: { left: number; top: number; width: number; height: number } | null;
}

export function imeProxyFrameViewportGeometry(input: ImeProxyFrameGeometryInput): {
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
} {
  const canvas = input.canvas;
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    return {
      frameLeft: canvas.left,
      frameTop: canvas.top,
      frameWidth: canvas.width,
      frameHeight: canvas.height,
    };
  }
  return {
    frameLeft: input.frame.left,
    frameTop: input.frame.top,
    frameWidth: input.frame.width,
    frameHeight: input.frame.height,
  };
}

export function imeProxyFrameRectFromViewportGeometry(input: {
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
}): { left: number; right: number; top: number; bottom: number } {
  return {
    left: input.frameLeft,
    right: input.frameLeft + input.frameWidth,
    top: input.frameTop,
    bottom: input.frameTop + input.frameHeight,
  };
}

export interface ImeProxyPositionInput {
  frame: { left: number; right: number; top: number };
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  proxyWidth?: number;
}

export function imeProxyPositionFromFrameClick(input: ImeProxyPositionInput): {
  x: number;
  y: number;
} {
  const parentX = input.frame.left + input.clientX;
  const parentY = input.frame.top + input.clientY;
  const margin = 12;
  const proxyWidth = Math.min(
    input.proxyWidth ?? 420,
    input.viewportWidth - margin * 2,
  );
  const minX = Math.max(margin, input.frame.left + margin);
  const maxX = Math.min(
    input.frame.right - margin,
    input.viewportWidth - proxyWidth - margin,
  );
  return {
    x: Math.max(minX, Math.min(maxX, parentX)),
    y: Math.max(56, Math.min(input.viewportHeight - 48, parentY)),
  };
}

export interface ImeProxyActivationInput {
  frame: { left: number; right: number; top: number; bottom: number };
  clientX: number;
  clientY: number;
}

export function imeProxyShouldActivateFromFrameClick(
  input: ImeProxyActivationInput,
): boolean {
  const width = input.frame.right - input.frame.left;
  const height = input.frame.bottom - input.frame.top;
  if (width <= 0 || height <= 0) return false;

  const xRatio = (input.clientX - input.frame.left) / width;
  const yRatio = (input.clientY - input.frame.top) / height;
  return xRatio >= 0.28 && xRatio <= 1 && yRatio >= 0.72 && yRatio <= 1;
}

export function imeProxyShouldPreClickRemoteFocus(input: { mobile: boolean }): boolean {
  void input.mobile;
  return true;
}

export function imeProxyShouldProbeOnFocusActivation(input: { mobile: boolean }): boolean {
  void input.mobile;
  return false;
}

export interface ImeProxyFocusInput {
  enabled: boolean;
  showVnc: boolean;
  frameLoaded: boolean;
  blockedByControl: boolean;
  hasRemoteFocus: boolean;
}

export function imeProxyShouldFocus(input: ImeProxyFocusInput): boolean {
  return (
    input.enabled &&
    input.showVnc &&
    input.frameLoaded &&
    !input.blockedByControl &&
    input.hasRemoteFocus
  );
}

export function imeProxyShouldApplySwitchCleanup(input: {
  alive: boolean;
  startedSeq: number;
  currentSeq: number;
}): boolean {
  return input.alive && input.startedSeq === input.currentSeq;
}

export interface ImeProxyActivationDedupInput {
  eventType: string;
  clientX: number;
  clientY: number;
  now: number;
  last?: {
    eventType: string;
    clientX: number;
    clientY: number;
    at: number;
  } | null;
  maxIntervalMs?: number;
  maxDistancePx?: number;
}

export function imeProxyShouldSkipDuplicateActivation(
  input: ImeProxyActivationDedupInput,
): boolean {
  const last = input.last;
  if (!last) return false;
  if (input.eventType !== 'mousedown') return false;
  if (last.eventType !== 'pointerdown' && last.eventType !== 'touchstart')
    return false;
  if (input.now - last.at > (input.maxIntervalMs ?? 250)) return false;
  const maxDistancePx = input.maxDistancePx ?? 2;
  return (
    Math.abs(input.clientX - last.clientX) <= maxDistancePx &&
    Math.abs(input.clientY - last.clientY) <= maxDistancePx
  );
}

export interface ImeProxyShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

export function imeProxyShortcutKey(
  input: ImeProxyShortcutInput,
): string | null {
  if (input.isComposing || input.altKey || (!input.ctrlKey && !input.metaKey))
    return null;
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  if (!/^[ACVXYZ]$/.test(key)) return null;
  return `Ctrl+${key}`;
}

export interface ImeProxyMobileViewportInput {
  viewportWidth: number;
  viewportHeight: number;
  visualViewportTop?: number;
  visualViewportHeight?: number;
  proxyHeight?: number;
}

export function imeProxyMobileViewportPosition(
  input: ImeProxyMobileViewportInput,
): { x: number; y: number | null } {
  const margin = 12;
  void input.viewportWidth;
  return {
    x: margin,
    y: null,
  };
}

export interface ImeProxyPointLike {
  clientX?: number;
  clientY?: number;
  touches?: ArrayLike<{ clientX: number; clientY: number }>;
  changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
}

export function imeProxyEventPoint(
  input: ImeProxyPointLike,
): { clientX: number; clientY: number } | null {
  if (typeof input.clientX === 'number' && typeof input.clientY === 'number') {
    return { clientX: input.clientX, clientY: input.clientY };
  }
  const touch = input.touches?.[0] ?? input.changedTouches?.[0];
  if (!touch) return null;
  return { clientX: touch.clientX, clientY: touch.clientY };
}

export interface ImeProxyFrameInstanceInput {
  instanceId: string;
  frameSrc: string;
}

export function imeProxyFrameMatchesInstance(
  input: ImeProxyFrameInstanceInput,
): boolean {
  if (!input.instanceId || !input.frameSrc) return false;
  try {
    const url = new URL(input.frameSrc, 'http://woc.local');
    const expectedPrefix = `/desktop/${encodeURIComponent(input.instanceId)}/`;
    return url.pathname.startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

export function imeProxyClassName(input: {
  mobile: boolean;
  typing: boolean;
  active: boolean;
}): string {
  return [
    'iv-ime-proxy',
    input.mobile ? 'mobile' : '',
    input.typing ? 'typing' : '',
    input.active ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
