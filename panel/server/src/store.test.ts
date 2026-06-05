import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

const TEST_DATA_DIR = '/tmp/woc-test-data';
const TEST_FILE = `${TEST_DATA_DIR}/accounts.json`;
process.env.PANEL_DATA = TEST_FILE;

beforeEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

async function loadStore() {
  return import('./store.js');
}

describe('Store — User Management', () => {
  it('initStore: creates default admin', async () => {
    const { initStore, listRawUsers } = await loadStore();
    initStore();
    const users = listRawUsers();
    expect(users.length).toBe(1);
    expect(users[0].username).toBe('admin');
    expect(users[0].role).toBe('admin');
  });

  it('initStore: idempotent re-init', async () => {
    const { initStore, listRawUsers } = await loadStore();
    initStore();
    initStore();
    expect(listRawUsers().length).toBe(1);
  });

  it('createSub: creates user with hashed password', async () => {
    const { initStore, createSub, listRawUsers } = await loadStore();
    initStore();
    const pub = createSub('testuser', 'password123', []);
    expect(pub.username).toBe('testuser');
    expect(pub.role).toBe('sub');
    const raw = listRawUsers().find(u => u.username === 'testuser');
    expect(raw?.passwordHash).toBeDefined();
    expect(raw?.passwordHash!.length).toBeGreaterThan(0);
  });

  it('createSub: rejects duplicate username', async () => {
    const { initStore, createSub } = await loadStore();
    initStore();
    createSub('testuser', 'password123', []);
    expect(() => createSub('testuser', 'password456', [])).toThrow('用户名已存在');
  });

  it('verifyPassword: correct and incorrect', async () => {
    const { initStore, createSub, verifyPassword, findByUsername } = await loadStore();
    initStore();
    createSub('testuser', 'password123', []);
    const user = findByUsername('testuser')!;
    expect(verifyPassword(user, 'password123')).toBe(true);
    expect(verifyPassword(user, 'wrong')).toBe(false);
  });

  it('persist: writes to disk', async () => {
    const { initStore, createSub, persist } = await loadStore();
    initStore();
    createSub('testuser', 'password123', []);
    persist();
    expect(existsSync(TEST_FILE)).toBe(true);
    const data = JSON.parse(readFileSync(TEST_FILE, 'utf-8'));
    expect(data.users.length).toBe(2);
  });

  it('createSub: extra fields (displayName, oidcSub)', async () => {
    const { initStore, createSub, listRawUsers } = await loadStore();
    initStore();
    createSub('testuser', 'password123', [], { displayName: 'Test User', oidcSub: 'oidc-123' });
    const raw = listRawUsers().find(u => u.username === 'testuser');
    expect(raw?.displayName).toBe('Test User');
    expect(raw?.oidcSub).toBe('oidc-123');
  });

  it('listUsers: returns publicUser (no passwordHash)', async () => {
    const { initStore, createSub, listUsers } = await loadStore();
    initStore();
    createSub('testuser', 'password123', []);
    const users = listUsers();
    expect(users.length).toBe(2);
    expect(users[0].passwordHash).toBeUndefined();
    expect(users[1].passwordHash).toBeUndefined();
  });

  it('listRawUsers: returns full objects with passwordHash', async () => {
    const { initStore, createSub, listRawUsers } = await loadStore();
    initStore();
    createSub('testuser', 'password123', []);
    const users = listRawUsers();
    expect(users.length).toBe(2);
    expect(users[1].passwordHash).toBeDefined();
  });

  it('resetPassword: changes password by id', async () => {
    const { initStore, createSub, resetPassword, verifyPassword, findByUsername } = await loadStore();
    initStore();
    const pub = createSub('testuser', 'password123', []);
    resetPassword(pub.id, 'newpassword456');
    const user = findByUsername('testuser')!;
    expect(verifyPassword(user, 'newpassword456')).toBe(true);
    expect(verifyPassword(user, 'password123')).toBe(false);
  });

  it('setDisabled: toggles by id', async () => {
    const { initStore, createSub, setDisabled, findByUsername } = await loadStore();
    initStore();
    const pub = createSub('testuser', 'password123', []);
    setDisabled(pub.id, true);
    expect(findByUsername('testuser')!.disabled).toBe(true);
    setDisabled(pub.id, false);
    expect(findByUsername('testuser')!.disabled).toBe(false);
  });

  it('deleteUser: removes by id', async () => {
    const { initStore, createSub, deleteUser, findByUsername } = await loadStore();
    initStore();
    const pub = createSub('testuser', 'password123', []);
    deleteUser(pub.id);
    expect(findByUsername('testuser')).toBeUndefined();
  });

  it('setUserInstances: updates allowedInstances with valid ids', async () => {
    const { initStore, createInstance, createSub, setUserInstances, findByUsername, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst1 = createInstance('Inst1', admin.id, []);
    const inst2 = createInstance('Inst2', admin.id, []);
    const pub = createSub('testuser', 'password123', []);
    setUserInstances(pub.id, [inst1.id, inst2.id]);
    expect(findByUsername('testuser')!.allowedInstances).toEqual([inst1.id, inst2.id]);
  });

  it('publicUser: displayName fallback to username', async () => {
    const { initStore, createSub } = await loadStore();
    initStore();
    const withDisplay = createSub('user1', 'password123', [], { displayName: 'Custom Name' });
    expect(withDisplay.displayName).toBe('Custom Name');
    const withoutDisplay = createSub('user2', 'password123', []);
    expect(withoutDisplay.displayName).toBe('user2');
  });

  it('deleteUser: prevents deleting admin', async () => {
    const { initStore, listRawUsers, deleteUser } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    expect(() => deleteUser(admin.id)).toThrow('不能删除管理员');
  });

  it('setDisabled: prevents disabling admin', async () => {
    const { initStore, listRawUsers, setDisabled } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    expect(() => setDisabled(admin.id, true)).toThrow('不能禁用管理员');
  });
});

describe('Store — Instance Management', () => {
  it('createInstance: generates credentials and createdBy', async () => {
    const { initStore, createInstance, findInstance, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('Test Instance', admin.id, []);
    expect(inst.name).toBe('Test Instance');
    expect(inst.kasmUser).toBeDefined();
    expect(inst.kasmPassword).toBeDefined();
    expect(inst.createdBy).toBe(admin.id);
    expect(inst.containerName).toBe(`woc-wx-${inst.id}`);
    expect(findInstance(inst.id)).toBeDefined();
  });

  it('listInstances: returns all instances', async () => {
    const { initStore, createInstance, listInstances, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    createInstance('Inst1', admin.id, []);
    createInstance('Inst2', admin.id, []);
    expect(listInstances().length).toBe(2);
  });

  it('renameInstance: updates name', async () => {
    const { initStore, createInstance, renameInstance, findInstance, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('Old', admin.id, []);
    renameInstance(inst.id, 'New');
    expect(findInstance(inst.id)!.name).toBe('New');
  });

  it('renameInstance: rejects invalid names', async () => {
    const { initStore, createInstance, renameInstance, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('Test', admin.id, []);
    expect(() => renameInstance(inst.id, '')).toThrow();
    expect(() => renameInstance(inst.id, 'a'.repeat(31))).toThrow();
  });

  it('removeInstance: deletes and cleans up permissions', async () => {
    const { initStore, createInstance, createSub, removeInstance, findInstance, findByUsername, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('To Delete', admin.id, []);
    createSub('subuser', 'password', [inst.id]);
    removeInstance(inst.id);
    expect(findInstance(inst.id)).toBeUndefined();
    expect(findByUsername('subuser')!.allowedInstances).not.toContain(inst.id);
  });

  it('setInstanceUsers: updates user permissions', async () => {
    const { initStore, createInstance, createSub, setInstanceUsers, findByUsername, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('Test', admin.id, []);
    const sub = createSub('subuser', 'password', []);
    setInstanceUsers(inst.id, [sub.id]);
    expect(findByUsername('subuser')!.allowedInstances).toContain(inst.id);
  });

  it('userCanAccess: admin sees all, sub sees allowed', async () => {
    const { initStore, createInstance, createSub, userCanAccess, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('Test', admin.id, []);
    const sub = createSub('subuser', 'password', [inst.id]);
    expect(userCanAccess(admin, inst.id)).toBe(true);
    expect(userCanAccess(sub, inst.id)).toBe(true);
    const noAccess = createSub('noaccess', 'password', []);
    expect(userCanAccess(noAccess, inst.id)).toBe(false);
    expect(userCanAccess(noAccess, 'nonexistent')).toBe(false);
  });

  it('userInstances: admin=all, sub=filtered', async () => {
    const { initStore, createInstance, createSub, userInstances, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    createInstance('I1', admin.id, []);
    createInstance('I2', admin.id, []);
    const sub = createSub('subuser', 'password', []);
    expect(userInstances(admin).length).toBe(2);
    expect(userInstances(sub).length).toBe(0);
  });

  it('createInstance: default name when empty', async () => {
    const { initStore, createInstance, listRawUsers } = await loadStore();
    initStore();
    const admin = listRawUsers()[0];
    const inst = createInstance('  ', admin.id, []);
    expect(inst.name).toMatch(/^微信-/);
  });
});
