// Business rules for the platform: products, entitlements, approval matrices, document
// sequences and the audit log. Every write records an audit entry in the same transaction.

import { DomainError, forbidden, notFound, validation } from "./errors.js";
import { PRODUCTS, PRODUCT_KEYS, type ProductKey, isProductKey } from "./catalog.js";
import { newId, UUID_RE } from "./ids.js";
import {
  APPROVAL_ROLES, type ApprovalBand, type AuditRecord, type EntitlementRecord, type MatrixRecord, type PlatformStore,
  type SequenceRecord,
} from "./store.js";

export interface Caller {
  tenantId: string;
  actorId: string;
  roles: string[];
  permissions: string[];
}

export const NIL_BRANCH = "00000000-0000-0000-0000-000000000000";

export function requirePermission(caller: Caller, permission: string): void {
  if (!caller.permissions.includes(permission)) throw forbidden(`missing permission ${permission}`);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw validation("request body must be a JSON object");
  return value as Record<string, unknown>;
}

/** Parses a decimal amount to a scaled integer (10^4) so bands can be compared exactly. */
export function scaledAmount(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!match) throw validation(`invalid amount ${value}`, [{ field: "minAmount" }]);
  return BigInt(match[1]! + (match[2] ?? "").padEnd(4, "0"));
}

/** Checks a matrix: bands start at zero, are contiguous, end open, and every band has valid steps. */
export function validateBands(bands: unknown): ApprovalBand[] {
  if (!Array.isArray(bands) || bands.length === 0) throw validation("bands must be a non-empty array", [{ field: "bands" }]);
  const parsed: ApprovalBand[] = bands.map((raw, i) => {
    const b = asObject(raw);
    if (typeof b.minAmount !== "string") throw validation(`bands[${i}].minAmount must be a decimal string`, [{ field: "bands" }]);
    const maxAmount = b.maxAmount === undefined || b.maxAmount === null ? null : String(b.maxAmount);
    if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > 5) {
      throw validation(`bands[${i}].steps must have 1 to 5 steps`, [{ field: "bands" }]);
    }
    const steps = (b.steps as unknown[]).map((s) => {
      const step = asObject(s);
      if (!APPROVAL_ROLES.includes(step.role as (typeof APPROVAL_ROLES)[number])) {
        throw validation(`unknown approval role ${String(step.role)}`, [{ field: "bands" }]);
      }
      if (!Number.isInteger(step.order) || (step.order as number) < 1) throw validation("step order must be a whole number from 1", [{ field: "bands" }]);
      return { role: step.role as ApprovalBand["steps"][number]["role"], order: step.order as number };
    });
    const orders = steps.map((s) => s.order);
    if (new Set(orders).size !== orders.length) throw validation(`bands[${i}] has duplicate step orders`, [{ field: "bands" }]);
    return { minAmount: b.minAmount, maxAmount, steps };
  });
  if (scaledAmount(parsed[0]!.minAmount) !== 0n) throw validation("the first band must start at 0", [{ field: "bands" }]);
  for (let i = 0; i < parsed.length; i++) {
    const band = parsed[i]!;
    const isLast = i === parsed.length - 1;
    if (isLast && band.maxAmount !== null) throw validation("the last band must be open-ended (maxAmount null)", [{ field: "bands" }]);
    if (!isLast) {
      if (band.maxAmount === null) throw validation("only the last band may be open-ended", [{ field: "bands" }]);
      if (scaledAmount(band.maxAmount) !== scaledAmount(parsed[i + 1]!.minAmount)) {
        throw validation(`band ${i + 1} must start where band ${i} ends`, [{ field: "bands" }]);
      }
      if (scaledAmount(band.maxAmount) <= scaledAmount(band.minAmount)) throw validation(`band ${i} is empty`, [{ field: "bands" }]);
    }
  }
  return parsed;
}

const PREFIX_RE = /^[A-Za-z0-9-]{0,16}$/;

