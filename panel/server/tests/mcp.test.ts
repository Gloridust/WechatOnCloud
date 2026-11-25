import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { inflateSync } from 'node:zlib';
import Fastify from 'fastify';
import {
  parseAllowedHosts,
  parseHost,
  isRequestHostAllowed,
} from '../src/host-guard.js';
import {
  clampScreenshotCrop,
  collectDemuxedStream,
  compareSessionFingerprints,
  computeEditorRegion,
  computeHeaderRegion,
  countHeaderInkPixels,
  DEFAULT_EDITOR_MAX_DIFF_PIXELS,
  InputCommandError,
  computeHeaderDigest,
  isInSendButtonZone,
  MIN_HEADER_INK_PIXELS,
  parsePngDimensions,
  parseWechatWindowInfo,
  type ClickOptions,
  type ScreenshotOptions,
  type ScrollOptions,
  type SessionFingerprint,
} from '../src/mcp-desktop.js';
import type { RuntimeState } from '../src/docker.js';
import {
  isOriginAllowed,
  MCP_TOOLS,
  MCP_WRITE_TOOLS,
  parseEditorMaxDiffEnv,
  registerMcp,
  verifyBearerToken,
  type McpDeps,
} from '../src/mcp.js';
import type { Instance } from '../src/store.js';

// Minimal valid 1x1 PNG with exact IHDR dimensions (width, height) for unit & integration tests.
function makeTestPng(width = 1280, height = 616): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  const crc = Buffer.alloc(4, 0);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc, iend]);
}

