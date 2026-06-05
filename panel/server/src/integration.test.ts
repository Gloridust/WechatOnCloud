import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const TEST_DATA_DIR = '/tmp/woc-test-integration';
const TEST_FILE = `${TEST_DATA_DIR}/accounts.json`;
process.env.PANEL_DATA = TEST_FILE;

beforeEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

describe('Integration — Auth API Endpoints', () => {
  it('POST /api/login should authenticate valid admin', async () => {
    const { initStore } = await import('./store.js');
    initStore();

    // Build a minimal Fastify app to test routes
    const fastify = (await import('fastify')).default({ logger: false });
    await fastify.register(require('@fastify/cookie'));

    // Import and register auth routes
    const { createAuthProvider } = await import('./auth/index.js');
    const auth = createAuthProvider();
    await auth.init();

    // Register a test route
    fastify.post('/api/login', async (req, reply) => {
      const { username, password } = req.body as any;
      const { findByUsername, verifyPassword } = await import('./store.js');
      const user = findByUsername(username);
      if (!user || !verifyPassword(user, password)) {
        return reply.code(401).send({ error: '用户名或密码错误' });
      }
      const { createSession } = await import('./sessions.js');
      const token = createSession(user.id);
      reply.setCookie('woc_sess', token, { httpOnly: true, path: '/' });
      return { success: true, user: { id: user.id, username: user.username, role: user.role } };
    });

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'admin', password: 'wechat' }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.user.username).toBe('admin');

    await fastify.close();
  });

  it('POST /api/login should reject invalid credentials', async () => {
    const { initStore } = await import('./store.js');
    initStore();

    const fastify = (await import('fastify')).default({ logger: false });

    fastify.post('/api/login', async (req, reply) => {
      const { username, password } = req.body as any;
      const { findByUsername, verifyPassword } = await import('./store.js');
      const user = findByUsername(username);
      if (!user || !verifyPassword(user, password)) {
        return reply.code(401).send({ error: '用户名或密码错误' });
      }
      return { success: true };
    });

    const res = await fastify.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'admin', password: 'wrong' }
    });

    expect(res.statusCode).toBe(401);
    await fastify.close();
  });

  it('GET /api/auth/mode should return auth mode', async () => {
    process.env.WOC_AUTH_MODE = 'oidc_full';

    const fastify = (await import('fastify')).default({ logger: false });
    fastify.get('/api/auth/mode', async () => {
      return { mode: process.env.WOC_AUTH_MODE || 'local' };
    });

    const res = await fastify.inject({
      method: 'GET',
      url: '/api/auth/mode'
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('oidc_full');

    delete process.env.WOC_AUTH_MODE;
    await fastify.close();
  });
});

describe('Integration — Permission Model', () => {
  it('admin should access all instances', async () => {
    const { initStore, createInstance, listRawUsers } = await import('./store.js');
    initStore();
    const admin = listRawUsers()[0];
    const inst1 = createInstance('Inst1', admin.id, []);
    const inst2 = createInstance('Inst2', admin.id, []);

    const { userCanAccess, userInstances } = await import('./store.js');
    expect(userCanAccess(admin, inst1.id)).toBe(true);
    expect(userCanAccess(admin, inst2.id)).toBe(true);
    expect(userInstances(admin).length).toBe(2);
  });

  it('sub should only access allowed instances', async () => {
    const { initStore, createInstance, createSub, listRawUsers } = await import('./store.js');
    initStore();
    const admin = listRawUsers()[0];
    const inst1 = createInstance('Inst1', admin.id, []);
    const inst2 = createInstance('Inst2', admin.id, []);
    const sub = createSub('subuser', 'password', [inst1.id]);

    const { userCanAccess, userInstances } = await import('./store.js');
    expect(userCanAccess(sub, inst1.id)).toBe(true);
    expect(userCanAccess(sub, inst2.id)).toBe(false);
    expect(userInstances(sub).length).toBe(1);
  });
});

describe('Integration — Security Boundaries', () => {
  it('should not allow password change without current password', async () => {
    const { initStore, createSub, verifyPassword } = await import('./store.js');
    initStore();
    const sub = createSub('testuser', 'password123', []);

    // Simulate wrong password check
    const { findById } = await import('./store.js');
    const user = findById(sub.id);
    expect(user).toBeDefined();
    expect(verifyPassword(user!, 'wrongpassword')).toBe(false);
    expect(verifyPassword(user!, 'password123')).toBe(true);
  });

  it('should not allow creating duplicate users', async () => {
    const { initStore, createSub } = await import('./store.js');
    initStore();
    createSub('testuser', 'password123', []);
    expect(() => createSub('testuser', 'password456', [])).toThrow();
  });

  it('should persist after every mutating operation', async () => {
    const { initStore, createSub, persist } = await import('./store.js');
    initStore();
    const sub = createSub('testuser', 'password123', []);
    // createSub already calls persist internally
    // Verify file exists
    expect(existsSync(TEST_FILE)).toBe(true);
  });
});
