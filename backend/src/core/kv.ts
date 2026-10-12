// Small key/value cache for server-side data that is read on every request (who is signed in, their
// business settings). Production: Catalyst Cache (default segment). Local: memory.
// Values are only a copy — the Data Store is always the source of truth, and every write that changes
// them bumps the business "epoch" so stale copies are never used.
export interface Kv {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlHours?: number): Promise<void>
  del(key: string): Promise<void>
}

/** In memory (local, tests, and the per-instance session cache with Turso). Oldest entries go first past `max`. */
export class MemoryKv implements Kv {
  private m = new Map<string, { v: string; exp: number }>()
  constructor(private max = 5000) {}
  async get(k: string) { const x = this.m.get(k); if (!x || x.exp < Date.now()) { this.m.delete(k); return null } return x.v }
  async set(k: string, v: string, ttlHours = 1) {
    this.m.delete(k)
    this.m.set(k, { v, exp: Date.now() + ttlHours * 3_600_000 })
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string)
  }
  async del(k: string) { this.m.delete(k) }
}

interface SegmentLike {
  getValue(key: string): Promise<string>
  put(key: string, value: string, expiry?: number): Promise<unknown>
  delete(key: string): Promise<boolean>
}
/** Catalyst Cache. A failing cache never fails the request — we just read the Data Store instead. */
export class CatalystKv implements Kv {
  constructor(private seg: SegmentLike) {}
  async get(k: string) { try { const v = await this.seg.getValue(k); return v ?? null } catch { return null } }
  async set(k: string, v: string, ttlHours = 1) { try { await this.seg.put(k, v, ttlHours) } catch { /* cache is optional */ } }
  async del(k: string) { try { await this.seg.delete(k) } catch { /* cache is optional */ } }
}
