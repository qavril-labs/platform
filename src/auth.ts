// Sessions. A token is "<tenantId>.<random>". Only its SHA-256 hash is stored, and a request is
// resolved by that hash. Other products call the platform to check a token, so this module is
// the single place where a session becomes a caller.

import { createHash } from "node:crypto";
import type { Caller } from "./service.js";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Checks the token shape before any lookup: a tenant id, a dot, and at least 16 random characters. */
export function parseToken(token: string): { tenantId: string } | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{16,}$/i.exec(token);
  return match ? { tenantId: match[1]! } : null;
}

export interface SessionStore {
  resolve(tokenHash: string, now: Date): Promise<Caller | null>;
}

/** In-memory session store for tests and local runs. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { caller: Caller; expiresAt: Date }>();

  add(tokenHash: string, caller: Caller, expiresAt: Date = new Date("2100-01-01T00:00:00Z")): void {
    this.sessions.set(tokenHash, { caller, expiresAt });
  }

  async resolve(tokenHash: string, now: Date): Promise<Caller | null> {
    const s = this.sessions.get(tokenHash);
    return s && s.expiresAt > now ? s.caller : null;
  }
}
