import { buildApp } from "./app.js";
import { PORT } from "./config.js";
import { MemorySessionStore } from "./auth.js";
import { MemoryPlatformStore } from "./store.js";
import { MemoryUnitOfWork } from "./uow.js";

// Production needs the Postgres unit of work and session store (pg-store.ts). Until the platform
// is deployed to staging and its restore test is green, production start is refused.
if (process.env.NODE_ENV === "production") {
  throw new Error("platform: production start waits for staging deploy and the restore test; see docs/product-platform-decisions.md");
}

const store = new MemoryPlatformStore();
const app = buildApp({ uow: new MemoryUnitOfWork(store), sessions: new MemorySessionStore() });
await app.listen({ port: PORT, host: "0.0.0.0" });
