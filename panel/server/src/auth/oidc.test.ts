import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

const TEST_DATA_DIR = '/tmp/woc-test-data-oidc';
const TEST_FILE = `${TEST_DATA_DIR}/accounts.json`;
process.env.PANEL_DATA = TEST_FILE;

beforeEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

async function loadOIDC() {
  return import('./oidc.js');
}

describe('OIDC Role Parsing', () => {
  it('should extract roles from nested claim path', async () => {
    const { OIDCAuthProvider } = await loadOIDC();
    const provider = new OIDCAuthProvider();

    const claims = {
      sub: 'user-123',
      name: 'Test User',
      resource_access: {
        'woc-panel': {
          roles: ['woc:admin', 'woc:user']
        }
      }
    };

    const roles = (provider as any)._extractRoles(claims, 'resource_access.woc-panel.roles');
    expect(roles).toContain('woc:admin');
    expect(roles).toContain('woc:user');
  });

  it('should handle flat roles claim', async () => {
    const { OIDCAuthProvider } = await loadOIDC();
    const provider = new OIDCAuthProvider();

    const claims = {
      sub: 'user-123',
      groups: ['admin', 'user']
    };

    const roles = (provider as any)._extractRoles(claims, 'groups');
    expect(roles).toContain('admin');
    expect(roles).toContain('user');
  });

  it('should handle missing claim path gracefully', async () => {
    const { OIDCAuthProvider } = await loadOIDC();
    const provider = new OIDCAuthProvider();

    const claims = { sub: 'user-123' };
    const roles = (provider as any)._extractRoles(claims, 'resource_access.missing.roles');
    expect(roles).toEqual([]);
  });

  it('should handle single string role', async () => {
    const { OIDCAuthProvider } = await loadOIDC();
    const provider = new OIDCAuthProvider();

    const claims = { sub: 'user-123', role: 'admin' };
    const roles = (provider as any)._extractRoles(claims, 'role');
    expect(roles).toEqual(['admin']);
  });
});

describe('OIDC User Type Support', () => {
  it('User type should support OIDC fields', async () => {
    const { initStore, createSub, listRawUsers } = await import('../store.js');
    initStore();
    const pub = createSub('testuser', 'password123', [], { displayName: 'Test', oidcSub: 'oidc-123' });
    expect(pub.displayName).toBe('Test');
    const raw = listRawUsers().find(u => u.username === 'testuser');
    expect(raw?.oidcSub).toBe('oidc-123');
  });
});
