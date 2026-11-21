// Storage interface for the platform service. Every tenant method takes the tenant id. The
// in-memory store backs the tests; the Postgres store (pg-store.ts) implements the same
// interface on the tenant transaction. Session lookup is the one cross-tenant read, and it
// lives in auth.ts.

import type { ProductKey } from "./catalog.js";

export const APPROVAL_ROLES = [
  "department-head", "purchase-manager", "finance-controller", "operations-director", "managing-director", "board",
] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

export interface ApprovalStep {
  role: ApprovalRole;
  order: number;
}

export interface ApprovalBand {
  minAmount: string;
  maxAmount: string | null;
  steps: ApprovalStep[];
}

export interface MatrixRecord {
  id: string;
  tenantId: string;
  process: string;
  version: number;
  status: "draft" | "active" | "retired";
  bands: ApprovalBand[];
  createdAt: string;
  activatedAt: string | null;
}

export interface EntitlementRecord {
  tenantId: string;
  productKey: ProductKey;
  enabled: boolean;
  enabledAt: string | null;
  updatedAt: string;
}

export interface SequenceRecord {
  tenantId: string;
  key: string;
  branchId: string;
  prefix: string;
  nextNumber: number;
  updatedAt: string;
}

export interface AuditRecord {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: Record<string, unknown> | null;
  at: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlatformStore {
  listEntitlements(tenantId: string): Promise<EntitlementRecord[]>;
  saveEntitlement(record: EntitlementRecord): Promise<void>;

  listMatrices(tenantId: string, process: string | undefined): Promise<MatrixRecord[]>;
  getMatrix(tenantId: string, id: string): Promise<MatrixRecord | null>;
  saveMatrix(record: MatrixRecord): Promise<void>;

  listSequences(tenantId: string): Promise<SequenceRecord[]>;
  getSequence(tenantId: string, key: string, branchId: string): Promise<SequenceRecord | null>;
  saveSequence(record: SequenceRecord): Promise<void>;

  listAudit(tenantId: string, filter: { entityType?: string; entityId?: string; from?: string; to?: string }, limit: number, cursor: string | null): Promise<Page<AuditRecord>>;
  appendAudit(record: AuditRecord): Promise<void>;
}

function paginate<T>(rows: T[], limit: number, cursor: string | null): Page<T> {
  const start = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
  const items = rows.slice(start, start + limit);
  const nextCursor = start + limit < rows.length ? Buffer.from(String(start + limit)).toString("base64url") : null;
  return { items, nextCursor };
}

/** In-memory store for tests and local runs. */
export class MemoryPlatformStore implements PlatformStore {
  private entitlements = new Map<string, EntitlementRecord>();
  private matrices = new Map<string, MatrixRecord>();
  private sequences = new Map<string, SequenceRecord>();
  readonly audit: AuditRecord[] = [];

  async listEntitlements(tenantId: string) {
    return [...this.entitlements.values()].filter((e) => e.tenantId === tenantId);
  }
  async saveEntitlement(record: EntitlementRecord) {
    this.entitlements.set(`${record.tenantId}:${record.productKey}`, record);
  }

  async listMatrices(tenantId: string, process: string | undefined) {
    return [...this.matrices.values()]
      .filter((m) => m.tenantId === tenantId && (!process || m.process === process))
      .sort((a, b) => a.process.localeCompare(b.process) || a.version - b.version);
  }
  async getMatrix(tenantId: string, id: string) {
    const m = this.matrices.get(id);
    return m && m.tenantId === tenantId ? m : null;
  }
  async saveMatrix(record: MatrixRecord) {
    this.matrices.set(record.id, record);
  }

  async listSequences(tenantId: string) {
    return [...this.sequences.values()].filter((s) => s.tenantId === tenantId);
  }
  async getSequence(tenantId: string, key: string, branchId: string) {
    return this.sequences.get(`${tenantId}:${key}:${branchId}`) ?? null;
  }
  async saveSequence(record: SequenceRecord) {
    this.sequences.set(`${record.tenantId}:${record.key}:${record.branchId}`, record);
  }

  async listAudit(tenantId: string, filter: { entityType?: string; entityId?: string; from?: string; to?: string }, limit: number, cursor: string | null) {
    const rows = this.audit
      .filter((a) => a.tenantId === tenantId)
      .filter((a) => !filter.entityType || a.entityType === filter.entityType)
      .filter((a) => !filter.entityId || a.entityId === filter.entityId)
      .filter((a) => !filter.from || a.at >= filter.from)
      .filter((a) => !filter.to || a.at <= filter.to);
    return paginate(rows, limit, cursor);
  }
  async appendAudit(record: AuditRecord) {
    this.audit.push(record);
  }
}
