// Postgres implementation of the platform store and session lookup. Tenant queries run on the
// tenant transaction (withTenantTransaction), so row-level security applies. Timestamps are cast
// to ISO text in SQL so records match the in-memory store.

import type { Pool, PoolClient } from "pg";
import type { SessionStore } from "./auth.js";
import { withTenantTransaction } from "./db/tenant.js";
import type { ProductKey } from "./catalog.js";
import type { Caller } from "./service.js";
import type {
  ApprovalBand, AuditRecord, EntitlementRecord, MatrixRecord, Page, PlatformStore, SequenceRecord,
} from "./store.js";
import type { UnitOfWork } from "./uow.js";

const ts = (col: string, alias = col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${alias}`;

function decodeCursor(cursor: string | null): number {
  return cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
}

export class PgPlatformStore implements PlatformStore {
  constructor(private readonly db: PoolClient | Pool) {}

  private async q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return (await this.db.query(sql, params)).rows as Record<string, unknown>[];
  }

  async listEntitlements(tenantId: string): Promise<EntitlementRecord[]> {
    const rows = await this.q(`SELECT tenant_id, product_key, enabled, ${ts("enabled_at")}, ${ts("updated_at")} FROM core.entitlements WHERE tenant_id = $1`, [tenantId]);
    return rows.map((r) => ({
      tenantId: String(r.tenant_id), productKey: r.product_key as ProductKey, enabled: Boolean(r.enabled),
      enabledAt: (r.enabled_at as string) ?? null, updatedAt: String(r.updated_at),
    }));
  }

  async saveEntitlement(r: EntitlementRecord): Promise<void> {
    await this.q(
      `INSERT INTO core.entitlements (tenant_id, product_key, enabled, enabled_at, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, product_key) DO UPDATE SET enabled = EXCLUDED.enabled, enabled_at = EXCLUDED.enabled_at, updated_at = EXCLUDED.updated_at`,
      [r.tenantId, r.productKey, r.enabled, r.enabledAt, r.updatedAt],
    );
  }

  private matrixFrom(r: Record<string, unknown>): MatrixRecord {
    return {
      id: String(r.id), tenantId: String(r.tenant_id), process: String(r.process), version: Number(r.version),
      status: r.status as MatrixRecord["status"], bands: r.bands as ApprovalBand[], createdAt: String(r.created_at),
      activatedAt: (r.activated_at as string) ?? null,
    };
  }

  private static matrixColumns = `id, tenant_id, process, version, status, bands, ${ts("created_at")}, ${ts("activated_at")}`;

  async listMatrices(tenantId: string, process: string | undefined): Promise<MatrixRecord[]> {
    const rows = await this.q(
      `SELECT ${PgPlatformStore.matrixColumns} FROM core.approval_matrices WHERE tenant_id = $1 AND ($2::text IS NULL OR process = $2) ORDER BY process, version`,
      [tenantId, process ?? null],
    );
    return rows.map((r) => this.matrixFrom(r));
  }

  async getMatrix(tenantId: string, id: string): Promise<MatrixRecord | null> {
    const rows = await this.q(`SELECT ${PgPlatformStore.matrixColumns} FROM core.approval_matrices WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? this.matrixFrom(rows[0]) : null;
  }

  async saveMatrix(r: MatrixRecord): Promise<void> {
    await this.q(
      `INSERT INTO core.approval_matrices (id, tenant_id, process, version, status, bands, created_at, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, activated_at = EXCLUDED.activated_at`,
      [r.id, r.tenantId, r.process, r.version, r.status, JSON.stringify(r.bands), r.createdAt, r.activatedAt],
    );
  }

  async listSequences(tenantId: string): Promise<SequenceRecord[]> {
    const rows = await this.q(`SELECT tenant_id, key, branch_id, prefix, next_number, ${ts("updated_at")} FROM core.sequences WHERE tenant_id = $1`, [tenantId]);
    return rows.map((r) => ({
      tenantId: String(r.tenant_id), key: String(r.key), branchId: String(r.branch_id), prefix: String(r.prefix),
      nextNumber: Number(r.next_number), updatedAt: String(r.updated_at),
    }));
  }

  async getSequence(tenantId: string, key: string, branchId: string): Promise<SequenceRecord | null> {
    const rows = await this.q(
      `SELECT tenant_id, key, branch_id, prefix, next_number, ${ts("updated_at")} FROM core.sequences WHERE tenant_id = $1 AND key = $2 AND branch_id = $3`,
      [tenantId, key, branchId],
    );
    const r = rows[0];
    return r ? { tenantId: String(r.tenant_id), key: String(r.key), branchId: String(r.branch_id), prefix: String(r.prefix), nextNumber: Number(r.next_number), updatedAt: String(r.updated_at) } : null;
  }

  async saveSequence(r: SequenceRecord): Promise<void> {
    await this.q(
      `INSERT INTO core.sequences (tenant_id, key, branch_id, prefix, next_number, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, key, branch_id) DO UPDATE SET prefix = EXCLUDED.prefix, next_number = EXCLUDED.next_number, updated_at = EXCLUDED.updated_at`,
      [r.tenantId, r.key, r.branchId, r.prefix, r.nextNumber, r.updatedAt],
    );
  }

  async listAudit(tenantId: string, filter: { entityType?: string; entityId?: string; from?: string; to?: string }, limit: number, cursor: string | null): Promise<Page<AuditRecord>> {
    const offset = decodeCursor(cursor);
    const rows = await this.q(
      `SELECT id, tenant_id, actor_id, action, entity_type, entity_id, changes, ${ts("at")}
         FROM core.audit_log
        WHERE tenant_id = $1 AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR entity_id = $3)
          AND ($4::timestamptz IS NULL OR at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR at <= $5::timestamptz)
        ORDER BY at, id OFFSET $6 LIMIT $7`,
      [tenantId, filter.entityType ?? null, filter.entityId ?? null, filter.from ?? null, filter.to ?? null, offset, limit + 1],
    );
    const items = rows.slice(0, limit).map((r): AuditRecord => ({
      id: String(r.id), tenantId: String(r.tenant_id), actorId: String(r.actor_id), action: String(r.action),
      entityType: String(r.entity_type), entityId: String(r.entity_id), changes: (r.changes as Record<string, unknown>) ?? null, at: String(r.at),
    }));
    const nextCursor = rows.length > limit ? Buffer.from(String(offset + limit)).toString("base64url") : null;
    return { items, nextCursor };
  }

  async appendAudit(r: AuditRecord): Promise<void> {
    await this.q(
      "INSERT INTO core.audit_log (id, tenant_id, actor_id, action, entity_type, entity_id, changes, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [r.id, r.tenantId, r.actorId, r.action, r.entityType, r.entityId, r.changes === null ? null : JSON.stringify(r.changes), r.at],
    );
  }
}

/** Runs each request in one tenant-scoped transaction on the Postgres pool. */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  run<T>(tenantId: string, work: (store: PlatformStore) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.pool, tenantId, (client) => work(new PgPlatformStore(client)));
  }
}

/**
 * Looks up a session by token hash. The sessions table has no row-level security because the
 * tenant is not known until the token is found; it is read by hash only and never listed.
 */
export class PgSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async resolve(tokenHash: string, now: Date): Promise<Caller | null> {
    const res = await this.pool.query(
      "SELECT tenant_id, user_id, roles, permissions FROM core.sessions WHERE token_hash = $1 AND expires_at > $2",
      [tokenHash, now.toISOString()],
    );
    const r = res.rows[0];
    return r ? { tenantId: String(r.tenant_id), actorId: String(r.user_id), roles: r.roles as string[], permissions: r.permissions as string[] } : null;
  }
}
