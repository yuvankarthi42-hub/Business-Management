// The few Cloudflare Workers types this code uses, written out here (no extra package): R2 buckets, Durable Objects,
// WebSocket pairs. They match the shapes the Workers runtime provides.

export interface R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer> }
export interface R2BucketLike {
  put(key: string, body: ArrayBuffer | ArrayBufferView | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
}

export interface DurableObjectStubLike { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStubLike
}

/** A server-side WebSocket in a Durable Object (hibernation API). */
export interface HubSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}
export interface DurableObjectStateLike {
  acceptWebSocket(ws: HubSocket, tags?: string[]): void
  getWebSockets(tag?: string): HubSocket[]
  setWebSocketAutoResponse?(pair: unknown): void
}

/** The Worker's bindings and settings (wrangler.toml). Text settings are also copied into process.env at start. */
export interface WorkerEnv {
  MEDIA?: R2BucketLike
  MEDIA_PRIVATE?: R2BucketLike
  SHOP_HUB?: DurableObjectNamespaceLike
  [setting: string]: unknown
}

export interface ScheduledEventLike { cron?: string; scheduledTime?: number }
export interface ExecutionContextLike { waitUntil(p: Promise<unknown>): void }
