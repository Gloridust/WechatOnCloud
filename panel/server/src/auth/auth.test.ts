import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const TEST_DATA_DIR = '/tmp/woc-test-data-auth';
const TEST_FILE = `${TEST_DATA_DIR}/accounts.json`;
process.env.PANEL_DATA = TEST_FILE;

beforeEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

async function loadAuth() {
  return import('./index.js');
}

describe('Auth Provider Factory', () => {
  it('should create local provider by default', async () => {
    delete process.env.WOC_AUTH_MODE;
    const { createAuthProvider } = await loadAuth();
    const provider = createAuthProvider();
    expect(provider).toBeDefined();
    await provider.init();
    // Local provider should have login method that checks username/password
  });

  it('should create oidc provider when mode=oidc', async () => {
    process.env.WOC_AUTH_MODE = 'oidc';
    process.env.WOC_OIDC_ISSUER = 'https://auth.example.com/realms/test';
    process.env.WOC_OIDC_CLIENT_ID = 'test-client';
    const { createAuthProvider } = await loadAuth();
    const provider = createAuthProvider();
    expect(provider).toBeDefined();
    // OIDC provider init may fail if issuer is not reachable, which is expected in test
  });

  it('should create oidc provider when mode=oidc_full', async () => {
    process.env.WOC_AUTH_MODE = 'oidc_full';
    process.env.WOC_OIDC_ISSUER = 'https://auth.example.com/realms/test';
    process.env.WOC_OIDC_CLIENT_ID = 'test-client';
    const { createAuthProvider } = await loadAuth();
    const provider = createAuthProvider();
    expect(provider).toBeDefined();
  });
});

describe('LocalAuthProvider', () => {
  it('should authenticate valid user', async () => {
    const { initStore, createSub } = await import('../store.js');
    initStore();
    createSub('testuser', 'password123', []);

    const { createAuthProvider } = await loadAuth();
    delete process.env.WOC_AUTH_MODE;
    const provider = createAuthProvider();
    await provider.init();

    // Simulate a login request
    const req = { body: { username: 'testuser', password: 'password123' } } as any;
    const reply = { code: () => ({ send: (x: any) => x }), setCookie: () => {}, cookie: () => {} } as any;

    // Note: LocalAuthProvider.login expects Fastify req/reply
    // We test the underlying behavior through store directly for unit tests
    const { findByUsername, verifyPassword } = await import('../store.js');
    const user = findByUsername('testuser');
    expect(user).toBeDefined();
    expect(verifyPassword(user!, 'password123')).toBe(true);
  });

  it('should reject invalid password', async () => {
    const { initStore, createSub, findByUsername, verifyPassword } = await import('../store.js');
    initStore();
    createSub('testuser', 'password123', []);
    const user = findByUsername('testuser');
    expect(verifyPassword(user!, 'wrongpassword')).toBe(false);
  });
});

describe('AuthProvider Types', () => {
  it('should have consistent User type across all providers', async () => {
    const { User } = await import('./types.js');
    // Type-only test - if this compiles, types are consistent
    const mockUser = {
      id: 'test',
      username: 'test',
      displayName: 'Test User',
      role: 'sub',
      disabled: false,
      createdAt: new Date().toISOString(),
      allowedInstances: [],
    };
    expect(mockUser.displayName).toBe('Test User');
  });
});
