export type ImeServerDiagnosticAction =
  | 'type'
  | 'paste'
  | 'click'
  | 'key'
  | 'clipboard';

export interface ImeServerDiagnosticEntry {
  at: number;
  action: ImeServerDiagnosticAction;
  instanceId: string;
  durationMs: number;
  ok: boolean;
  textLength?: number;
  key?: string;
  xRatio?: number;
  yRatio?: number;
  error?: string;
}

export interface ImeServerDiagnosticRecord {
  action: ImeServerDiagnosticAction;
  instanceId: string;
  startedAt: number;
  ok: boolean;
  textLength?: number;
  key?: string;
  xRatio?: number;
  yRatio?: number;
  error?: string;
}

export function normalizeImeDiagnosticError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : error === undefined || error === null
          ? 'unknown error'
          : String(error);
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

export class ImeServerDiagnostics {
  private events: ImeServerDiagnosticEntry[] = [];
  private readonly limit: number;
  private readonly now: () => number;

  constructor(
    options: {
      limit?: number;
      now?: () => number;
    } = {},
  ) {
    this.limit = Math.max(1, Math.floor(options.limit ?? 120));
    this.now = options.now ?? (() => Date.now());
  }

  timestamp(): number {
    return this.now();
  }

  record(record: ImeServerDiagnosticRecord) {
    const at = this.timestamp();
    const entry: ImeServerDiagnosticEntry = {
      at,
      action: record.action,
      instanceId: record.instanceId,
      durationMs: Math.max(0, at - record.startedAt),
      ok: record.ok,
    };
    if (record.textLength !== undefined) entry.textLength = record.textLength;
    if (record.key !== undefined) entry.key = record.key;
    if (record.xRatio !== undefined) entry.xRatio = record.xRatio;
    if (record.yRatio !== undefined) entry.yRatio = record.yRatio;
    if (record.error !== undefined) entry.error = normalizeImeDiagnosticError(record.error);
    this.events.push(entry);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  entries(): ImeServerDiagnosticEntry[] {
    return [...this.events];
  }

  clear() {
    this.events = [];
  }
}
