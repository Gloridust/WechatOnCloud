import { randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { discovery, buildAuthorizationUrl, authorizationCodeGrant, randomState, randomNonce } from 'openid-client';
import type { AuthProvider, User, Role } from './types.js';
import {
  findByUsername,
  findById,
  listRawUsers as storeListUsers,
  publicUser,
  userCanAccess as storeUserCanAccess,
  createSub,
  setDisabled,
  persist,
  type User as StoreUser,
} from '../store.js';
import { createSession, destroySession, getSession } from '../sessions.js';
import { KeycloakRoleSync } from './oidc-keycloak.js';

const COOKIE = 'woc_sess';
const COOKIE_STATE = 'woc_oidc_state';
const COOKIE_NONCE = 'woc_oidc_nonce';

// Environment configuration
const ISSUER_URL = process.env.WOC_OIDC_ISSUER || '';
const CLIENT_ID = process.env.WOC_OIDC_CLIENT_ID || '';
const CLIENT_SECRET = process.env.WOC_OIDC_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.WOC_OIDC_REDIRECT_URI || '';
const ROLE_CLAIM = process.env.WOC_OIDC_ROLE_CLAIM || `resource_access.${CLIENT_ID}.roles`;
const ADMIN_ROLE = process.env.WOC_OIDC_ADMIN_ROLE || 'woc:admin';
const USER_ROLE = process.env.WOC_OIDC_USER_ROLE || 'woc:user';
const AUTO_PROVISION = process.env.WOC_OIDC_AUTO_PROVISION !== 'false';
const LOGOUT_REDIRECT_URI = process.env.WOC_OIDC_LOGOUT_REDIRECT_URI || '/login';

export class OIDCAuthProvider implements AuthProvider {
  private config: any = null;
  private kcSync = new KeycloakRoleSync();

  async init(): Promise<void> {
    if (!ISSUER_URL || !CLIENT_ID) {
      throw new Error('OIDC not configured: WOC_OIDC_ISSUER and WOC_OIDC_CLIENT_ID required');
    }
    this.config = await discovery(new URL(ISSUER_URL), CLIENT_ID, { client_secret: CLIENT_SECRET });
    console.log(`[oidc] Discovered issuer: ${this.config.issuer}`);
    await this.kcSync.init();
  }

  async login(_req: FastifyRequest, reply: FastifyReply): Promise<any> {
    if (!this.config) throw new Error('OIDC client not initialized');

    const state = randomState();
    const nonce = randomNonce();
    const url = buildAuthorizationUrl(this.config, {
      scope: 'openid profile email',
      redirect_uri: REDIRECT_URI || '',
      state,
      nonce,
    });

    reply.setCookie(COOKIE_STATE, state, { httpOnly: true,
      secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
    reply.setCookie(COOKIE_NONCE, nonce, { httpOnly: true,
      secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
    return reply.redirect(url.href);
  }

  async callback(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    if (!this.config) throw new Error('OIDC client not initialized');

    const state = req.cookies?.[COOKIE_STATE];
    const nonce = req.cookies?.[COOKIE_NONCE];
    reply.clearCookie(COOKIE_STATE, { secure: true, path: '/' });
    reply.clearCookie(COOKIE_NONCE, { secure: true, path: '/' });

    if (!state) {
      return reply.code(400).send({ error: 'Missing state cookie' });
    }

    try {
      const redirectBase = new URL(REDIRECT_URI || `${req.protocol}://${req.hostname}/`);
      const currentUrl = new URL(req.raw.url || '/', `${redirectBase.protocol}//${redirectBase.host}`);
      const tokens = await authorizationCodeGrant(this.config, currentUrl, {
        expectedState: state,
        expectedNonce: nonce,
      });

      const claims = tokens.claims();
      if (!claims) {
        return reply.code(400).send({ error: 'No claims in token' });
      }

      const roles = this._extractRoles(claims);
      const preferredUsername = String(claims.preferred_username || claims.name || claims.sub);
      const displayName = String(claims.name || claims.preferred_username || claims.sub);
      const email = claims.email;

      // Find or create local user mapping (by oidcSub or username)
      const claimsSub = String(claims.sub);
      let user = storeListUsers().find((u) => u.oidcSub === claimsSub);
      if (!user && AUTO_PROVISION) {
        user = findByUsername(`oidc:${claimsSub}`);
      }

      if (!user && AUTO_PROVISION) {
        const role: Role = roles.includes(ADMIN_ROLE) ? 'admin' : 'sub';
        const randomPw = randomBytes(32).toString('hex');
        user = createSub(`oidc:${claimsSub}`, randomPw, [], { displayName, oidcSub: claimsSub });
      }

      if (!user) {
        return reply.code(403).send({ error: '用户未授权，请联系管理员' });
      }

      // Update displayName on every login (in case it changed in IdP)
      let needsPersist = false;
      if (user.displayName !== displayName) {
        user.displayName = displayName;
        needsPersist = true;
      }
      if (user.oidcSub !== claimsSub) {
        user.oidcSub = claimsSub;
        needsPersist = true;
      }
      if (needsPersist) persist();

      // Sync role on every login
      const expectedRole: Role = roles.includes(ADMIN_ROLE) ? 'admin' : 'sub';
      if (user.role !== expectedRole) {
        user.role = expectedRole;
        persist();
        console.log(`[oidc] Role synced for ${user.username}: ${user.role} -> ${expectedRole}`);
      }

      const token = createSession(user.id);
      reply.setCookie(COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 12,
      });

      return reply.redirect('/');
    } catch (err: any) {
      console.error('[oidc] Callback error:', err);
      return reply.code(400).send({ error: 'OIDC authentication failed: ' + (err.message || err) });
    }
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    destroySession(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { secure: true, path: '/' });

    // Optionally redirect to OIDC logout endpoint
    if (this.config) {
      const endSession = this.config.serverMetadata().end_session_endpoint;
      if (endSession) {
        const url = new URL(endSession);
        url.searchParams.set('client_id', CLIENT_ID);
        url.searchParams.set('post_logout_redirect_uri', LOGOUT_REDIRECT_URI);
        return reply.redirect(url.href);
      }
    }
    return reply.redirect('/login');
  }

  async currentUser(req: FastifyRequest): Promise<User | null> {
    const token = req.cookies?.[COOKIE];
    // Static import used
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
    return storeListUsers().map((u) => this._toUser(u));
  }

  async ensureUser(opts: { sub: string; username: string; email?: string; roles?: string[] }): Promise<User> {
    let u = storeListUsers().find((x) => x.oidcSub === String(opts.sub));
    if (!u) {
      u = findByUsername(`oidc:${opts.sub}`);
    }
    if (!u && AUTO_PROVISION) {
      const randomPw = randomBytes(32).toString('hex');
      u = createSub(`oidc:${opts.sub}`, randomPw, [], { displayName: opts.username, oidcSub: opts.sub });
    }
    if (!u) throw new Error('User not found and auto-provision disabled');
    return this._toUser(u);
  }

  async onInstanceCreated(instance: any): Promise<void> {
    await this.kcSync.onInstanceCreated(instance);
  }

  async onInstanceDeleted(instanceId: string): Promise<void> {
    await this.kcSync.onInstanceDeleted(instanceId);
  }

  private _extractRoles(claims: any, claimPath?: string): string[] {
    if (!ROLE_CLAIM) return [];
    // Support dot-notation paths like "resource_access.my-client.roles"
    const path = claimPath || ROLE_CLAIM;
    const parts = path.split('.');
    let val = claims;
    for (const part of parts) {
      if (val && typeof val === 'object') {
        // Support template like "resource_access.${client_id}.roles"
        const key = part.includes('${client_id}') ? part.replace('${client_id}', CLIENT_ID) : part;
        val = val[key];
      } else {
        return [];
      }
    }
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [val];
    return [];
  }

  private _toUser(u: StoreUser): User {
    // Friendly display: prefer displayName, fallback to stripping 'oidc:' prefix
    const friendlyName = u.displayName || (u.username.startsWith('oidc:') ? u.username.slice(5) : u.username);
    return {
      id: u.id,
      username: friendlyName,
      role: u.role,
      allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
      displayName: u.displayName,
      oidcSub: u.oidcSub || (u.username.startsWith('oidc:') ? u.username.slice(5) : undefined),
      oidcIssuer: ISSUER_URL,
      disabled: u.disabled ?? false,
      createdAt: u.createdAt || new Date().toISOString(),
    };
  }
}
