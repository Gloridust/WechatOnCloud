import { describe, it, expect } from 'vitest';

async function loadSessions() {
  return import('./sessions.js');
}

describe('Sessions', () => {
  it('createSession: generates token and stores session', async () => {
    const { createSession, getSession } = await loadSessions();
    const token = createSession('user-123');
    expect(token).toBeDefined();
    expect(token.length).toBe(64); // 32 bytes hex = 64 chars

    const session = getSession(token);
    expect(session).toBeDefined();
    expect(session!.userId).toBe('user-123');
    expect(session!.expires).toBeGreaterThan(Date.now());
  });

  it('getSession: returns null for invalid token', async () => {
    const { getSession } = await loadSessions();
    expect(getSession('invalid-token')).toBeNull();
    expect(getSession('')).toBeNull();
    expect(getSession(undefined)).toBeNull();
  });

  it('destroySession: removes session', async () => {
    const { createSession, getSession, destroySession } = await loadSessions();
    const token = createSession('user-123');
    destroySession(token);
    expect(getSession(token)).toBeNull();
  });

  it('destroyUserSessions: removes all sessions for user', async () => {
    const { createSession, getSession, destroyUserSessions } = await loadSessions();
    const token1 = createSession('user-123');
    const token2 = createSession('user-123');
    const token3 = createSession('user-456');

    destroyUserSessions('user-123');

    expect(getSession(token1)).toBeNull();
    expect(getSession(token2)).toBeNull();
    expect(getSession(token3)).toBeDefined();
  });
});
