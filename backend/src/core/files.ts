// Image / file storage. Production: a Catalyst Stratus bucket (env STRATUS_BUCKET, public read;
// STRATUS_PUBLIC_URL = the bucket's public address). Local: files under backend/.local/uploads.
// Private files (support screenshots): a second bucket that is NOT public (env STRATUS_PRIVATE_BUCKET); they are
// shown only through short-lived signed links (core/media.ts). Without one, they stay in the public bucket as before.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Files {
  /** Saves the bytes and returns the public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>
  remove(key: string): Promise<void>
  /** Public URL of a stored key. */
  url(key: string): string
  /** The key behind one of our URLs (null when the URL isn't ours). */
  keyOf(url: string): string | null
  /** A private store is configured (else private files go to the public one, as before). */
  readonly hasPrivate: boolean
  putPrivate(key: string, body: Buffer, contentType: string): Promise<void>
  getPrivate(key: string): Promise<Buffer | null>
  removePrivate(key: string): Promise<void>
  /** A public file's bytes (the one-time move of old screenshots to the private store). */
  get(key: string): Promise<Buffer | null>
}

interface BucketLike {
  putObject(key: string, body: Buffer, opts?: { contentType?: string; overwrite?: string }): Promise<unknown>
  deleteObject(key: string): Promise<unknown>
  getObject?(key: string): Promise<AsyncIterable<Buffer | string> | Buffer>
}
async function readObject(bucket: BucketLike, key: string): Promise<Buffer | null> {
  try {
    const r = await bucket.getObject!(key)
    if (Buffer.isBuffer(r)) return r
    const parts: Buffer[] = []
    for await (const ch of r) parts.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
    return Buffer.concat(parts)
  } catch { return null }
}
export class StratusFiles implements Files {
  constructor(private bucket: BucketLike, private publicUrl: string, private privateBucket: BucketLike | null = null) {}
  get hasPrivate() { return !!this.privateBucket }
  async putPrivate(key: string, body: Buffer, contentType: string) {
    if (!this.privateBucket) { await this.put(key, body, contentType); return }
    await this.privateBucket.putObject(key, body, { contentType, overwrite: 'true' })
  }
  async getPrivate(key: string) { return this.privateBucket ? readObject(this.privateBucket, key) : null }
  async removePrivate(key: string) { if (this.privateBucket) try { await this.privateBucket.deleteObject(key) } catch { /* already gone */ } }
  async get(key: string) { return readObject(this.bucket, key) }
  async put(key: string, body: Buffer, contentType: string) {
    await this.bucket.putObject(key, body, { contentType, overwrite: 'true' })
    return this.url(key)
  }
  async remove(key: string) { try { await this.bucket.deleteObject(key) } catch { /* already gone */ } }
  url(key: string) { return `${this.publicUrl.replace(/\/$/, '')}/${key}` }
  keyOf(url: string) { const base = `${this.publicUrl.replace(/\/$/, '')}/`; return url.startsWith(base) ? url.slice(base.length) : null }
}

export class LocalFiles implements Files {
  constructor(private dir: string, private baseUrl: string, private privateDir: string | null = null) {}
  get hasPrivate() { return !!this.privateDir }
  async putPrivate(key: string, body: Buffer, contentType: string) {
    if (!this.privateDir) { await this.put(key, body); void contentType; return }
    const p = join(this.privateDir, key)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
  }
  async getPrivate(key: string) { const p = this.privateDir ? join(this.privateDir, key) : ''; return p && existsSync(p) ? readFileSync(p) : null }
  async removePrivate(key: string) { if (this.privateDir) try { unlinkSync(join(this.privateDir, key)) } catch { /* already gone */ } }
  async get(key: string) { const p = join(this.dir, key); return existsSync(p) ? readFileSync(p) : null }
  async put(key: string, body: Buffer) {
    const p = join(this.dir, key)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, body)
    return this.url(key)
  }
  async remove(key: string) { try { unlinkSync(join(this.dir, key)) } catch { /* already gone */ } }
  url(key: string) { return `${this.baseUrl.replace(/\/$/, '')}/${key}` }
  keyOf(url: string) { const base = `${this.baseUrl.replace(/\/$/, '')}/`; return url.startsWith(base) ? url.slice(base.length) : null }
}