export class PlatformService {
  constructor(private readonly store: PlatformStore, private readonly now: () => Date = () => new Date()) {}

  private async audit(caller: Caller, action: string, entityType: string, entityId: string, changes: Record<string, unknown> | null): Promise<void> {
    const record: AuditRecord = {
      id: newId(), tenantId: caller.tenantId, actorId: caller.actorId, action, entityType, entityId, changes,
      at: this.now().toISOString(),
    };
    await this.store.appendAudit(record);
  }

  // Products (the catalogue is the same for every tenant)
  listProducts() {
    return { items: PRODUCTS.map((p) => ({ ...p })) };
  }

  // Entitlements
  private entitlementView(e: { productKey: ProductKey; enabled: boolean; enabledAt: string | null; updatedAt: string | null }) {
    return { productKey: e.productKey, enabled: e.enabled, enabledAt: e.enabledAt, updatedAt: e.updatedAt ?? this.now().toISOString() };
  }

  async listEntitlements(caller: Caller) {
    const rows = await this.store.listEntitlements(caller.tenantId);
    const items = PRODUCT_KEYS.map((key) => {
      const row = rows.find((r) => r.productKey === key);
      if (row) return this.entitlementView(row);
      // The platform itself is always on; other products start disabled.
      return this.entitlementView({ productKey: key, enabled: key === "platform", enabledAt: null, updatedAt: null });
    });
    return { items };
  }

  async setEntitlement(caller: Caller, productKey: string, body: unknown) {
    requirePermission(caller, "platform.admin");
    if (!isProductKey(productKey)) throw validation("unknown product", [{ field: "productKey" }]);
    const b = asObject(body);
    if (typeof b.enabled !== "boolean") throw validation("enabled must be true or false", [{ field: "enabled" }]);
    if (productKey === "platform" && b.enabled === false) {
      throw new DomainError("PLATFORM_REQUIRED", "the platform cannot be switched off", 409);
    }
    const existing = (await this.store.listEntitlements(caller.tenantId)).find((e) => e.productKey === productKey);
    const at = this.now().toISOString();
    const record: EntitlementRecord = {
      tenantId: caller.tenantId, productKey, enabled: b.enabled, updatedAt: at,
      enabledAt: b.enabled ? (existing?.enabled ? existing.enabledAt : at) : existing?.enabledAt ?? null,
    };
    await this.store.saveEntitlement(record);
    await this.audit(caller, b.enabled ? "enable" : "disable", "entitlement", productKey, { enabled: b.enabled });
    return this.entitlementView(record);
  }

  // Approval matrices
  private matrixView(m: MatrixRecord) {
    return { id: m.id, process: m.process, version: m.version, status: m.status, bands: m.bands, createdAt: m.createdAt, activatedAt: m.activatedAt };
  }

  async listApprovalMatrices(caller: Caller, process: string | undefined) {
    requirePermission(caller, "platform.read");
    return { items: (await this.store.listMatrices(caller.tenantId, process)).map((m) => this.matrixView(m)) };
  }

  async getApprovalMatrix(caller: Caller, id: string) {
    requirePermission(caller, "platform.read");
    if (!UUID_RE.test(id)) throw validation("matrixId must be a UUID", [{ field: "matrixId" }]);
    const m = await this.store.getMatrix(caller.tenantId, id);
    if (!m) throw notFound("approval matrix");
    return this.matrixView(m);
  }

  async createApprovalMatrix(caller: Caller, body: unknown) {
    requirePermission(caller, "platform.admin");
    const b = asObject(body);
    if (typeof b.process !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(b.process)) {
      throw validation("process must be a lowercase slug", [{ field: "process" }]);
    }
    const bands = validateBands(b.bands);
    const existing = await this.store.listMatrices(caller.tenantId, b.process);
    const version = existing.reduce((max, m) => Math.max(max, m.version), 0) + 1;
    const record: MatrixRecord = {
      id: newId(), tenantId: caller.tenantId, process: b.process, version, status: "draft", bands,
      createdAt: this.now().toISOString(), activatedAt: null,
    };
    await this.store.saveMatrix(record);
    await this.audit(caller, "create", "approval-matrix", record.id, { process: record.process, version });
    return this.matrixView(record);
  }

