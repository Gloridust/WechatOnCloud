import type { AuthProvider, User, Instance } from './types.js';

/**
 * Keycloak-specific role synchronization extension.
 * If Keycloak Admin API is configured, automatically sync instance roles.
 * For non-Keycloak IdP, this is a no-op.
 */

const KC_ADMIN_URL = process.env.WOC_KEYCLOAK_ADMIN_URL || '';
const KC_REALM = process.env.WOC_KEYCLOAK_REALM || '';
const KC_ADMIN_USER = process.env.WOC_KEYCLOAK_ADMIN_USER || '';
const KC_ADMIN_PASS = process.env.WOC_KEYCLOAK_ADMIN_PASS || '';
const KC_CLIENT_ID = process.env.WOC_OIDC_CLIENT_ID || '';

interface TokenResponse {
  access_token: string;
}

export class KeycloakRoleSync {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  get enabled(): boolean {
    return !!(KC_ADMIN_URL && KC_REALM && KC_ADMIN_USER && KC_ADMIN_PASS && KC_CLIENT_ID);
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await this.refreshToken();
    console.log('[kc-sync] Keycloak role sync initialized');
  }

  private async refreshToken(): Promise<void> {
    const url = `${KC_ADMIN_URL}/realms/master/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      username: KC_ADMIN_USER,
      password: KC_ADMIN_PASS,
      grant_type: 'password',
      client_id: 'admin-cli',
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(`Keycloak auth failed: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json() as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + 55 * 60 * 1000; // refresh 5 min before expiry
  }

  private async api(method: string, path: string, body?: any): Promise<any> {
    if (!this.enabled) return null;
    if (Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }

    const url = `${KC_ADMIN_URL}/admin/realms/${KC_REALM}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 204 || resp.status === 201) {
      return resp.status === 201 ? await resp.json().catch(() => null) : null;
    }
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[kc-sync] API error ${resp.status}: ${text}`);
      throw new Error(`Keycloak API error: ${resp.status}`);
    }
    return resp.json().catch(() => null);
  }

  private async getClientUuid(): Promise<string | null> {
    const clients = await this.api('GET', `/clients?clientId=${encodeURIComponent(KC_CLIENT_ID)}`);
    if (Array.isArray(clients) && clients.length > 0) {
      return clients[0].id;
    }
    return null;
  }

  async onInstanceCreated(instance: Instance): Promise<void> {
    if (!this.enabled) return;
    try {
      const clientUuid = await this.getClientUuid();
      if (!clientUuid) return;

      const roleName = `woc:instance:${instance.id}`;
      await this.api('POST', `/clients/${clientUuid}/roles`, {
        name: roleName,
        description: `Access to WechatOnCloud instance ${instance.name} (${instance.id})`,
        clientRole: true,
      });
      console.log(`[kc-sync] Created role ${roleName} for instance ${instance.id}`);
    } catch (e: any) {
      console.error(`[kc-sync] Failed to create role for instance ${instance.id}:`, e.message);
    }
  }

  async onInstanceDeleted(instanceId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const clientUuid = await this.getClientUuid();
      if (!clientUuid) return;

      const roleName = `woc:instance:${instanceId}`;
      await this.api('DELETE', `/clients/${clientUuid}/roles/${encodeURIComponent(roleName)}`);
      console.log(`[kc-sync] Deleted role ${roleName} for instance ${instanceId}`);
    } catch (e: any) {
      console.error(`[kc-sync] Failed to delete role for instance ${instanceId}:`, e.message);
    }
  }

  async syncInstanceRoles(instanceId: string, userIds: string[]): Promise<void> {
    // For Keycloak, instance roles can be assigned to users
    // This is an advanced feature - for now we keep local permissions as source of truth
    // and use Keycloak roles only for high-level access control
    if (!this.enabled) return;
  }
}
