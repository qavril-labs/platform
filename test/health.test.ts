import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemorySessionStore } from "../src/auth.js";
import { MemoryPlatformStore } from "../src/store.js";
import { MemoryUnitOfWork } from "../src/uow.js";

describe("health", () => {
  it("answers 200 with the service name", async () => {
    const app = buildApp({ uow: new MemoryUnitOfWork(new MemoryPlatformStore()), sessions: new MemorySessionStore() });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "platform" });
    await app.close();
  });
});
