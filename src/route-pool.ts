/**
 * Per-route concurrency caps, after Workflow Assistant's TaskApiRouteConcurrencyPool.
 * A cap of 0 means unlimited. A call starts on the first route in the chain with a free slot,
 * so a busy primary connection spills over to a free fallback instead of waiting.
 */
type Waiter = { routes: string[]; resolve: (route: string) => void };

export class RoutePool {
  private readonly active = new Map<string, number>();
  private waiters: Waiter[] = [];
  constructor(private readonly limits: ReadonlyMap<string, number>) {}

  private free(route: string): boolean {
    const cap = this.limits.get(route) ?? 0;
    return cap <= 0 || (this.active.get(route) ?? 0) < cap;
  }
  private occupy(route: string): string {
    this.active.set(route, (this.active.get(route) ?? 0) + 1);
    return route;
  }
  count(route: string): number {
    return this.active.get(route) ?? 0;
  }
  /** Take the first free route among `routes`, in order; wait when all are full. */
  acquire(routes: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const route = routes.find((name) => this.free(name));
    if (route) {
      return Promise.resolve(this.occupy(route));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        routes,
        resolve: (name) => {
          signal?.removeEventListener('abort', cancel);
          resolve(name);
        },
      };
      const cancel = () => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(signal?.reason ?? new Error('任務已取消'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.waiters.push(waiter);
    });
  }
  release(route: string): void {
    this.active.set(route, Math.max(0, (this.active.get(route) ?? 0) - 1));
    for (const waiter of [...this.waiters]) {
      const next = waiter.routes.find((name) => this.free(name));
      if (next) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(this.occupy(next));
      }
    }
  }
}

/** Align fallback caps to the fallback list; missing values mean unlimited. */
export function routeLimits(chain: string[], primary: number, fallback: number[]): Map<string, number> {
  const limits = new Map<string, number>();
  chain.forEach((route, index) => {
    if (!limits.has(route)) {
      limits.set(route, Math.max(0, Math.floor((index === 0 ? primary : fallback[index - 1]) ?? 0)));
    }
  });
  return limits;
}