function rawHttp(
  urlStr: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? 'POST',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const TEST_TOKEN = 'test-mcp-secret-token-0123456789abcdef';
const MCP_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const RUNNING_INST: Instance = {
  id: 'a1b2c3d4e5',
  name: 'Work',
  appType: 'wechat',
  containerName: 'woc-wx-a1b2c3d4e5',
  volumeName: 'woc-data-a1b2c3d4e5',
  kasmUser: 'woc',
  kasmPassword: 'SUPER_SECRET_KASM_PASSWORD_DO_NOT_LEAK',
  createdAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'admin-1',
};

const STOPPED_INST: Instance = {
  id: 'f6e5d4c3b2',
  name: 'Backup',
  appType: 'wechat',
  containerName: 'woc-wx-f6e5d4c3b2',
  volumeName: 'woc-data-f6e5d4c3b2',
  kasmUser: 'woc',
  kasmPassword: 'ANOTHER_SECRET_PASSWORD',
  createdAt: '2026-09-02T00:00:00.000Z',
  createdBy: 'admin-1',
};

// ---------- Pure helper unit tests ----------

test('verifyBearerToken checks scheme and exact token in constant time', () => {
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
  assert.equal(verifyBearerToken(`bearer ${TEST_TOKEN}`, TEST_TOKEN), true);
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}x`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Bearer wrong`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Basic ${TEST_TOKEN}`, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(undefined, TEST_TOKEN), false);
  assert.equal(verifyBearerToken(`Bearer ${TEST_TOKEN}`, ''), false);
});

test('isOriginAllowed permits absent origin, loopback, RFC1918, allowlist; rejects foreign origins', () => {
  const allow = parseAllowedHosts('*.example.com');
  assert.equal(isOriginAllowed(undefined, allow), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:36080', allow), true);
  assert.equal(isOriginAllowed('http://localhost:3000', allow), true);
  assert.equal(isOriginAllowed('http://192.168.1.10:36080', allow), true);
  assert.equal(isOriginAllowed('https://woc.example.com', allow), true);
  assert.equal(isOriginAllowed('https://evil.attacker.test', allow), false);
  assert.equal(isOriginAllowed('null', allow), false);
  assert.equal(isOriginAllowed('javascript:alert(1)', allow), false);
  assert.equal(isOriginAllowed('', allow), false);
});

test('parseWechatWindowInfo parses display and WeChat window geometry', () => {
  const raw = 'DISPLAY\t:1\t1836\t884\nWINDOW\t10485776\t0\t0\t1836\t884\t微信\n';
  const info = parseWechatWindowInfo(raw);
  assert.equal(info.display, ':1');
  assert.equal(info.displayWidth, 1836);
  assert.equal(info.displayHeight, 884);
  assert.deepEqual(info.wechatWindow, {
    id: '10485776',
    x: 0,
    y: 0,
    width: 1836,
    height: 884,
    title: '微信',
  });

  const noWin = parseWechatWindowInfo('DISPLAY\t:1\t1280\t720\n');
  assert.equal(noWin.wechatWindow, null);
  assert.throws(() => parseWechatWindowInfo('DISPLAY\t:1\t0\t0\n'));
});

test('parsePngDimensions and clampScreenshotCrop validate and clamp safely', () => {
  assert.deepEqual(parsePngDimensions(makeTestPng(1280, 616)), { width: 1280, height: 616 });
  assert.throws(() => parsePngDimensions(Buffer.from('not a png')));
  assert.deepEqual(
    clampScreenshotCrop({ x: -10, y: 20, width: 5000, height: 400 }, 1836, 884),
    { x: 0, y: 20, width: 1836, height: 400 },
  );
  assert.throws(() => clampScreenshotCrop({ x: 0, y: 0, width: 0, height: 100 }, 1836, 884));
});

test('collectDemuxedStream handles close immediately after end while exec.inspect is pending', async () => {
  const png = makeTestPng(320, 240);
  const emitter = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  let resolveInspect!: (v: { Running: boolean; ExitCode: number }) => void;
  const inspectPromise = new Promise<{ Running: boolean; ExitCode: number }>((r) => {
    resolveInspect = r;
  });

  const promise = collectDemuxedStream(
    emitter,
    (_s, stdout) => {
      queueMicrotask(() => {
        stdout.write(png.subarray(0, 16));
        stdout.write(png.subarray(16));
        emitter.emit('end');
        // TCP docker-socket-proxy often emits 'close' immediately after 'end' before exec.inspect resolves
        emitter.emit('close');
        setTimeout(() => resolveInspect({ Running: false, ExitCode: 0 }), 20);
      });
    },
    () => inspectPromise,
    { timeoutMs: 2000, maxBytes: 1024 * 1024 },
  );

  const out = await promise;
  assert.ok(out.equals(png));
  assert.equal(emitter.destroyed, false);

  // Premature close BEFORE end still rejects cleanly
  const emitter2 = Object.assign(new EventEmitter(), { destroy() {} });
  await assert.rejects(
    collectDemuxedStream(
      emitter2,
      () => queueMicrotask(() => emitter2.emit('close')),
      async () => ({ Running: false, ExitCode: 0 }),
      { timeoutMs: 2000 },
    ),
    /截屏连接异常中断/,
  );

  // Exceeding maxBytes rejects cleanly
  const emitter3 = Object.assign(new EventEmitter(), { destroy() {} });
  await assert.rejects(
    collectDemuxedStream(
      emitter3,
      (_s, stdout) => queueMicrotask(() => stdout.write(Buffer.alloc(100))),
      async () => ({ Running: false, ExitCode: 0 }),
      { timeoutMs: 2000, maxBytes: 50 },
    ),
    /超出上限/,
  );
});

// ---------- Fastify + host-guard + registerMcp integration tests ----------

async function buildMockMcpServer(overrides: Partial<McpDeps> = {}) {
  const allowedHosts = parseAllowedHosts('*.example.com');
  const logs: string[] = [];
  const called: string[] = [];
  const runtimes: Record<string, RuntimeState> = {
    [RUNNING_INST.id]: 'running',
    [STOPPED_INST.id]: 'stopped',
  };
  let lastShotOpts: ScreenshotOptions | undefined;

  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (!isRequestHostAllowed(req.headers.host, req.headers['x-forwarded-host'], allowedHosts)) {
      reply.code(400).send({
        error: 'Host header not allowed',
        host: parseHost(req.headers.host) || null,
      });
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, _body, done) => done(null, null));

  const deps: McpDeps = {
    authToken: TEST_TOKEN,
    allowedHosts,
    panelVersion: 'v9.9.9-test',
    dockerHealthy: async () => true,
    listInstances: () => [RUNNING_INST, STOPPED_INST],
    findInstance: (id) => [RUNNING_INST, STOPPED_INST].find((i) => i.id === id),
    instanceRuntime: async (inst) => runtimes[inst.id] ?? 'missing',
    instanceUptimeSec: async (inst) => (runtimes[inst.id] === 'running' ? 3600 : null),
    instanceMemoryMB: async (inst) => {
      called.push(`mem:${inst.id}`);
      return 878;
    },
    instanceHttpHealthy: async (inst) => {
      called.push(`http:${inst.id}`);
      return true;
    },
    wechatStatus: async (inst) => {
      called.push(`wx:${inst.id}`);
      return { phase: 'done', percent: 100, installed: true, version: '4.1.1.8', message: 'ok', updatedAt: 1 };
    },
    instanceLogs: async (inst, tail = 100) => {
      called.push(`logs:${inst.id}:${tail}`);
      return 'line1\nline2\n' + 'x'.repeat(70_000);
    },
    readInstanceLog: () => `[${new Date().toISOString()}] persisted restart note\n`,
    listInstanceFiles: async (inst) => {
      called.push(`files:${inst.id}`);
      return [{ name: 'report.pdf', size: 12345, mtime: 1700000000 }];
    },
    wechatWindowInfo: async (inst) => {
      called.push(`win:${inst.id}`);
      return {
        display: ':1',
        displayWidth: 1836,
        displayHeight: 884,
        wechatWindow: { id: '10485776', x: 0, y: 0, width: 1836, height: 884, title: '微信' },
      };
    },
    captureInstanceScreenshot: async (inst, opts) => {
      called.push(`shot:${inst.id}`);
      lastShotOpts = opts;
      const w = opts?.crop ? Math.round(opts.crop.width) : opts?.maxWidth === 0 ? 1836 : opts?.maxWidth ?? 1280;
      const h = opts?.crop ? Math.round(opts.crop.height) : 616;
      const png = makeTestPng(w, h);
      return {
        png,
        displayWidth: 1836,
        displayHeight: 884,
        imageWidth: w,
        imageHeight: h,
        maxWidth: opts?.maxWidth ?? 1280,
        crop: opts?.crop ?? null,
        wechatWindow: { id: '10485776', x: 0, y: 0, width: 1836, height: 884, title: '微信' },
        bytes: png.length,
        durationMs: 42,
      };
    },
    effectiveLimits: () => ({ soft: 1500, hard: 1843 }),
    activeVncViewerCount: (id) => (id === RUNNING_INST.id ? 1 : 0),
    getControlLock: (id) =>
      id === RUNNING_INST.id ? { active: true, holder: 'admin', ageMs: 1200 } : { active: false, holder: null, ageMs: null },
    hasActiveSession: (id) => id === RUNNING_INST.id,
    log: (line) => logs.push(line),
    ...overrides,
  };

  registerMcp(app, deps);
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url || '';
    if (url.startsWith('/api') || url.startsWith('/desktop') || url === '/mcp' || url.startsWith('/mcp/') || url.startsWith('/mcp?')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type('text/html').send('<html>spa</html>');
  });

  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    logs,
    called,
    getLastShotOpts: () => lastShotOpts,
    close: () => app.close(),
  };
}

test('MCP disabled when MCP_AUTH_TOKEN is unset/empty: returns 404 JSON (not SPA HTML)', async () => {
  const srv = await buildMockMcpServer({ authToken: '' });
  try {
    const postRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(postRes.status, 404);
    assert.equal(JSON.parse(postRes.body).error, 'not found');
    assert.ok(!postRes.body.includes('<html>'));

    const getRes = await rawHttp(`${srv.url}/mcp`, { method: 'GET' });
    assert.equal(getRes.status, 404);
    assert.equal(JSON.parse(getRes.body).error, 'not found');
  } finally {
    await srv.close();
  }
});

test('MCP security gates: 401 auth, 400 illegal Host, 403 illegal Origin, 405 GET/DELETE', async () => {
  const srv = await buildMockMcpServer();
  try {
    // Missing auth
    const noAuth = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_HEADERS.accept },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(noAuth.status, 401);

    // Wrong token + cookie alone does not authenticate
    const badAuth = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer totally-wrong',
        cookie: 'woc_sess=some-session-cookie',
        'content-type': 'application/json',
        accept: MCP_HEADERS.accept,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badAuth.status, 401);

    // Illegal Host header rejected by real host-guard (400)
    const badHost = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, host: 'evil.attacker.test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badHost.status, 400);
    assert.equal(JSON.parse(badHost.body).error, 'Host header not allowed');

    // Illegal Origin header rejected with 403
    const badOrigin = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, origin: 'https://evil.attacker.test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(JSON.parse(badOrigin.body).error, 'Origin not allowed');

    // GET and DELETE return 405 with Allow: POST
    const getRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'GET',
      headers: { authorization: MCP_HEADERS.authorization },
    });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.allow, 'POST');

    const delRes = await rawHttp(`${srv.url}/mcp`, {
      method: 'DELETE',
      headers: { authorization: MCP_HEADERS.authorization },
    });
    assert.equal(delRes.status, 405);
    assert.equal(delRes.headers.allow, 'POST');

    // Never log the auth token
    assert.ok(!srv.logs.join('\n').includes(TEST_TOKEN));
  } finally {
    await srv.close();
  }
});

test('MCP end-to-end POST /mcp: initialize, tools/list, and all 7 read-only tools + stopped paths', async () => {
  const srv = await buildMockMcpServer();
  const rpc = async (id: number, method: string, params?: Record<string, unknown>, extraHeaders?: Record<string, string>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    assert.equal(res.status, 200, `Expected 200 for ${method}, got ${res.status}: ${res.body}`);
    assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
    return JSON.parse(res.body);
  };

  try {
    // 1. initialize (with allowed LAN Origin)
    const init = await rpc(
      1,
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
      { origin: 'http://192.168.1.10:36080' },
    );
    assert.equal(init.result.serverInfo.name, 'woc-panel-mcp');

    // 2. tools/list — exact 7 read-only tools
    const list = await rpc(2, 'tools/list');
    const names = list.result.tools.map((t: any) => t.name);
    assert.deepEqual(names, MCP_TOOLS.map((t) => t.name));
    assert.equal(names.length, 7);
    for (const tool of list.result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }

    // 3. woc_health
    const health = await rpc(3, 'tools/call', { name: 'woc_health', arguments: {} });
    const healthData = JSON.parse(health.result.content[0].text);
    assert.equal(healthData.ok, true);
    assert.equal(healthData.socket_proxy_ok, true);
    assert.deepEqual(healthData.instances, { total: 2, running: 1, stopped: 1, missing: 0 });

    // 4. woc_list_instances — never leaks kasmPassword / kasmUser
    const instList = await rpc(4, 'tools/call', { name: 'woc_list_instances', arguments: {} });
    const instText = instList.result.content[0].text;
    assert.ok(!instText.includes('SUPER_SECRET_KASM_PASSWORD'));
    assert.ok(!instText.includes('kasmPassword'));
    const instData = JSON.parse(instText);
    assert.equal(instData.instances.length, 2);
    assert.equal(instData.instances[0].runtime, 'running');
    assert.equal(instData.instances[0].memory_mb, 878);
    assert.equal(instData.instances[1].runtime, 'stopped');
    assert.equal(instData.instances[1].instance_stopped, true);
    assert.equal(instData.instances[1].memory_mb, null);

    // 5. woc_instance_status (running & stopped)
    const statusRun = await rpc(5, 'tools/call', {
      name: 'woc_instance_status',
      arguments: { instance_id: RUNNING_INST.id },
    });
    const statusRunData = JSON.parse(statusRun.result.content[0].text);
    assert.equal(statusRunData.instance_stopped, false);
    assert.equal(statusRunData.vnc_http_healthy, true);
    assert.equal(statusRunData.wechat.version, '4.1.1.8');
    assert.deepEqual(statusRunData.watchdog_limits_mb, { soft: 1500, hard: 1843 });

    const statusStop = await rpc(6, 'tools/call', {
      name: 'woc_instance_status',
      arguments: { instance_id: STOPPED_INST.id },
    });
    const statusStopData = JSON.parse(statusStop.result.content[0].text);
    assert.equal(statusStopData.instance_stopped, true);
    assert.equal(statusStopData.wechat, null);
    assert.ok(!srv.called.includes(`wx:${STOPPED_INST.id}`));
    assert.ok(!srv.called.includes(`http:${STOPPED_INST.id}`));

    // 6. woc_get_logs (running + byte cap + stopped + history)
    const logsRun = await rpc(7, 'tools/call', {
      name: 'woc_get_logs',
      arguments: { instance_id: RUNNING_INST.id, tail: 999 },
    });
    const logsRunData = JSON.parse(logsRun.result.content[0].text);
    assert.equal(logsRunData.tail, 500);
    assert.equal(logsRunData.live_truncated, true);
    assert.ok(Buffer.byteLength(logsRunData.live, 'utf8') <= 64 * 1024);

    const logsStop = await rpc(8, 'tools/call', {
      name: 'woc_get_logs',
      arguments: { instance_id: STOPPED_INST.id, include_history: true, range: '24h' },
    });
    const logsStopData = JSON.parse(logsStop.result.content[0].text);
    assert.equal(logsStopData.instance_stopped, true);
    assert.equal(logsStopData.live, null);
    assert.ok(logsStopData.history.includes('persisted restart note'));

    // 7. woc_list_files (running & stopped)
    const filesRun = await rpc(9, 'tools/call', {
      name: 'woc_list_files',
      arguments: { instance_id: RUNNING_INST.id },
    });
    assert.equal(JSON.parse(filesRun.result.content[0].text).files[0].name, 'report.pdf');

    const filesStop = await rpc(10, 'tools/call', {
      name: 'woc_list_files',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(filesStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`files:${STOPPED_INST.id}`));

    // 8. woc_window_info (running & stopped)
    const winRun = await rpc(11, 'tools/call', {
      name: 'woc_window_info',
      arguments: { instance_id: RUNNING_INST.id },
    });
    const winData = JSON.parse(winRun.result.content[0].text);
    assert.equal(winData.display_width, 1836);
    assert.equal(winData.wechat_window.title, '微信');

    const winStop = await rpc(12, 'tools/call', {
      name: 'woc_window_info',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(winStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`win:${STOPPED_INST.id}`));

    // 9. woc_screenshot (running with crop, full_resolution, stopped, and privacy check)
    const shotRun = await rpc(13, 'tools/call', {
      name: 'woc_screenshot',
      arguments: {
        instance_id: RUNNING_INST.id,
        crop: { x: 100, y: 20, width: 600, height: 400 },
      },
    });
    assert.equal(shotRun.result.content.length, 2);
    assert.equal(shotRun.result.content[0].type, 'image');
    assert.equal(shotRun.result.content[0].mimeType, 'image/png');
    const decodedPng = Buffer.from(shotRun.result.content[0].data, 'base64');
    assert.deepEqual(parsePngDimensions(decodedPng), { width: 600, height: 400 });
    const shotMeta = JSON.parse(shotRun.result.content[1].text);
    assert.equal(shotMeta.image_width, 600);
    assert.equal(shotMeta.display_width, 1836);
    assert.equal(shotMeta.wechat_window.title, '微信');
    // Privacy: logs must NEVER contain base64 image data
    assert.ok(!srv.logs.join('\n').includes(shotRun.result.content[0].data));

    await rpc(14, 'tools/call', {
      name: 'woc_screenshot',
      arguments: { instance_id: RUNNING_INST.id, full_resolution: true },
    });
    assert.equal(srv.getLastShotOpts()?.maxWidth, 0);

    const shotStop = await rpc(15, 'tools/call', {
      name: 'woc_screenshot',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(shotStop.result.content[0].text).error, 'instance_stopped');
    assert.ok(!srv.called.includes(`shot:${STOPPED_INST.id}`));
  } finally {
    await srv.close();
  }
});

// ---------- Live booted src/index.ts HTTP verification ----------

async function withBootedPanel(
  extraEnv: Record<string, string | undefined>,
  run: (url: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'woc-mcp-http-'));
  writeFileSync(join(dir, 'index.html'), '<html>spa-fallback</html>');
  // Stand-in Docker API: answers /_ping so the panel does not wait for (or touch) a real Docker, and 404s the rest.
  const fakeDocker = createServer((req, res) => {
    if (req.url?.endsWith('/_ping')) return res.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"not available in tests"}');
  });
  await new Promise<void>((r) => fakeDocker.listen(0, '127.0.0.1', r));
  const dockerPort = (fakeDocker.address() as { port: number }).port;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    STATIC_DIR: dir,
    PANEL_DATA: join(dir, 'accounts.json'),
    PANEL_ADMIN_USER: 'TestAdmin',
    PANEL_ADMIN_PASSWORD: 'isolated-test-password',
    WOC_DOCKER_NETWORK: 'test-no-docker',
    DOCKER_HOST: `tcp://127.0.0.1:${dockerPort}`,
    WOC_INSTANCE_MEM_SOFT_MB: '0',
    WOC_INSTANCE_MEM_HARD_MB: '0',
    WOC_WATCHDOG_INTERVAL_SEC: '0',
  };
  delete env.MCP_AUTH_TOKEN;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('booted panel startup timed out')), 10000);
      child.stdout.on('data', (data) => {
        output += data;
        const m = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`booted panel exited early (${code})`));
      });
    });
    await run(url);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
    fakeDocker.closeAllConnections();
    await new Promise((r) => fakeDocker.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real panel boot: /mcp is disabled (404 JSON, not SPA HTML) when MCP_AUTH_TOKEN is unset', { timeout: 20000 }, async () => {
  await withBootedPanel({ MCP_AUTH_TOKEN: undefined }, async (url) => {
    const res = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, 'not found');
    assert.ok(!res.body.includes('<html>'));
  });
});

