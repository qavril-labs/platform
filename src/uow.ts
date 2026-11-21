// A unit of work runs one request in one tenant-scoped transaction, so a configuration change and
// its audit entry commit together or not at all.

import type { PlatformStore } from "./store.js";

export interface UnitOfWork {
  run<T>(tenantId: string, work: (store: PlatformStore) => Promise<T>): Promise<T>;
}

/** For tests only: no real transaction. */
export class MemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly store: PlatformStore) {}

  async run<T>(_tenantId: string, work: (store: PlatformStore) => Promise<T>): Promise<T> {
    return work(this.store);
  }
}
