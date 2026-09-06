import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

type PortalUser = { id: number; userId: number; username: string };
type UserRecord = { id: number | bigint; username: string };
type PortalSsoDependencies = {
  environment: NodeJS.ProcessEnv;
  users: {
    first(): UserRecord | undefined;
    hasUsers(): boolean;
    create(username: string, unusablePasswordHash: string): UserRecord;
    completeOnboarding(id: number): void;
  };
  clock?: () => number;
};

const trustedUser = Symbol('codey-verified-portal-user');
type PortalRequest = IncomingMessage & { [trustedUser]?: PortalUser };

/**
 * Used by Auth composition and its tests. It accepts only short-lived,
 * request-bound assertions from this node's Codey gateway key. A local JWT,
 * API key, cookie, platform flag or client-supplied user header is not a fallback.
 */
export function createPortalSsoService(dependencies: PortalSsoDependencies) {
  const { environment, users } = dependencies;
  const enabled = environment.CODEY_PORTAL_SSO === 'true';
  const nodeId = environment.CODEY_PORTAL_NODE_ID ?? '';
  const expectedUser = environment.CODEY_PORTAL_USERNAME ?? '';
  const expectedSubject = environment.CODEY_PORTAL_PRINCIPAL_ID ?? '';
  const encodedKey = environment.CODEY_PORTAL_SSO_KEY ?? '';
  const clock = dependencies.clock ?? Date.now;
  if (enabled && (
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(nodeId) ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(expectedUser) ||
    !/^[a-z0-9-]{1,80}$/.test(expectedSubject) ||
    !/^[A-Za-z0-9_-]{43}$/.test(encodedKey)
  )) {
    throw new Error('Codey portal SSO requires a node key and explicit user binding');
  }
  const key = Buffer.from(encodedKey, 'base64url');
  const nonces = new Map<string, number>();

  function authenticate(request: IncomingMessage): PortalUser | null {
    if (!enabled) return null;
    try {
      const header = request.headers['x-codey-workspace-assertion'];
      if (typeof header !== 'string' || header.length > 4096) return null;
      const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(header);
      if (!parts) return null;
      const actual = Buffer.from(parts[2], 'base64url');
      const signature = createHmac('sha256', key).update(parts[1]).digest();
      if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) return null;
      const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      const now = Math.floor(clock() / 1000);
      if (value.iss !== 'codey-portal' || value.aud !== nodeId ||
          value.sub !== expectedSubject || value.username !== expectedUser ||
          value.method !== request.method || value.path !== request.url ||
          typeof value.sid !== 'string' || !/^[a-f0-9]{64}$/.test(value.sid) ||
          typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce) ||
          !Number.isInteger(value.iat) || !Number.isInteger(value.exp) ||
          Number(value.iat) > now + 5 || Number(value.exp) <= now ||
          Number(value.exp) <= Number(value.iat) || Number(value.exp) - Number(value.iat) > 20) return null;
      for (const [nonce, expiry] of nonces) {
        if (expiry <= now) nonces.delete(nonce);
      }
      if (nonces.has(value.nonce) || nonces.size >= 25000) return null;
      nonces.set(value.nonce, Number(value.exp));

      // Preserve A100's existing user ID, account and project/session ownership.
      // Empty nodes receive a non-password-login identity only after a valid
      // gateway assertion. No A100 database or password is copied to another VM.
      let user = users.first();
      if (!user) {
        if (users.hasUsers()) return null; // Do not revive a disabled account.
        user = users.create(expectedUser, `!codey-sso-only:${randomBytes(32).toString('hex')}`);
        users.completeOnboarding(Number(user.id));
      }
      const result = Object.freeze({ id: Number(user.id), userId: Number(user.id), username: expectedUser });
      (request as PortalRequest)[trustedUser] = result;
      return result;
    } catch {
      return null;
    }
  }

  return {
    enabled,
    authenticate,
    // Only the global middleware can populate this unforgeable in-process mark.
    authenticatedUser: (request: IncomingMessage): PortalUser | null =>
      (request as PortalRequest)[trustedUser] ?? null,
  };
}
