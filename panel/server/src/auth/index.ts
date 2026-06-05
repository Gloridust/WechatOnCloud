import type { AuthProvider } from './types.js';
import { LocalAuthProvider } from './local.js';
import { OIDCAuthProvider } from './oidc.js';

const MODE = process.env.WOC_AUTH_MODE || 'local';

export function createAuthProvider(): AuthProvider {
  switch (MODE) {
    case 'oidc':
    case 'oidc_full':
      return new OIDCAuthProvider();
    case 'local':
    default:
      return new LocalAuthProvider();
  }
}

export * from './types.js';
