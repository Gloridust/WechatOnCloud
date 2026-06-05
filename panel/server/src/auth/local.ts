import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AuthProvider, User, Role } from './types.js';
import {
  listRawUsers,
  findByUsername,
  findById,
  verifyPassword,
  publicUser,
  userInstances,
  userCanAccess as storeUserCanAccess,
  createSub,
  type User as StoreUser,
} from '../store.js';
import { createSession, getSession, destroySession } from '../sessions.js';

const COOKIE = 'woc_sess';

export class LocalAuthProvider implements AuthProvider {
  async init(): Promise<void> {
    // Nothing to init for local auth
  }

  async login(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    const { username, password } = (req.body as any) ?? {};
    const u = username ? findByUsername(username) : undefined;
    if (!u || u.disabled || !verifyPassword(u, password ?? '')) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const token = createSession(u.id);
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return { user: publicUser(u) };
  }

  async callback(_req: FastifyRequest, reply: FastifyReply): Promise<any> {
    return reply.code(400).send({ error: 'Local auth does not support OAuth callback' });
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    destroySession(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { secure: true, path: '/' });
    return { ok: true };
  }

  async currentUser(req: FastifyRequest): Promise<User | null> {
    const token = req.cookies?.[COOKIE];
    const s = getSession(token);
    if (!s) return null;
    const u = findById(s.userId);
    if (!u || u.disabled) return null;
    return this._toUser(u);
  }

  async requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const u = await this.currentUser(req);
    if (!u) {
      reply.code(401).send({ error: '未登录' });
      return null;
    }
    return u;
  }

  async requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const u = await this.requireAuth(req, reply);
    if (!u) return null;
    if (u.role !== 'admin') {
      reply.code(403).send({ error: '需要管理员权限' });
      return null;
    }
    return u;
  }

  userCanAccess(user: User, instanceId: string): boolean {
    const u = findById(user.id);
    if (!u) return false;
    return storeUserCanAccess(u, instanceId);
  }

  listUsers(): User[] {
    return listRawUsers().map((u) => this._toUser(u));
  }

  async ensureUser(opts: { sub: string; username: string; email?: string; roles?: string[] }): Promise<User> {
    // For local auth, sub is treated as username
    let u = findByUsername(opts.sub);
    if (!u) {
      // Auto-provision as sub user with random password
      const randomPw = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      u = createSub(opts.sub, randomPw, []);
    }
    if (!u) throw new Error('User not found');
    return this._toUser(u);
  }

  private _toUser(u: StoreUser): User {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
      oidcSub: undefined,
      oidcIssuer: undefined,
      disabled: u.disabled,
      createdAt: u.createdAt,
    };
  }
}