test('real panel boot: /mcp enforces auth/host/origin/method and serves initialize, tools/list, and woc_health gracefully without Docker', { timeout: 20000 }, async () => {
  await withBootedPanel({ MCP_AUTH_TOKEN: TEST_TOKEN }, async (url) => {
    // Missing auth -> 401
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status,
      401,
    );
    // Illegal Host -> 400 (host-guard)
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, host: 'evil.attacker.test' }, body: '{}' })).status,
      400,
    );
    // Illegal Origin -> 403
    assert.equal(
      (await rawHttp(`${url}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, origin: 'https://evil.attacker.test' }, body: '{}' })).status,
      403,
    );
    // GET -> 405
    const getRes = await rawHttp(`${url}/mcp`, { method: 'GET', headers: { authorization: MCP_HEADERS.authorization } });
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.allow, 'POST');

    // initialize
    const initRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'live-test', version: '1.0' } },
      }),
    });
    assert.equal(initRes.status, 200);
    assert.equal(JSON.parse(initRes.body).result.serverInfo.name, 'woc-panel-mcp');

    // tools/list
    const listRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(listRes.status, 200);
    assert.equal(JSON.parse(listRes.body).result.tools.length, 7);

    // woc_health against the stand-in Docker: ping answers, no instances registered
    const healthRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'woc_health', arguments: {} },
      }),
    });
    assert.equal(healthRes.status, 200);
    const healthPayload = JSON.parse(JSON.parse(healthRes.body).result.content[0].text);
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.socket_proxy_ok, true);
    assert.equal(healthPayload.instances.total, 0);
  });
});

// ---------- Controlled write tools & native 1:1 header / editor fingerprint ----------

function makeGrayBitmap(size: number, fill = 237, inkOffset = 0, inkCount = 0, inkVal = 30): Buffer {
  const buf = Buffer.alloc(size, fill);
  for (let i = inkOffset; i < Math.min(buf.length, inkOffset + inkCount); i++) {
    buf[i] = inkVal;
  }
  return buf;
}

function makeTestFingerprint(opts: {
  displayWidth?: number;
  displayHeight?: number;
  winW?: number;
  winH?: number;
  headerGray?: Buffer;
  editorGray?: Buffer;
} = {}): SessionFingerprint {
  const displayWidth = opts.displayWidth ?? 1836;
  const displayHeight = opts.displayHeight ?? 884;
  const wechatWindow = {
    id: '10485776',
    x: 0,
    y: 0,
    width: opts.winW ?? displayWidth,
    height: opts.winH ?? displayHeight,
    title: '微信',
  };
  const headerRegion = computeHeaderRegion(wechatWindow, displayWidth, displayHeight)!;
  const editorRegion = computeEditorRegion(wechatWindow, displayWidth, displayHeight)!;
  const headerSize = headerRegion.width * headerRegion.height; // 280*44 = 12320
  const editorSize = editorRegion.width * editorRegion.height; // native 1:1, 1461*82 = 119802
  const headerGray = opts.headerGray ?? makeGrayBitmap(headerSize, 237, 200, 240, 25);
  const editorGray = opts.editorGray ?? makeGrayBitmap(editorSize, 250, 100, 120, 40);
  const { bg: headerBg, inkPixels: headerInkPixels } = countHeaderInkPixels(headerGray);
  return {
    displayWidth,
    displayHeight,
    wechatWindow,
    headerRegion,
    editorRegion,
    headerGray,
    editorGray,
    headerInkPixels,
    headerBg,
    headerDigest: computeHeaderDigest(headerGray, headerRegion.width, headerRegion.height),
    digest: '0123456789abcdef',
  };
}

// Decodes the 8-bit grayscale, filter-0 PNGs produced by encodeGrayPng back to raw pixels.
function decodeGrayPng(png: Buffer): { width: number; height: number; gray: Buffer } {
  const { width, height } = parsePngDimensions(png);
  assert.equal(png[24], 8); // bit depth
  assert.equal(png[25], 0); // colour type: grayscale
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (width + 1) * height);
  const gray = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0); // filter type None
    raw.copy(gray, y * width, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return { width, height, gray };
}

const EDITOR_BYTES = 1461 * 82;
// Editor bitmap as it looks once the draft has left the input box.
const emptyEditorGray = () => makeGrayBitmap(EDITOR_BYTES, 250, 0, 0);
const textBlock = (res: any) => JSON.parse(res.result.content.find((c: any) => c.type === 'text').text);

test('computeHeaderRegion, countHeaderInkPixels, exact 1:1 header match (0px tolerance), and decoupled editor', () => {
  const win = { id: '1', x: 0, y: 0, width: 1836, height: 884, title: '微信' };
  const headerRegion = computeHeaderRegion(win, 1836, 884);
  assert.deepEqual(headerRegion, { x: 355, y: 12, width: 280, height: 44 });
  const editorRegion = computeEditorRegion(win, 1836, 884);
  assert.deepEqual(editorRegion, { x: 355, y: 742, width: 1461, height: 82 });
  assert.equal(computeHeaderRegion({ ...win, width: 400, height: 200 }, 1836, 884), null);
  assert.equal(computeEditorRegion({ ...win, width: 400, height: 200 }, 1836, 884), null);

  // Send button zone guard
  assert.equal(isInSendButtonZone(1750, 850, win), true);
  assert.equal(isInSendButtonZone(1676, 812, win), true);
  assert.equal(isInSendButtonZone(1675, 850, win), false);
  assert.equal(isInSendButtonZone(1750, 811, win), false);
  assert.equal(isInSendButtonZone(1750, 850, null), false);

  // Blank header ink detection
  const headerBytes = 280 * 44;
  const blankBuf = makeGrayBitmap(headerBytes, 237, 0, 0);
  assert.deepEqual(countHeaderInkPixels(blankBuf), { bg: 237, inkPixels: 0, totalPixels: headerBytes });
  const sparseBuf = makeGrayBitmap(headerBytes, 237, 100, MIN_HEADER_INK_PIXELS - 1, 20);
  assert.equal(countHeaderInkPixels(sparseBuf).inkPixels, MIN_HEADER_INK_PIXELS - 1);

  // 4. Identical header MUST match (diff_pixels === 0)
  const fpA = makeTestFingerprint({
    headerGray: makeGrayBitmap(headerBytes, 237, 300, 240, 20), // simulated 2-char Chinese title A
  });
  const fpSame = makeTestFingerprint({
    headerGray: Buffer.from(fpA.headerGray),
    editorGray: Buffer.from(fpA.editorGray),
  });
  const sameCmp = compareSessionFingerprints(fpA, fpSame);
  assert.equal(sameCmp.match, true);
  assert.equal(sameCmp.headerCheck.match, true);
  assert.equal(sameCmp.headerCheck.diffPixels, 0);
  assert.equal(sameCmp.editorCheck.enforced, true);
  assert.equal(sameCmp.editorCheck.maxDiffPixels, DEFAULT_EDITOR_MAX_DIFF_PIXELS);
  assert.equal(sameCmp.editorCheck.diffPixels, 0);
  assert.equal(sameCmp.editorCheck.match, true);

  // 3. Single 1-pixel difference in header MUST be rejected (diff_pixels: 1 -> session_fingerprint_mismatch)
  const onePxGray = Buffer.from(fpA.headerGray);
  onePxGray[500] = onePxGray[500] === 237 ? 236 : 237;
  const fpOnePx = makeTestFingerprint({ headerGray: onePxGray, editorGray: fpA.editorGray });
  const onePxCmp = compareSessionFingerprints(fpA, fpOnePx);
  assert.equal(onePxCmp.match, false);
  assert.equal(onePxCmp.reason, 'session_fingerprint_mismatch');
  assert.equal(onePxCmp.headerCheck.diffPixels, 1);

  // 1. Short 2-char title cross-chat MUST mismatch (diff_pixels > 0 -> session_fingerprint_mismatch)
  const fpShortB = makeTestFingerprint({
    headerGray: makeGrayBitmap(headerBytes, 237, 560, 240, 20), // distinct 2-char Chinese title B
    editorGray: fpA.editorGray,
  });
  const crossCmp = compareSessionFingerprints(fpA, fpShortB);
  assert.equal(crossCmp.match, false);
  assert.equal(crossCmp.reason, 'session_fingerprint_mismatch');
  assert.equal(crossCmp.headerCheck.diffPixels, 480);

  // 5. Default editor check is pixel-exact on the native 1:1 bitmap (DEFAULT_EDITOR_MAX_DIFF_PIXELS = 0); null opts into diagnostic-only
  assert.equal(DEFAULT_EDITOR_MAX_DIFF_PIXELS, 0);
  assert.equal(fpA.editorGray.length, 1461 * 82);
  const fpEditedEditor = makeTestFingerprint({
    headerGray: Buffer.from(fpA.headerGray),
    editorGray: makeGrayBitmap(EDITOR_BYTES, 250, 500, 300, 15),
  });
  const defaultEnforcedFail = compareSessionFingerprints(fpA, fpEditedEditor);
  assert.equal(defaultEnforcedFail.match, false);
  assert.equal(defaultEnforcedFail.reason, 'editor_fingerprint_mismatch');
  assert.equal(defaultEnforcedFail.editorCheck.enforced, true);
  assert.equal(defaultEnforcedFail.editorCheck.maxDiffPixels, DEFAULT_EDITOR_MAX_DIFF_PIXELS);

  const diagCmp = compareSessionFingerprints(fpA, fpEditedEditor, { editorMaxDiffPixels: null });
  assert.equal(diagCmp.match, true);
  assert.equal(diagCmp.headerCheck.diffPixels, 0);
  assert.equal(diagCmp.editorCheck.enforced, false);
  assert.equal(diagCmp.editorCheck.maxDiffPixels, null);
  assert.ok(diagCmp.editorCheck.diffPixels > 100);

  // A single differing editor pixel is rejected by default; a calibrated tolerance can still be injected
  const onePxEditor = Buffer.from(fpA.editorGray);
  onePxEditor[90_000] = onePxEditor[90_000] === 250 ? 249 : 250;
  const fpOnePxEditor = makeTestFingerprint({ headerGray: Buffer.from(fpA.headerGray), editorGray: onePxEditor });
  const onePxEditorCmp = compareSessionFingerprints(fpA, fpOnePxEditor);
  assert.equal(onePxEditorCmp.match, false);
  assert.equal(onePxEditorCmp.reason, 'editor_fingerprint_mismatch');
  assert.equal(onePxEditorCmp.editorCheck.diffPixels, 1);
  assert.equal(onePxEditorCmp.editorCheck.totalPixels, EDITOR_BYTES);
  const tinyDiffEditor = Buffer.from(fpA.editorGray);
  for (let i = 0; i < 4; i++) tinyDiffEditor[2000 + i] = 20;
  const fpTinyDiff = makeTestFingerprint({ headerGray: Buffer.from(fpA.headerGray), editorGray: tinyDiffEditor });
  const tinyOk = compareSessionFingerprints(fpA, fpTinyDiff, { editorMaxDiffPixels: 4 });
  assert.equal(tinyOk.match, true);
  assert.equal(tinyOk.editorCheck.diffPixels, 4);
  assert.equal(compareSessionFingerprints(fpA, fpTinyDiff, { editorMaxDiffPixels: 3 }).match, false);

  // header_digest identifies the title bitmap only: same header -> same digest, 1px change -> different digest
  assert.match(fpA.headerDigest, /^[0-9a-f]{32}$/);
  assert.equal(fpA.headerDigest, fpEditedEditor.headerDigest);
  assert.notEqual(fpA.headerDigest, fpOnePx.headerDigest);

  // Window geometry resized -> window_geometry_mismatch
  const fpResized = makeTestFingerprint({ displayWidth: 1600, displayHeight: 900, winW: 1600, winH: 900 });
  const diffGeo = compareSessionFingerprints(fpA, fpResized);
  assert.equal(diffGeo.match, false);
  assert.equal(diffGeo.reason, 'window_geometry_mismatch');
});

test('write tools gate: MCP_ALLOW_WRITE unset/0 exposes only 7 read-only tools and rejects write tools', async () => {
  const srv = await buildMockMcpServer({ allowWrite: false });
  const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  };
  try {
    const list = await rpc(1, 'tools/list');
    assert.equal(list.result.tools.length, 7);
    for (const writeTool of MCP_WRITE_TOOLS) {
      const res = await rpc(2, 'tools/call', { name: writeTool.name, arguments: {} });
      assert.equal(res.result.isError, true);
      assert.equal(JSON.parse(res.result.content[0].text).error, 'unknown_tool');
    }
  } finally {
    await srv.close();
  }
});

test('MCP_ALLOW_WRITE=1: 13 tools with exact annotations, click/scroll, draft->confirm/discard, guards, rate limits, privacy', async () => {
  let fakeNow = 1_700_000_000_000;
  let liveDisplayW = 1836;
  let liveDisplayH = 884;
  let viewers = 0;
  let controlActive = false;
  let liveFingerprint = makeTestFingerprint();
  let keyThrows = false;
  const clicks: ClickOptions[] = [];
  const scrolls: ScrollOptions[] = [];
  const typed: string[] = [];
  const cleared: string[] = [];
  const keysSent: string[] = [];

  const srv = await buildMockMcpServer({
    allowWrite: true,
    now: () => fakeNow,
    draftTtlMs: 60_000,
    rateLimits: {
      writeWindowMs: 60_000,
      writeMaxPerWindow: 40,
      sendWindowMs: 60_000,
      sendMaxPerWindow: 2,
      sendMinIntervalMs: 3_000,
    },
    activeVncViewerCount: () => viewers,
    getControlLock: () => (controlActive ? { active: true, holder: 'admin', ageMs: 500 } : { active: false, holder: null, ageMs: null }),
    wechatWindowInfo: async () => ({
      display: ':1',
      displayWidth: liveDisplayW,
      displayHeight: liveDisplayH,
      wechatWindow: { id: '10485776', x: 0, y: 0, width: liveDisplayW, height: liveDisplayH, title: '微信' },
    }),
    clickInInstance: async (_inst, opts) => {
      clicks.push(opts);
      return { displayWidth: liveDisplayW, displayHeight: liveDisplayH };
    },
    scrollInInstance: async (_inst, opts) => {
      scrolls.push(opts);
      return { displayWidth: liveDisplayW, displayHeight: liveDisplayH };
    },
    pasteDraftInInstance: async (_inst, text) => {
      typed.push(text);
      // Pasting fills the input box of whichever chat is open.
      liveFingerprint = makeTestFingerprint({ headerGray: liveFingerprint.headerGray });
    },
    clearInputInInstance: async (inst) => {
      cleared.push(inst.id);
    },
    sendReturnInInstance: async (_inst, windowId, opts) => {
      keysSent.push('Return');
      assert.equal(windowId, '10485776');
      assert.equal(opts?.focusCheck, true);
      if (keyThrows) throw new Error('exec timeout');
      // A real send empties the input box.
      liveFingerprint = makeTestFingerprint({ headerGray: liveFingerprint.headerGray, editorGray: emptyEditorGray() });
    },
    sleep: async () => {},
    captureSessionFingerprint: async () => liveFingerprint,
  });

  const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
    return JSON.parse(res.body);
  };

  try {
    // 1. tools/list returns exact 13 tools (7 read-only + woc_session_header + 5 write) with expected annotations
    const list = await rpc(1, 'tools/list');
    assert.equal(list.result.tools.length, 13);
    const byName = new Map<string, any>(list.result.tools.map((t: any) => [t.name, t]));
    assert.equal(byName.get('woc_session_header').annotations.readOnlyHint, true);
    assert.equal(byName.get('woc_session_header').annotations.destructiveHint, false);
    assert.deepEqual(byName.get('woc_draft_reply').inputSchema.required, ['instance_id', 'text']);
    assert.ok(byName.get('woc_draft_reply').inputSchema.properties.expected_header_digest);
    for (const ro of MCP_TOOLS) {
      assert.equal(byName.get(ro.name).annotations.readOnlyHint, true);
      assert.equal(byName.get(ro.name).annotations.destructiveHint, false);
    }
    for (const nonDest of ['woc_scroll', 'woc_draft_reply']) {
      assert.equal(byName.get(nonDest).annotations.readOnlyHint, false);
      assert.equal(byName.get(nonDest).annotations.destructiveHint, false);
      assert.equal(byName.get(nonDest).annotations.idempotentHint, false);
    }
    for (const dest of ['woc_click', 'woc_confirm_send']) {
      assert.equal(byName.get(dest).annotations.readOnlyHint, false);
      assert.equal(byName.get(dest).annotations.destructiveHint, true);
      assert.equal(byName.get(dest).annotations.idempotentHint, false);
    }
    assert.equal(byName.get('woc_discard_draft').annotations.readOnlyHint, false);
    assert.equal(byName.get('woc_discard_draft').annotations.destructiveHint, false);
    assert.equal(byName.get('woc_discard_draft').annotations.idempotentHint, true);

    // 2. woc_click: happy path, send_button_click_blocked, display_size_mismatch, out-of-bounds
    const clickOk = await rpc(2, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: RUNNING_INST.id, x: 500, y: 300, display_width: 1836, display_height: 884, button: 'right', double_click: true },
    });
    assert.equal(JSON.parse(clickOk.result.content[0].text).ok, true);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].button, 'right');
    assert.equal(clicks[0].doubleClick, true);

    const clickSendBlocked = await rpc(201, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: RUNNING_INST.id, x: 1750, y: 850, display_width: 1836, display_height: 884 },
    });
    assert.equal(JSON.parse(clickSendBlocked.result.content[0].text).error, 'send_button_click_blocked');
    assert.equal(clicks.length, 1);

    const clickMismatch = await rpc(3, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: RUNNING_INST.id, x: 500, y: 300, display_width: 1280, display_height: 720 },
    });
    const clickMismatchBody = JSON.parse(clickMismatch.result.content[0].text);
    assert.equal(clickMismatchBody.error, 'display_size_mismatch');
    assert.equal(clickMismatchBody.actual_display_width, 1836);
    assert.equal(clicks.length, 1);

    const clickOob = await rpc(4, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: RUNNING_INST.id, x: 1836, y: 100, display_width: 1836, display_height: 884 },
    });
    assert.equal(JSON.parse(clickOob.result.content[0].text).error, 'coordinates_out_of_bounds');
    assert.equal(clicks.length, 1);

    // 3. woc_scroll: happy path, display_size_mismatch, out-of-bounds
    const scrollOk = await rpc(5, 'tools/call', {
      name: 'woc_scroll',
      arguments: { instance_id: RUNNING_INST.id, x: 800, y: 400, display_width: 1836, display_height: 884, direction: 'down', clicks: 5 },
    });
    assert.equal(JSON.parse(scrollOk.result.content[0].text).ok, true);
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].direction, 'down');
    assert.equal(scrolls[0].clicks, 5);

    const scrollMismatch = await rpc(6, 'tools/call', {
      name: 'woc_scroll',
      arguments: { instance_id: RUNNING_INST.id, x: 800, y: 400, display_width: 1000, display_height: 600, direction: 'up' },
    });
    assert.equal(JSON.parse(scrollMismatch.result.content[0].text).error, 'display_size_mismatch');

    const scrollOob = await rpc(7, 'tools/call', {
      name: 'woc_scroll',
      arguments: { instance_id: RUNNING_INST.id, x: -5, y: 400, display_width: 1836, display_height: 884, direction: 'up' },
    });
    assert.equal(JSON.parse(scrollOob.result.content[0].text).error, 'coordinates_out_of_bounds');

    // 4. human_in_control guard (both controlHolders AND activeVncViewerCount > 0)
    controlActive = true;
    const lockBlocked = await rpc(8, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: RUNNING_INST.id, x: 100, y: 100, display_width: 1836, display_height: 884 },
    });
    assert.equal(JSON.parse(lockBlocked.result.content[0].text).error, 'human_in_control');
    controlActive = false;

    viewers = 1;
    const viewerBlocked = await rpc(9, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'SECRET_BLOCKED_TEXT' },
    });
    assert.equal(JSON.parse(viewerBlocked.result.content[0].text).error, 'human_in_control');
    const discardBlocked = await rpc(901, 'tools/call', {
      name: 'woc_discard_draft',
      arguments: { instance_id: RUNNING_INST.id },
    });
    assert.equal(JSON.parse(discardBlocked.result.content[0].text).error, 'human_in_control');
    assert.equal(typed.length, 0);
    assert.equal(cleared.length, 0);
    viewers = 0;

    // 5. instance_stopped rejected on write tools without starting container
    const stopClick = await rpc(10, 'tools/call', {
      name: 'woc_click',
      arguments: { instance_id: STOPPED_INST.id, x: 100, y: 100, display_width: 1836, display_height: 884 },
    });
    assert.equal(JSON.parse(stopClick.result.content[0].text).error, 'instance_stopped');

    const stopDraft = await rpc(11, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: STOPPED_INST.id, text: 'hello' },
    });
    assert.equal(JSON.parse(stopDraft.result.content[0].text).error, 'instance_stopped');

    const stopDiscard = await rpc(1101, 'tools/call', {
      name: 'woc_discard_draft',
      arguments: { instance_id: STOPPED_INST.id },
    });
    assert.equal(JSON.parse(stopDiscard.result.content[0].text).error, 'instance_stopped');

    // 6. woc_draft_reply (clearFirst: true) + woc_confirm_send happy path + replay protection
    const SECRET_MSG = 'PRIVATE_WECHAT_REPLY_DO_NOT_LOG_987654';
    const draftRes = await rpc(12, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: SECRET_MSG },
    });
    assert.equal(draftRes.result.content.length, 4);
    assert.deepEqual(draftRes.result.content.map((c: any) => c.type), ['image', 'text', 'image', 'image']);
    assert.equal(draftRes.result.content[0].mimeType, 'image/png');
    const draftMeta = JSON.parse(draftRes.result.content[1].text);
    assert.deepEqual(draftMeta.images, ['screenshot', 'header_native', 'editor_native']);
    assert.deepEqual(parsePngDimensions(Buffer.from(draftRes.result.content[2].data, 'base64')), { width: 280, height: 44 });
    assert.deepEqual(parsePngDimensions(Buffer.from(draftRes.result.content[3].data, 'base64')), { width: 1461, height: 82 });
    assert.match(draftMeta.fingerprint_summary.header_digest, /^[0-9a-f]{32}$/);
    assert.equal(draftMeta.ok, true);
    assert.equal(draftMeta.text_length, SECRET_MSG.length);
    assert.equal(draftMeta.ttl_sec, 60);
    assert.ok(draftMeta.draft_id);
    assert.equal(draftMeta.fingerprint_summary.header_ink_pixels, 240);
    assert.equal(typed.length, 1);
    assert.deepEqual(typed, [SECRET_MSG]);

    const confirmOk = await rpc(13, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: draftMeta.draft_id },
    });
    const confirmOkBody = JSON.parse(confirmOk.result.content[0].text);
    assert.equal(confirmOkBody.sent, true);
    assert.equal(confirmOkBody.send_verified, true);
    assert.deepEqual(confirmOkBody.post_send, { result: 'verified', samples_taken: 3 });
    assert.equal(confirmOkBody.samples_taken, 1);
    assert.equal(confirmOkBody.header_check.match, true);
    assert.equal(confirmOkBody.header_check.diff_pixels, 0);
    assert.equal(confirmOkBody.editor_check.enforced, true);
    assert.equal(confirmOkBody.editor_check.match, true);
    assert.equal(confirmOkBody.editor_check.diff_pixels, 0);
    assert.deepEqual(keysSent, ['Return']);

    // 6a. Blank header rejected on woc_draft_reply with header_blank (no draft_id issued!)
    liveFingerprint = makeTestFingerprint({ headerGray: makeGrayBitmap(280 * 44, 237, 0, 0) });
    const blankDraftRes = await rpc(1301, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'blank-header-test' },
    });
    const blankDraftBody = JSON.parse(blankDraftRes.result.content[0].text);
    assert.equal(blankDraftBody.ok, false);
    assert.equal(blankDraftBody.error, 'header_blank');
    assert.equal(blankDraftBody.header_ink_pixels, 0);
    assert.equal(blankDraftBody.min_header_ink_pixels, MIN_HEADER_INK_PIXELS);
    assert.equal(blankDraftBody.draft_id, undefined);
    // Checked BEFORE pasting: nothing was typed, so there is no residue to clean up.
    assert.equal(blankDraftBody.input_may_have_residual_draft, false);
    assert.equal(typed.length, 1);
    liveFingerprint = makeTestFingerprint();

    // Replay same draft_id -> draft_not_found + input_may_have_residual_draft: true
    const replay = await rpc(14, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: draftMeta.draft_id },
    });
    const replayBody = JSON.parse(replay.result.content[0].text);
    assert.equal(replayBody.error, 'draft_not_found');
    assert.equal(replayBody.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 1);

    // 6b. woc_click and woc_scroll invalidate pending drafts
    const dClick = JSON.parse((await rpc(1401, 'tools/call', { name: 'woc_draft_reply', arguments: { instance_id: RUNNING_INST.id, text: 'inv-click' } })).result.content[1].text).draft_id;
    const clickInvBody = JSON.parse((await rpc(1402, 'tools/call', { name: 'woc_click', arguments: { instance_id: RUNNING_INST.id, x: 500, y: 300, display_width: 1836, display_height: 884 } })).result.content[0].text);
    assert.equal(clickInvBody.invalidated_drafts, 1);
    assert.equal(JSON.parse((await rpc(1403, 'tools/call', { name: 'woc_confirm_send', arguments: { instance_id: RUNNING_INST.id, draft_id: dClick } })).result.content[0].text).error, 'draft_not_found');

    const dScroll = JSON.parse((await rpc(1404, 'tools/call', { name: 'woc_draft_reply', arguments: { instance_id: RUNNING_INST.id, text: 'inv-scroll' } })).result.content[1].text).draft_id;
    const scrollInvBody = JSON.parse((await rpc(1405, 'tools/call', { name: 'woc_scroll', arguments: { instance_id: RUNNING_INST.id, x: 500, y: 300, display_width: 1836, display_height: 884, direction: 'up' } })).result.content[0].text);
    assert.equal(scrollInvBody.invalidated_drafts, 1);
    assert.equal(JSON.parse((await rpc(1406, 'tools/call', { name: 'woc_confirm_send', arguments: { instance_id: RUNNING_INST.id, draft_id: dScroll } })).result.content[0].text).error, 'draft_not_found');

    // 6c. woc_discard_draft invalidates pending drafts and clears input box
    const dDiscard = JSON.parse((await rpc(1407, 'tools/call', { name: 'woc_draft_reply', arguments: { instance_id: RUNNING_INST.id, text: 'to-discard' } })).result.content[1].text).draft_id;
    const discardOk = JSON.parse((await rpc(1408, 'tools/call', { name: 'woc_discard_draft', arguments: { instance_id: RUNNING_INST.id } })).result.content[0].text);
    assert.equal(discardOk.ok, true);
    assert.equal(discardOk.invalidated_drafts, 1);
    assert.equal(discardOk.input_cleared, true);
    assert.deepEqual(cleared, [RUNNING_INST.id]);
    assert.equal(JSON.parse((await rpc(1409, 'tools/call', { name: 'woc_confirm_send', arguments: { instance_id: RUNNING_INST.id, draft_id: dDiscard } })).result.content[0].text).error, 'draft_not_found');

    // 7. Draft expired -> draft_expired + input_may_have_residual_draft: true
    const draftExpRes = await rpc(15, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'expiring' },
    });
    const expId = JSON.parse(draftExpRes.result.content[1].text).draft_id;
    fakeNow += 61_000;
    const confirmExp = await rpc(16, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: expId },
    });
    const confirmExpBody = JSON.parse(confirmExp.result.content[0].text);
    assert.equal(confirmExpBody.error, 'draft_expired');
    assert.equal(confirmExpBody.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 1);

    // 8. Wrong instance_id -> draft_instance_mismatch + consumes draft_id
    const draftWrongRes = await rpc(17, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'wrong-inst' },
    });
    const wrongId = JSON.parse(draftWrongRes.result.content[1].text).draft_id;
    const confirmWrongBody = JSON.parse((await rpc(18, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: STOPPED_INST.id, draft_id: wrongId },
    })).result.content[0].text);
    assert.equal(confirmWrongBody.error, 'draft_instance_mismatch');
    assert.equal(confirmWrongBody.input_may_have_residual_draft, true);
    const retryAfterWrong = await rpc(19, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: wrongId },
    });
    assert.equal(JSON.parse(retryAfterWrong.result.content[0].text).error, 'draft_not_found');

    // 9. Single 1-pixel header change -> session_fingerprint_mismatch (zero tolerance!)
    liveFingerprint = makeTestFingerprint();
    const draftFpRes = await rpc(20, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'fp-check' },
    });
    const fpId = JSON.parse(draftFpRes.result.content[1].text).draft_id;
    const onePxHeader = Buffer.from(liveFingerprint.headerGray);
    onePxHeader[123] = onePxHeader[123] === 237 ? 236 : 237;
    liveFingerprint = makeTestFingerprint({ headerGray: onePxHeader, editorGray: liveFingerprint.editorGray });
    fakeNow += 5_000;
    const confirmFpFail = JSON.parse((await rpc(21, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: fpId },
    })).result.content[0].text);
    assert.equal(confirmFpFail.error, 'session_fingerprint_mismatch');
    assert.equal(confirmFpFail.input_may_have_residual_draft, true);
    assert.equal(confirmFpFail.header_check.match, false);
    assert.equal(confirmFpFail.header_check.diff_pixels, 1);
    assert.equal(keysSent.length, 1);

    // 9b. Editor change across all 3 samples -> editor_fingerprint_mismatch (default threshold=0)
    liveFingerprint = makeTestFingerprint();
    fakeNow += 61_000;
    const draftEdRes2 = await rpc(2102, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'editor-enforced-check' },
    });
    const edId2 = JSON.parse(draftEdRes2.result.content[1].text).draft_id;
    liveFingerprint = makeTestFingerprint({
      headerGray: Buffer.from(liveFingerprint.headerGray),
      editorGray: makeGrayBitmap(EDITOR_BYTES, 250, 400, 180, 15),
    });
    const confirmEdFail = JSON.parse((await rpc(2103, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: edId2 },
    })).result.content[0].text);
    assert.equal(confirmEdFail.error, 'editor_fingerprint_mismatch');
    assert.equal(confirmEdFail.samples_taken, 3);
    assert.equal(confirmEdFail.header_check.diff_pixels, 0);
    assert.equal(confirmEdFail.editor_check.enforced, true);
    assert.equal(confirmEdFail.editor_check.match, false);
    assert.equal(confirmEdFail.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 1);

    // 10. Window geometry mismatch -> aborted & consumed
    liveFingerprint = makeTestFingerprint();
    fakeNow += 61_000; // reset confirm_send window before geo-check
    const draftGeoRes = await rpc(23, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'geo-check' },
    });
    const geoId = JSON.parse(draftGeoRes.result.content[1].text).draft_id;
    liveFingerprint = makeTestFingerprint({ displayWidth: 1600, displayHeight: 900, winW: 1600, winH: 900 });
    fakeNow += 5_000;
    const confirmGeoFail = JSON.parse((await rpc(24, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: geoId },
    })).result.content[0].text);
    assert.equal(confirmGeoFail.error, 'window_geometry_mismatch');
    assert.equal(confirmGeoFail.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 1);

    // 11. Send error -> send_uncertain_no_retry, NO auto-retry, draft consumed, residual flag
    liveFingerprint = makeTestFingerprint();
    fakeNow += 61_000;
    keyThrows = true;
    const draftErrRes2 = await rpc(26, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'no-retry-2' },
    });
    const errId2 = JSON.parse(draftErrRes2.result.content[1].text).draft_id;
    const confirmErr = await rpc(27, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: errId2 },
    });
    assert.equal(confirmErr.result.isError, true);
    const confirmErrBody = JSON.parse(confirmErr.result.content[0].text);
    assert.equal(confirmErrBody.error, 'send_uncertain_no_retry');
    assert.equal(confirmErrBody.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 2); // called strictly once for this send, zero auto-retry!
    assert.equal(JSON.parse((await rpc(28, 'tools/call', { name: 'woc_confirm_send', arguments: { instance_id: RUNNING_INST.id, draft_id: errId2 } })).result.content[0].text).error, 'draft_not_found');
    keyThrows = false;

    // 12. Rate limiting: confirm_send min interval (3s) -> rate_limited + residual flag
    const draftRate1 = await rpc(29, 'tools/call', {
      name: 'woc_draft_reply',
      arguments: { instance_id: RUNNING_INST.id, text: 'rate-1' },
    });
    const rateId1 = JSON.parse(draftRate1.result.content[1].text).draft_id;
    fakeNow += 500;
    const confirmRateBlocked = await rpc(30, 'tools/call', {
      name: 'woc_confirm_send',
      arguments: { instance_id: RUNNING_INST.id, draft_id: rateId1 },
    });
    const rateBody = JSON.parse(confirmRateBlocked.result.content[0].text);
    assert.equal(rateBody.error, 'rate_limited');
    assert.equal(rateBody.limit_scope, 'confirm_send');
    assert.equal(rateBody.input_may_have_residual_draft, true);
    assert.ok(rateBody.retry_after_ms > 0);

    // 13. Privacy audit log verification: zero plaintext message, zero base64 PNG, zero token
    const allLogs = srv.logs.join('\n');
    assert.ok(allLogs.includes('[mcp-audit]'));
    assert.ok(!allLogs.includes(SECRET_MSG));
    assert.ok(!allLogs.includes('SECRET_BLOCKED_TEXT'));
    assert.ok(!allLogs.includes(TEST_TOKEN));
    assert.ok(!allLogs.includes(draftRes.result.content[0].data));
  } finally {
    await srv.close();
  }
});

test('general write rate limiter enforces per-minute window', async () => {
  let fakeNow = 1_700_000_000_000;
  const srv = await buildMockMcpServer({
    allowWrite: true,
    now: () => fakeNow,
    rateLimits: { writeWindowMs: 60_000, writeMaxPerWindow: 2 },
    activeVncViewerCount: () => 0,
    getControlLock: () => ({ active: false, holder: null, ageMs: null }),
    clickInInstance: async () => ({ displayWidth: 1836, displayHeight: 884 }),
  });
  const callClick = async (id: number) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'woc_click',
          arguments: { instance_id: RUNNING_INST.id, x: 100, y: 100, display_width: 1836, display_height: 884 },
        },
      }),
    });
    return JSON.parse(JSON.parse(res.body).result.content[0].text);
  };
  try {
    assert.equal((await callClick(1)).ok, true);
    assert.equal((await callClick(2)).ok, true);
    const third = await callClick(3);
    assert.equal(third.error, 'rate_limited');
    assert.equal(third.limit_scope, 'write');
    assert.ok(third.retry_after_ms > 0);
    // Advance past window -> allowed again
    fakeNow += 60_001;
    assert.equal((await callClick(4)).ok, true);
  } finally {
    await srv.close();
  }
});

test('multi-sample early-exit EDITOR verification (blink recovery, 1-char edit rejection, Sample-2 header abort) + post-send check', async () => {
  const baseFp = makeTestFingerprint();
  const makeEditorDiffFp = (diffCount: number, headerChanged = false): SessionFingerprint => {
    const hGray = Buffer.from(baseFp.headerGray);
    if (headerChanged) hGray[10] = hGray[10] === 237 ? 20 : 237;
    const eGray = Buffer.from(baseFp.editorGray);
    for (let i = 0; i < diffCount; i++) {
      eGray[1000 + i] = eGray[1000 + i] === 250 ? 20 : 250;
    }
    return makeTestFingerprint({ headerGray: hGray, editorGray: eGray });
  };
  const emptyFp = makeTestFingerprint({ editorGray: emptyEditorGray() });

  let fakeNow = 1_700_000_000_000;
  let queue: SessionFingerprint[] = [];
  let captureCount = 0;
  let sleeps: number[] = [];
  let viewers = 0;
  let viewersAfterCapture = Infinity;
  let returnError: Error | null = null;
  let captureThrows = false;
  const keysSent: string[] = [];

  const srv = await buildMockMcpServer({
    allowWrite: true,
    now: () => fakeNow,
    confirmMaxSamples: 3,
    confirmSampleDelayMs: 350,
    postSendSettleMs: 300,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rateLimits: { writeMaxPerWindow: 200, sendMaxPerWindow: 50, sendMinIntervalMs: 1000 },
    activeVncViewerCount: () => viewers,
    getControlLock: () => ({ active: false, holder: null, ageMs: null }),
    pasteDraftInInstance: async () => {},
    sendReturnInInstance: async () => {
      keysSent.push('Return');
      if (returnError) throw returnError;
    },
    captureSessionFingerprint: async () => {
      captureCount++;
      if (captureThrows) throw new Error('截屏执行超时');
      if (captureCount >= viewersAfterCapture) viewers = 1;
      return queue.shift() ?? baseFp;
    },
  });

  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  };
  // Each draft takes 2 captures (pre-paste header check + post-paste fingerprint); the rest feed woc_confirm_send.
  const draftThenConfirm = async (id: number, confirmFrames: SessionFingerprint[]) => {
    fakeNow += 5_000;
    queue = [baseFp, baseFp, ...confirmFrames];
    captureCount = 0;
    sleeps = [];
    const draftId = textBlock(await callTool(id, 'woc_draft_reply', { instance_id: RUNNING_INST.id, text: `case-${id}` })).draft_id;
    assert.ok(draftId);
    return textBlock(await callTool(id + 1, 'woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: draftId }));
  };

  try {
    // Case 1: Early-exit on Sample 1 (diff=0 -> 1 verification capture), then 3 post-send frames all differ -> verified
    const r1 = await draftThenConfirm(1, [baseFp, emptyFp, emptyFp, emptyFp]);
    assert.equal(r1.sent, true);
    assert.equal(r1.send_verified, true);
    assert.equal(r1.samples_taken, 1);
    assert.equal(r1.editor_check.diff_pixels, 0);
    assert.deepEqual(r1.post_send, { result: 'verified', samples_taken: 3 });
    assert.equal(captureCount, 6); // 2 draft + 1 verify + 3 post-send
    assert.deepEqual(sleeps, [300, 350, 350]); // no sleep before the key press

    // Case 2: Blinking-caret recovery on Sample 2 ([43, 0] -> PASS with samples_taken: 2)
    const r2 = await draftThenConfirm(3, [makeEditorDiffFp(43), makeEditorDiffFp(0), emptyFp, emptyFp, emptyFp]);
    assert.equal(r2.sent, true);
    assert.equal(r2.samples_taken, 2);
    assert.equal(r2.editor_check.diff_pixels, 0);
    assert.equal(captureCount, 7); // 2 draft + 2 verify + 3 post-send
    assert.deepEqual(sleeps, [350, 300, 350, 350]);
    assert.equal(keysSent.length, 2);

    // Case 3: Real 1-char edit rejected across all 3 samples ([76, 33, 33] -> editor_fingerprint_mismatch, best diff=33)
    const r3 = await draftThenConfirm(5, [makeEditorDiffFp(76), makeEditorDiffFp(33), makeEditorDiffFp(33)]);
    assert.equal(r3.error, 'editor_fingerprint_mismatch');
    assert.equal(r3.samples_taken, 3);
    assert.equal(r3.editor_check.diff_pixels, 33);
    assert.equal(r3.editor_check.max_diff_pixels, 0);
    assert.equal(r3.input_may_have_residual_draft, true);
    assert.equal(captureCount, 5); // 2 draft + 3 verify, no post-send
    assert.equal(keysSent.length, 2); // NOT sent

    // Case 3b: with the pixel-exact default even a 1-pixel edit that persists in every frame is rejected
    const r3b = await draftThenConfirm(51, [makeEditorDiffFp(1), makeEditorDiffFp(1), makeEditorDiffFp(1)]);
    assert.equal(r3b.error, 'editor_fingerprint_mismatch');
    assert.equal(r3b.editor_check.diff_pixels, 1);
    assert.equal(keysSent.length, 2);

    // Case 4: Header mismatch on Sample 2 immediately aborts without taking Sample 3
    const r4 = await draftThenConfirm(7, [makeEditorDiffFp(43, false), makeEditorDiffFp(0, true), makeEditorDiffFp(0, false)]);
    assert.equal(r4.error, 'session_fingerprint_mismatch');
    assert.equal(r4.samples_taken, 2);
    assert.equal(r4.header_check.diff_pixels, 1);
    assert.equal(r4.input_may_have_residual_draft, true);
    assert.equal(captureCount, 4); // 2 draft + 2 verify (did NOT take Sample 3!)
    assert.equal(keysSent.length, 2);

    // Case 5: Return pressed but the draft is still in the box in one post-send frame -> send_unconfirmed (never "sent: true")
    const r5 = await draftThenConfirm(9, [baseFp, makeEditorDiffFp(43), baseFp]);
    assert.equal(r5.ok, false);
    assert.equal(r5.error, 'send_unconfirmed');
    assert.equal(r5.return_dispatched, true);
    assert.equal(r5.sent, undefined);
    assert.deepEqual(r5.post_send, { result: 'editor_unchanged', samples_taken: 2 });
    assert.equal(r5.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 3); // pressed exactly once, never retried
    assert.ok(srv.logs.some((l) => l.includes('"error":"send_unconfirmed"')));

    // Case 6: the chat header changes right after Return -> sent but NOT claimed as verified
    const r6 = await draftThenConfirm(11, [baseFp, makeEditorDiffFp(0, true)]);
    assert.equal(r6.ok, true);
    assert.equal(r6.sent, true);
    assert.equal(r6.send_verified, false);
    assert.equal(r6.post_send.result, 'inconclusive');
    assert.equal(keysSent.length, 4);

    // Case 7: a human opens the desktop while the samples are being taken -> re-check blocks the key press
    viewersAfterCapture = 4; // 2 draft captures, viewer appears during the 2nd verification sample
    const r7 = await draftThenConfirm(13, [makeEditorDiffFp(43), baseFp]);
    assert.equal(r7.error, 'human_in_control');
    assert.equal(r7.sent, false);
    assert.equal(r7.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, 4); // Return NOT pressed
    viewers = 0;
    viewersAfterCapture = Infinity;

    // Case 8: focus moved to another window -> focus_mismatch, Return NOT pressed, not flagged as a tool crash
    returnError = new InputCommandError('focus_mismatch', 'no', 'focus_mismatch active=999 expected=10485776');
    const r8 = await draftThenConfirm(15, [baseFp]);
    assert.equal(r8.error, 'focus_mismatch');
    assert.equal(r8.sent, false);
    assert.equal(r8.input_may_have_residual_draft, true);
    assert.equal(captureCount, 3); // no post-send captures
    returnError = null;

    // Case 9: the fingerprint capture itself fails during verification -> confirm_check_failed, Return NOT pressed
    const before = keysSent.length;
    fakeNow += 5_000;
    queue = [baseFp, baseFp];
    const d9 = textBlock(await callTool(17, 'woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'case-17' })).draft_id;
    captureThrows = true;
    const r9 = textBlock(await callTool(18, 'woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: d9 }));
    captureThrows = false;
    assert.equal(r9.error, 'confirm_check_failed');
    assert.equal(r9.detail, '截屏执行超时');
    assert.equal(r9.sent, false);
    assert.equal(r9.input_may_have_residual_draft, true);
    assert.equal(keysSent.length, before);
  } finally {
    await srv.close();
  }
});

test('session gate: woc_session_header digest pins the chat, a new draft retires older ones, uncertain input never leaves a draft confirmable', async () => {
  const chatA = makeTestFingerprint();
  const chatBHeader = makeGrayBitmap(280 * 44, 237, 900, 346, 25);
  let live = chatA;
  let switchChatOnPaste = false;
  let captureThrowsAfterPaste = false;
  let clickError: Error | null = null;
  const typed: string[] = [];
  const clicks: ClickOptions[] = [];
  const keysSent: string[] = [];
  let fakeNow = 1_700_000_000_000;

  const srv = await buildMockMcpServer({
    allowWrite: true,
    now: () => fakeNow,
    rateLimits: { writeMaxPerWindow: 200, sendMaxPerWindow: 50, sendMinIntervalMs: 0 },
    activeVncViewerCount: () => 0,
    getControlLock: () => ({ active: false, holder: null, ageMs: null }),
    sleep: async () => {},
    pasteDraftInInstance: async (_inst, text) => {
      typed.push(text);
      if (switchChatOnPaste) live = makeTestFingerprint({ headerGray: chatBHeader });
      if (captureThrowsAfterPaste) live = null as unknown as SessionFingerprint;
    },
    clickInInstance: async (_inst, opts) => {
      if (clickError) throw clickError;
      clicks.push(opts);
      return { displayWidth: 1836, displayHeight: 884 };
    },
    sendReturnInInstance: async () => {
      keysSent.push('Return');
      live = makeTestFingerprint({ headerGray: live.headerGray, editorGray: emptyEditorGray() });
    },
    captureSessionFingerprint: async () => {
      if (!live) throw new Error('ffmpeg capture failed');
      return live;
    },
  });
  let nextId = 1;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    assert.equal(res.status, 200);
    return JSON.parse(res.body);
  };
  const click = () =>
    call('woc_click', { instance_id: RUNNING_INST.id, x: 200, y: 648, display_width: 1836, display_height: 884 });

  try {
    // woc_session_header: the image is exactly the bytes the digest was computed from
    const hdrRes = await call('woc_session_header', { instance_id: RUNNING_INST.id });
    assert.deepEqual(hdrRes.result.content.map((c: any) => c.type), ['image', 'text']);
    const hdr = textBlock(hdrRes);
    assert.equal(hdr.ok, true);
    assert.equal(hdr.header_digest, chatA.headerDigest);
    assert.equal(hdr.header_blank, false);
    assert.equal(hdr.header_ink_pixels, 240);
    const decoded = decodeGrayPng(Buffer.from(hdrRes.result.content[0].data, 'base64'));
    assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 280, height: 44 });
    assert.ok(decoded.gray.equals(chatA.headerGray));
    assert.equal(computeHeaderDigest(decoded.gray, decoded.width, decoded.height), hdr.header_digest);
    // Read-only: works without consuming the write rate limit and is refused cleanly on a stopped instance
    assert.equal(textBlock(await call('woc_session_header', { instance_id: STOPPED_INST.id })).error, 'instance_stopped');
    assert.ok(!srv.logs.join('\n').includes(hdr.header_digest));

    // The chat list reordered and a different chat is open now (the B3 failure): nothing is pasted
    live = makeTestFingerprint({ headerGray: chatBHeader });
    const wrongChat = await call('woc_draft_reply', {
      instance_id: RUNNING_INST.id,
      text: 'for chat A only',
      expected_header_digest: hdr.header_digest,
    });
    const wrongChatBody = textBlock(wrongChat);
    assert.equal(wrongChatBody.error, 'session_header_mismatch');
    assert.equal(wrongChatBody.expected_header_digest, chatA.headerDigest);
    assert.equal(wrongChatBody.actual_header_digest, live.headerDigest);
    assert.equal(wrongChatBody.input_may_have_residual_draft, false);
    assert.equal(wrongChatBody.draft_id, undefined);
    assert.equal(typed.length, 0); // NOT pasted into the wrong chat
    assert.ok(decodeGrayPng(Buffer.from(wrongChat.result.content.find((c: any) => c.type === 'image').data, 'base64')).gray.equals(chatBHeader));
    const badDigest = await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'x', expected_header_digest: 'not-a-digest' });
    assert.equal(badDigest.result.isError, true);
    assert.equal(typed.length, 0);

    // Back on chat A: the pinned draft goes through, and a second draft retires the first draft_id
    live = chatA;
    const d1 = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'first', expected_header_digest: hdr.header_digest }));
    assert.equal(d1.ok, true);
    assert.equal(d1.invalidated_drafts, 0);
    assert.equal(d1.fingerprint_summary.header_digest, chatA.headerDigest);
    const d2 = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'second', expected_header_digest: hdr.header_digest }));
    assert.equal(d2.ok, true);
    assert.equal(d2.invalidated_drafts, 1);
    assert.equal(textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: d1.draft_id })).error, 'draft_not_found');
    assert.equal(keysSent.length, 0);
    const sent = textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: d2.draft_id }));
    assert.equal(sent.sent, true);
    assert.equal(sent.send_verified, true);
    assert.equal(keysSent.length, 1);

    // A click that times out (outcome unknown) must still retire the pending draft
    live = chatA;
    const d3 = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'third' }));
    clickError = new InputCommandError('input_timeout', 'unknown', '点击超时：容器内进程已被终止，不会延迟触发；是否已部分执行未知');
    const timedOut = await click();
    const timedOutBody = textBlock(timedOut);
    assert.equal(timedOut.result.isError, true);
    assert.equal(timedOutBody.error, 'input_timeout');
    assert.equal(timedOutBody.dispatched, 'unknown');
    assert.equal(timedOutBody.invalidated_drafts, 1);
    assert.equal(textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: d3.draft_id })).error, 'draft_not_found');

    // Same for an untyped failure (e.g. the docker exec connection dropped) and for a busy input lock
    const d4 = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'fourth' }));
    clickError = new Error('命令结果未知：连接关闭');
    assert.equal((await click()).result.isError, true);
    assert.equal(textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: d4.draft_id })).error, 'draft_not_found');
    clickError = Object.assign(new Error('该实例正在处理输入，请稍后再试'), { statusCode: 409 });
    const busy = textBlock(await click());
    assert.equal(busy.error, 'input_busy');
    assert.equal(busy.dispatched, 'no');
    clickError = new InputCommandError('input_precondition_failed', 'no', 'pointer_not_at_target actual=10,10 target=200,648');
    const notDispatched = await click();
    assert.equal(notDispatched.result.isError, undefined);
    assert.equal(textBlock(notDispatched).dispatched, 'no');
    clickError = null;
    assert.equal(clicks.length, 0);
    assert.equal(keysSent.length, 1);

    // The user switches chats while the paste is running -> no draft_id, residue flagged
    switchChatOnPaste = true;
    live = chatA;
    const moved = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'moved', expected_header_digest: hdr.header_digest }));
    assert.equal(moved.error, 'session_changed_during_draft');
    assert.equal(moved.draft_id, undefined);
    assert.equal(moved.input_may_have_residual_draft, true);
    assert.ok(moved.header_check.diff_pixels > 0);
    switchChatOnPaste = false;

    // The post-paste capture fails -> draft_failed_after_paste with the residue hint instead of a bare error
    captureThrowsAfterPaste = true;
    live = chatA;
    const failed = await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'capture-fails' });
    assert.equal(failed.result.isError, true);
    assert.equal(textBlock(failed).error, 'draft_failed_after_paste');
    assert.equal(textBlock(failed).input_may_have_residual_draft, true);
    captureThrowsAfterPaste = false;

    // Audit lines never carry draft text or the digest
    const logs = srv.logs.join('\n');
    for (const secret of ['for chat A only', 'second', 'capture-fails', chatA.headerDigest]) assert.ok(!logs.includes(secret));
    assert.ok(logs.includes('"error":"session_header_mismatch"'));
    assert.ok(logs.includes('"error":"input_timeout"'));
  } finally {
    await srv.close();
  }
});

test('confirm holds the instance input lock across verify + Return + post-send check', async () => {
  const baseFp = makeTestFingerprint();
  const blinkFp = makeTestFingerprint({ editorGray: (() => { const b = Buffer.from(baseFp.editorGray); b[5] = 1; return b; })() });
  const emptyFp = makeTestFingerprint({ editorGray: emptyEditorGray() });
  const held = new Set<string>();
  const events: string[] = [];
  let queue: SessionFingerprint[] = [];
  let duringSleep: (() => Promise<void>) | null = null;
  const withInputLock = async <T,>(inst: Instance, op: () => Promise<T>): Promise<T> => {
    if (held.has(inst.id)) throw Object.assign(new Error('该实例正在处理输入，请稍后再试'), { statusCode: 409 });
    held.add(inst.id);
    try {
      return await op();
    } finally {
      held.delete(inst.id);
    }
  };

  const srv = await buildMockMcpServer({
    allowWrite: true,
    rateLimits: { writeMaxPerWindow: 200, sendMaxPerWindow: 50, sendMinIntervalMs: 0 },
    activeVncViewerCount: () => 0,
    getControlLock: () => ({ active: false, holder: null, ageMs: null }),
    withInputLock,
    sleep: async () => {
      const hook = duringSleep;
      duringSleep = null;
      if (hook) await hook();
    },
    pasteDraftInInstance: async (inst) => {
      events.push(`paste lock=${held.has(inst.id)}`);
    },
    clickInInstance: async (inst, opts) => {
      events.push(`click ${opts.x},${opts.y} lock=${held.has(inst.id)}`);
      return { displayWidth: 1836, displayHeight: 884 };
    },
    sendReturnInInstance: async (inst) => {
      events.push(`return lock=${held.has(inst.id)}`);
    },
    captureSessionFingerprint: async (inst) => {
      events.push(`capture lock=${held.has(inst.id)}`);
      return queue.shift() ?? baseFp;
    },
  });
  let nextId = 1;
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    });
    return JSON.parse(res.body);
  };

  try {
    queue = [baseFp, baseFp];
    const draft = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'locked' }));
    assert.ok(draft.draft_id);
    // Pre-check, paste and post-paste capture all ran inside one lock.
    assert.deepEqual(events, ['capture lock=true', 'paste lock=true', 'capture lock=true']);
    assert.equal(held.size, 0);

    // While confirm waits between samples, another client tries to click: it is refused, nothing is dispatched.
    events.length = 0;
    let concurrentClick: any;
    duringSleep = async () => {
      concurrentClick = textBlock(
        await call('woc_click', { instance_id: RUNNING_INST.id, x: 200, y: 444, display_width: 1836, display_height: 884 }),
      );
    };
    queue = [blinkFp, baseFp, emptyFp, emptyFp, emptyFp];
    const confirmed = textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: draft.draft_id }));
    assert.equal(concurrentClick.error, 'input_busy');
    assert.equal(concurrentClick.dispatched, 'no');
    assert.equal(confirmed.sent, true);
    assert.equal(confirmed.send_verified, true);
    assert.equal(confirmed.samples_taken, 2);
    assert.deepEqual(events, [
      'capture lock=true',
      'capture lock=true',
      'return lock=true',
      'capture lock=true',
      'capture lock=true',
      'capture lock=true',
    ]);
    assert.equal(held.size, 0);

    // A confirm that arrives while the lock is taken presses nothing and reports input_busy
    queue = [baseFp, baseFp];
    const draft2 = textBlock(await call('woc_draft_reply', { instance_id: RUNNING_INST.id, text: 'busy' }));
    events.length = 0;
    held.add(RUNNING_INST.id);
    const busyConfirm = textBlock(await call('woc_confirm_send', { instance_id: RUNNING_INST.id, draft_id: draft2.draft_id }));
    held.delete(RUNNING_INST.id);
    assert.equal(busyConfirm.error, 'input_busy');
    assert.equal(busyConfirm.sent, false);
    assert.equal(busyConfirm.input_may_have_residual_draft, true);
    assert.deepEqual(events, []);
  } finally {
    await srv.close();
  }
});

test('MCP_EDITOR_MAX_DIFF_PIXELS parsing accepts only a bounded non-negative integer', () => {
  assert.equal(parseEditorMaxDiffEnv(undefined), undefined);
  assert.equal(parseEditorMaxDiffEnv('  '), undefined);
  assert.equal(parseEditorMaxDiffEnv('0'), 0);
  assert.equal(parseEditorMaxDiffEnv(' 12 '), 12);
  for (const bad of ['-1', '4.5', 'abc', '1e3', '100001', '9999999']) assert.equal(parseEditorMaxDiffEnv(bad), 'invalid');
});

test('real panel boot: MCP_ALLOW_WRITE=1 exposes 13 tools including woc_session_header, woc_confirm_send and woc_discard_draft', { timeout: 20000 }, async () => {
  await withBootedPanel({ MCP_AUTH_TOKEN: TEST_TOKEN, MCP_ALLOW_WRITE: '1' }, async (url) => {
    const listRes = await rawHttp(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers['cache-control'], 'no-store, max-age=0');
    const tools = JSON.parse(listRes.body).result.tools;
    assert.equal(tools.length, 13);
    const confirmTool = tools.find((t: any) => t.name === 'woc_confirm_send');
    const discardTool = tools.find((t: any) => t.name === 'woc_discard_draft');
    const headerTool = tools.find((t: any) => t.name === 'woc_session_header');
    assert.ok(confirmTool);
    assert.ok(discardTool);
    assert.equal(headerTool.annotations?.readOnlyHint, true);
    assert.equal(confirmTool.annotations?.destructiveHint, true);
    assert.equal(discardTool.annotations?.idempotentHint, true);
  });
});

// ---------- JSON-RPC layer (no SDK): the subset of Streamable HTTP this endpoint speaks ----------

test('JSON-RPC layer: version negotiation, notifications, ping, and protocol errors', async () => {
  const srv = await buildMockMcpServer();
  const post = (body: unknown) =>
    rawHttp(`${srv.url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    // A supported requested revision is echoed; an unknown one is answered with the newest supported revision
    for (const [requested, expected] of [
      ['2025-06-18', '2025-06-18'],
      ['2024-11-05', '2024-11-05'],
      ['1999-01-01', '2025-11-25'],
      [undefined, '2025-11-25'],
    ] as const) {
      const res = await post({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type']), /application\/json/);
      const body = JSON.parse(res.body);
      assert.equal(body.id, 'init-1'); // string ids are echoed verbatim
      assert.equal(body.result.protocolVersion, expected);
      assert.deepEqual(body.result.capabilities, { tools: {} });
      assert.deepEqual(body.result.serverInfo, { name: 'woc-panel-mcp', version: 'v9.9.9-test' });
      assert.match(body.result.instructions, /Read-only MCP server/);
    }

    // Notifications and client responses are accepted without a body
    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notified.status, 202);
    assert.equal(notified.body, '');
    assert.equal((await post({ jsonrpc: '2.0', id: 7, result: {} })).status, 202);

    // ping
    assert.deepEqual(JSON.parse((await post({ jsonrpc: '2.0', id: 2, method: 'ping' })).body), { jsonrpc: '2.0', id: 2, result: {} });

    // Unknown method / bad params are JSON-RPC errors on HTTP 200
    const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(unknown.status, 200);
    assert.equal(JSON.parse(unknown.body).error.code, -32601);
    assert.equal(JSON.parse(unknown.body).id, 3);
    const noName = JSON.parse((await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: {} } })).body);
    assert.equal(noName.error.code, -32602);

    // Malformed envelopes are rejected before any tool code runs
    const noVersion = await post({ id: 5, method: 'tools/list' });
    assert.equal(noVersion.status, 400);
    assert.equal(JSON.parse(noVersion.body).error.code, -32600);
    assert.equal((await post({ jsonrpc: '2.0', id: 6 })).status, 400);
    assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).status, 400); // batches are not supported
    assert.equal((await post('{not json')).status, 400);
    const big = await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'woc_health', arguments: { pad: 'x'.repeat(300 * 1024) } } });
    assert.equal(big.status, 413);
    assert.deepEqual(srv.called, []);
  } finally {
    await srv.close();
  }
});

