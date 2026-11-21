import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken, MemorySessionStore } from "../src/auth.js";
import { MemoryPlatformStore } from "../src/store.js";
import { MemoryUnitOfWork } from "../src/uow.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SERVICE = "service-secret-for-tests-0123456789";
const token = `${TENANT}.procurement${"x".repeat(16)}`;

function make(internalToken: string | undefined) {
  const sessions = new MemorySessionStore();
  sessions.add(hashToken(token), {
    tenantId: TENANT, actorId: "55555555-5555-4555-8555-555555555555", roles: ["purchase-manager"], permissions: ["procurement.read"],
  });
  const app = buildApp({ uow: new MemoryUnitOfWork(new MemoryPlatformStore()), sessions, internalToken });
  return app;
}

describe("internal session resolution", () => {
  it("resolves a valid token for another service", async () => {
    const app = make(SERVICE);
    const res = await app.inject({
      method: "POST", url: "/internal/sessions/resolve", headers: { "x-service-token": SERVICE }, payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenantId: TENANT, roles: ["purchase-manager"], permissions: ["procurement.read"] });
  });

  it("refuses a wrong service token", async () => {
    const app = make(SERVICE);
    const res = await app.inject({ method: "POST", url: "/internal/sessions/resolve", headers: { "x-service-token": "nope" }, payload: { token } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an unknown session", async () => {
    const app = make(SERVICE);
    const other = `${TENANT}.unknown${"x".repeat(16)}`;
    const res = await app.inject({ method: "POST", url: "/internal/sessions/resolve", headers: { "x-service-token": SERVICE }, payload: { token: other } });
    expect(res.statusCode).toBe(401);
  });

  it("stays off when no service token is configured", async () => {
    const app = make(undefined);
    const res = await app.inject({ method: "POST", url: "/internal/sessions/resolve", headers: { "x-service-token": SERVICE }, payload: { token } });
    expect(res.statusCode).toBe(404);
  });
});
