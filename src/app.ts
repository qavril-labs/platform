import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { SERVICE_NAME } from "./config.js";
import { DomainError } from "./errors.js";
import { hashToken, parseToken, type SessionStore } from "./auth.js";
import { PlatformService, type Caller } from "./service.js";
import type { PlatformStore } from "./store.js";
import type { UnitOfWork } from "./uow.js";

export interface AppDeps {
  uow: UnitOfWork;
  sessions: SessionStore;
  now?: () => Date;
  /** Shared secret for other services that resolve sessions. Unset means the internal route is off. */
  internalToken?: string;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

function pageQuery(req: FastifyRequest): { limit: number; cursor: string | null } {
  const q = req.query as Record<string, string | undefined>;
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError("VALIDATION", "limit must be an integer from 1 to 200", 400);
  return { limit, cursor: q.cursor ?? null };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const now = deps.now ?? (() => new Date());

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    }
    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode === 400 || fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(400).send({ error: { code: "VALIDATION", message: "request body is not valid JSON" } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "unexpected error" } });
  });

  app.get("/health", async () => ({ status: "ok", service: SERVICE_NAME }));

  // Internal: other products resolve a session token here. Not under /v1, so it is not a public route.
  app.post("/internal/sessions/resolve", async (req, reply) => {
    const expected = deps.internalToken;
    if (!expected) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "not found" } });
    const given = req.headers["x-service-token"];
    if (typeof given !== "string" || !sameSecret(given, expected)) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "invalid service token" } });
    }
    const token = (req.body as { token?: unknown } | null)?.token;
    const parsed = typeof token === "string" ? parseToken(token) : null;
    if (typeof token !== "string" || !parsed) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "invalid session token" } });
    const caller = await deps.sessions.resolve(hashToken(token), now());
    if (!caller || caller.tenantId !== parsed.tenantId) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "session not found or expired" } });
    }
    return { tenantId: caller.tenantId, actorId: caller.actorId, roles: caller.roles, permissions: caller.permissions };
  });

  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/v1/")) return;
    const token = bearer(req);
    const parsed = token ? parseToken(token) : null;
    if (!token || !parsed) throw new DomainError("UNAUTHENTICATED", "missing or invalid session token", 401);
    const caller = await deps.sessions.resolve(hashToken(token), now());
    if (!caller || caller.tenantId !== parsed.tenantId) throw new DomainError("UNAUTHENTICATED", "session not found or expired", 401);
    (req as FastifyRequest & { caller: Caller }).caller = caller;
  });

  const callerOf = (req: FastifyRequest): Caller => (req as FastifyRequest & { caller: Caller }).caller;
  const param = (req: FastifyRequest, name: string): string => (req.params as Record<string, string>)[name]!;

  /** One request, one tenant transaction. */
  function tx<T>(req: FastifyRequest, fn: (svc: PlatformService, caller: Caller) => Promise<T>): Promise<T> {
    const caller = callerOf(req);
    return deps.uow.run(caller.tenantId, (store: PlatformStore) => fn(new PlatformService(store, now), caller));
  }

  const V = "/v1/platform";

  app.get(`${V}/products`, async (req) => {
    callerOf(req);
    return new PlatformService({} as PlatformStore, now).listProducts();
  });

  app.get(`${V}/entitlements`, async (req) => tx(req, (svc, c) => svc.listEntitlements(c)));
  app.put(`${V}/entitlements/:productKey`, async (req) => tx(req, (svc, c) => svc.setEntitlement(c, param(req, "productKey"), req.body)));

  app.get(`${V}/approval-matrices`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, (svc, c) => svc.listApprovalMatrices(c, q.process));
  });
  app.post(`${V}/approval-matrices`, async (req, reply) => reply.code(201).send(await tx(req, (svc, c) => svc.createApprovalMatrix(c, req.body))));
  app.get(`${V}/approval-matrices/:matrixId`, async (req) => tx(req, (svc, c) => svc.getApprovalMatrix(c, param(req, "matrixId"))));
  app.post(`${V}/approval-matrices/:matrixId/activate`, async (req) => tx(req, (svc, c) => svc.activateApprovalMatrix(c, param(req, "matrixId"))));

  app.get(`${V}/sequences`, async (req) => tx(req, (svc, c) => svc.listSequences(c)));
  app.put(`${V}/sequences/:key`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return tx(req, (svc, c) => svc.updateSequence(c, param(req, "key"), q.branchId, req.body));
  });

  app.get(`${V}/audit-log`, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = pageQuery(req);
    return tx(req, (svc, c) => svc.listAuditLog(c, { entityType: q.entityType, entityId: q.entityId, from: q.from, to: q.to }, page.limit, page.cursor));
  });

  return app;
}