test('chat tools refuse non-WeChat instances with unsupported_app; click/scroll stay generic', async () => {
  const BROWSER_INST: Instance = { ...RUNNING_INST, id: 'c0ffee1234', name: 'Browser', appType: 'chromium', containerName: 'woc-wx-c0ffee1234' };
  const dispatched: string[] = [];
  const srv = await buildMockMcpServer({
    allowWrite: true,
    listInstances: () => [BROWSER_INST],
    findInstance: (id) => (id === BROWSER_INST.id ? BROWSER_INST : undefined),
    instanceRuntime: async () => 'running',
    activeVncViewerCount: () => 0,
    getControlLock: () => ({ active: false, holder: null, ageMs: null }),
    wechatWindowInfo: async () => ({ display: ':1', displayWidth: 1280, displayHeight: 720, wechatWindow: null }),
    clickInInstance: async () => { dispatched.push('click'); return { displayWidth: 1280, displayHeight: 720 }; },
    scrollInInstance: async () => { dispatched.push('scroll'); return { displayWidth: 1280, displayHeight: 720 }; },
    pasteDraftInInstance: async () => { dispatched.push('paste'); },
    clearInputInInstance: async () => { dispatched.push('clear'); },
    sendReturnInInstance: async () => { dispatched.push('return'); },
    captureSessionFingerprint: async () => { dispatched.push('capture'); return makeTestFingerprint(); },
  });
  let nextId = 1;
  const call = async (name: string, args: Record<string, unknown>) =>
    textBlock(JSON.parse((await rawHttp(`${srv.url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    })).body));
  try {
    for (const [name, args] of [
      ['woc_session_header', {}],
      ['woc_draft_reply', { text: 'hello' }],
      ['woc_discard_draft', {}],
    ] as const) {
      const res = await call(name, { instance_id: BROWSER_INST.id, ...args });
      assert.equal(res.error, 'unsupported_app', name);
      assert.equal(res.app_type, 'chromium');
    }
    assert.deepEqual(dispatched, []);
    const dims = { display_width: 1280, display_height: 720 };
    assert.equal((await call('woc_click', { instance_id: BROWSER_INST.id, x: 1200, y: 700, ...dims })).ok, true); // no WeChat window -> no send-button zone
    assert.equal((await call('woc_scroll', { instance_id: BROWSER_INST.id, x: 600, y: 300, ...dims, direction: 'down' })).ok, true);
    assert.deepEqual(dispatched, ['click', 'scroll']);
    assert.ok(srv.logs.some((l) => l.includes('"error":"unsupported_app"')));
  } finally {
    await srv.close();
  }
});
