import type { FastifyRequest, FastifyReply } from 'fastify';

export type Role = 'admin' | 'sub';

export interface User {
  disabled: boolean;
  createdAt: string;
  id: string;
  username: string;
  role: Role;
  allowedInstances: string[];
  displayName?: string;
  oidcSub?: string;
  oidcIssuer?: string;
}

export interface AuthProvider {
  /** Initialize the provider (e.g. discover OIDC endpoints) */
  init(): Promise<void>;

  /** Handle login request */
  login(req: FastifyRequest, reply: FastifyReply): Promise<any>;

  /** Handle OAuth/OIDC callback */
  callback(req: FastifyRequest, reply: FastifyReply): Promise<any>;

  /** Handle logout */
  logout(req: FastifyRequest, reply: FastifyReply): Promise<any>;

  /** Get current user from request */
  currentUser(req: FastifyRequest): Promise<User | null>;

  /** Require authenticated user */
  requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<User | null>;

  /** Require admin user */
  requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | null>;

  /** Check if user can access instance */
  userCanAccess(user: User, instanceId: string): boolean;

  /** List users (for admin) */
  listUsers(): User[];

  /** Create user (admin or auto-provision) */
  ensureUser(opts: { sub: string; username: string; email?: string; roles?: string[] }): Promise<User>;

  /** Hooks for instance lifecycle (optional) */
  onInstanceCreated?(instance: any): Promise<void>;
  onInstanceDeleted?(instanceId: string): Promise<void>;
}

export interface Instance {
  id: string;
  name: string;
  containerName: string;
  volumeName: string;
  kasmUser: string;
  kasmPassword: string;
  createdAt: string;
  createdBy: string;
}