  async activateApprovalMatrix(caller: Caller, id: string) {
    requirePermission(caller, "platform.admin");
    if (!UUID_RE.test(id)) throw validation("matrixId must be a UUID", [{ field: "matrixId" }]);
    const m = await this.store.getMatrix(caller.tenantId, id);
    if (!m) throw notFound("approval matrix");
    if (m.status !== "draft") throw new DomainError("INVALID_STATE", `matrix is ${m.status}; only a draft can be activated`, 409);
    const at = this.now().toISOString();
    for (const other of await this.store.listMatrices(caller.tenantId, m.process)) {
      if (other.status === "active") {
        other.status = "retired";
        await this.store.saveMatrix(other);
      }
    }
    m.status = "active";
    m.activatedAt = at;
    await this.store.saveMatrix(m);
    await this.audit(caller, "activate", "approval-matrix", m.id, { process: m.process, version: m.version });
    return this.matrixView(m);
  }

  // Document sequences
  private sequenceView(s: SequenceRecord) {
    return { key: s.key, prefix: s.prefix, nextNumber: s.nextNumber, branchId: s.branchId };
  }

  async listSequences(caller: Caller) {
    requirePermission(caller, "platform.read");
    return { items: (await this.store.listSequences(caller.tenantId)).map((s) => this.sequenceView(s)) };
  }

  async updateSequence(caller: Caller, key: string, branchId: string | undefined, body: unknown) {
    requirePermission(caller, "platform.admin");
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(key)) throw validation("key must be a lowercase slug", [{ field: "key" }]);
    const branch = branchId ?? NIL_BRANCH;
    if (!UUID_RE.test(branch)) throw validation("branchId must be a UUID", [{ field: "branchId" }]);
    const b = asObject(body);
    if (b.prefix !== undefined && (typeof b.prefix !== "string" || !PREFIX_RE.test(b.prefix))) {
      throw validation("prefix must be up to 16 letters, digits or dashes", [{ field: "prefix" }]);
    }
    if (b.nextNumber !== undefined && (!Number.isInteger(b.nextNumber) || (b.nextNumber as number) < 1)) {
      throw validation("nextNumber must be a whole number from 1", [{ field: "nextNumber" }]);
    }
    const current = (await this.store.getSequence(caller.tenantId, key, branch)) ?? {
      tenantId: caller.tenantId, key, branchId: branch, prefix: "", nextNumber: 1, updatedAt: this.now().toISOString(),
    };
    const nextNumber = b.nextNumber === undefined ? current.nextNumber : (b.nextNumber as number);
    // A counter that moves backwards would reuse document numbers that already exist.
    if (nextNumber < current.nextNumber) {
      throw new DomainError("SEQUENCE_REGRESSION", `nextNumber cannot move back from ${current.nextNumber} to ${nextNumber}`, 409);
    }
    const record: SequenceRecord = {
      ...current, prefix: b.prefix === undefined ? current.prefix : (b.prefix as string), nextNumber, updatedAt: this.now().toISOString(),
    };
    await this.store.saveSequence(record);
    await this.audit(caller, "update", "sequence", `${key}:${branch}`, { prefix: record.prefix, nextNumber });
    return this.sequenceView(record);
  }

  // Audit log (read only)
  async listAuditLog(caller: Caller, filter: { entityType?: string; entityId?: string; from?: string; to?: string }, limit: number, cursor: string | null) {
    requirePermission(caller, "platform.read");
    const page = await this.store.listAudit(caller.tenantId, filter, limit, cursor);
    return {
      items: page.items.map((a) => ({ id: a.id, at: a.at, actorId: a.actorId, action: a.action, entityType: a.entityType, entityId: a.entityId, changes: a.changes })),
      nextCursor: page.nextCursor,
    };
  }
}
