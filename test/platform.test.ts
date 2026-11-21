import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken, MemorySessionStore } from "../src/auth.js";
import type { Caller } from "../src/service.js";
import { MemoryPlatformStore } from "../src/store.js";
import { MemoryUnitOfWork } from "../src/uow.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";

describe("platform API", () => {
  let sessions: MemorySessionStore;
  let app: ReturnType<typeof buildApp>;
  let admin: string;
  let reader: string;
  let other: string;

  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const token = (tenant: string, label: string) => `${tenant}.${label}${"x".repeat(16)}`;

  beforeEach(() => {
    sessions = new MemorySessionStore();
    app = buildApp({ uow: new MemoryUnitOfWork(new MemoryPlatformStore()), sessions, now: () => new Date("2026-11-21T09:00:00Z") });
    admin = token(TENANT, "admin");
    reader = token(TENANT, "reader");
    other = token(OTHER, "other");
    const base: Caller = { tenantId: TENANT, actorId: "55555555-5555-4555-8555-555555555555", roles: [], permissions: [] };
    sessions.add(hashToken(admin), { ...base, permissions: ["platform.read", "platform.admin"] });
    sessions.add(hashToken(reader), { ...base, permissions: ["platform.read"] });
    sessions.add(hashToken(other), { tenantId: OTHER, actorId: "77777777-7777-4777-8777-777777777777", roles: [], permissions: ["platform.read", "platform.admin"] });
  });

  const open = [{ minAmount: "0", maxAmount: "50000.00", steps: [{ role: "purchase-manager", order: 1 }] },
    { minAmount: "50000.00", maxAmount: null, steps: [{ role: "purchase-manager", order: 1 }, { role: "managing-director", order: 2 }] }];

  it("rejects a request without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/platform/products" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token whose tenant does not match its session", async () => {
    const forged = token(OTHER, "admin");
    sessions.add(hashToken(forged), { tenantId: TENANT, actorId: "55555555-5555-4555-8555-555555555555", roles: [], permissions: ["platform.read"] });
    const res = await app.inject({ method: "GET", url: "/v1/platform/entitlements", headers: auth(forged) });
    expect(res.statusCode).toBe(401);
  });

  it("lists six products, with the platform available", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/platform/products", headers: auth(reader) });
    expect(res.json().items).toHaveLength(6);
    expect(res.json().items.find((p: { key: string }) => p.key === "platform").status).toBe("available");
  });

  it("starts with the platform on and every other product off", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/platform/entitlements", headers: auth(reader) });
    const byKey = Object.fromEntries(res.json().items.map((e: { productKey: string; enabled: boolean }) => [e.productKey, e.enabled]));
    expect(byKey).toEqual({ platform: true, procurement: false, stores: false, sales: false, production: false, finance: false });
  });

  it("enables a product with an admin and records the audit entry", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/platform/entitlements/procurement", headers: auth(admin), payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
    expect(res.json().enabledAt).toBe("2026-11-21T09:00:00.000Z");
    const log = await app.inject({ method: "GET", url: "/v1/platform/audit-log?entityType=entitlement", headers: auth(reader) });
    expect(log.json().items[0]).toMatchObject({ action: "enable", entityId: "procurement" });
  });

  it("refuses to change an entitlement without the admin permission", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/platform/entitlements/procurement", headers: auth(reader), payload: { enabled: true } });
    expect(res.statusCode).toBe(403);
  });

  it("never switches the platform off", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/platform/entitlements/platform", headers: auth(admin), payload: { enabled: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PLATFORM_REQUIRED");
  });

  it("refuses an unknown product key", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/platform/entitlements/payroll", headers: auth(admin), payload: { enabled: true } });
    expect(res.statusCode).toBe(400);
  });

  it("creates, activates, and retires an approval matrix when a new version is activated", async () => {
    const v1 = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: open } });
    expect(v1.statusCode).toBe(201);
    expect(v1.json()).toMatchObject({ version: 1, status: "draft" });
    await app.inject({ method: "POST", url: `/v1/platform/approval-matrices/${v1.json().id}/activate`, headers: auth(admin) });

    const v2 = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: open } });
    expect(v2.json().version).toBe(2);
    await app.inject({ method: "POST", url: `/v1/platform/approval-matrices/${v2.json().id}/activate`, headers: auth(admin) });

    const list = await app.inject({ method: "GET", url: "/v1/platform/approval-matrices?process=purchase-order", headers: auth(reader) });
    const statuses = list.json().items.map((m: { version: number; status: string }) => `${m.version}:${m.status}`);
    expect(statuses).toEqual(["1:retired", "2:active"]);
  });

  it("refuses a band that leaves a gap, an unknown role, and activating twice", async () => {
    const gap = [{ minAmount: "0", maxAmount: "100.00", steps: [{ role: "purchase-manager", order: 1 }] },
      { minAmount: "200.00", maxAmount: null, steps: [{ role: "purchase-manager", order: 1 }] }];
    const gapRes = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: gap } });
    expect(gapRes.statusCode).toBe(400);

    const badRole = [{ minAmount: "0", maxAmount: null, steps: [{ role: "the-boss", order: 1 }] }];
    const roleRes = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: badRole } });
    expect(roleRes.statusCode).toBe(400);

    const ok = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: open } });
    await app.inject({ method: "POST", url: `/v1/platform/approval-matrices/${ok.json().id}/activate`, headers: auth(admin) });
    const again = await app.inject({ method: "POST", url: `/v1/platform/approval-matrices/${ok.json().id}/activate`, headers: auth(admin) });
    expect(again.statusCode).toBe(409);
  });

  it("does not show another tenant's matrix", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/platform/approval-matrices", headers: auth(admin), payload: { process: "purchase-order", bands: open } });
    const res = await app.inject({ method: "GET", url: `/v1/platform/approval-matrices/${created.json().id}`, headers: auth(other) });
    expect(res.statusCode).toBe(404);
  });

  it("updates a sequence and refuses to move its counter backwards", async () => {
    const set = await app.inject({ method: "PUT", url: "/v1/platform/sequences/purchase-order?branchId=" + BRANCH, headers: auth(admin), payload: { prefix: "PO-", nextNumber: 1001 } });
    expect(set.json()).toEqual({ key: "purchase-order", prefix: "PO-", nextNumber: 1001, branchId: BRANCH });
    const back = await app.inject({ method: "PUT", url: "/v1/platform/sequences/purchase-order?branchId=" + BRANCH, headers: auth(admin), payload: { nextNumber: 5 } });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.code).toBe("SEQUENCE_REGRESSION");
  });

  it("refuses a sequence prefix with spaces or symbols", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/platform/sequences/purchase-order", headers: auth(admin), payload: { prefix: "PO /" } });
    expect(res.statusCode).toBe(400);
  });

  it("keeps the audit log inside the tenant", async () => {
    await app.inject({ method: "PUT", url: "/v1/platform/entitlements/sales", headers: auth(admin), payload: { enabled: true } });
    const mine = await app.inject({ method: "GET", url: "/v1/platform/audit-log", headers: auth(reader) });
    expect(mine.json().items.length).toBeGreaterThan(0);
    const theirs = await app.inject({ method: "GET", url: "/v1/platform/audit-log", headers: auth(other) });
    expect(theirs.json().items).toHaveLength(0);
  });
});
