// Image / file storage. Production: a Catalyst Stratus bucket (env STRATUS_BUCKET, public read;
// STRATUS_PUBLIC_URL = the bucket's public address). Local: files under backend/.local/uploads.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Files {
  /** Saves the bytes and returns the public URL. */
  put(key: string, body: Buffer, contentType: string): Promise<string>
  remove(key: string): Promise<void>
  /** Public URL of a stored key. */
  url(key: string): string
  /** The key behind one of our URLs (null when the URL isn't ours). */
  keyOf(url: string): string | null
}

interface BucketLike {
  putObject(key: string, body: Buffer, opts?: { contentType?: string; overwrite?: string }): Promise<unknown>
  deleteObject(key: string): Promise<unknown>
}
export class StratusFiles implements Files {
  constructor(private bucket: BucketLike, private publicUrl: string) {}
  async put(key: string, body: Buffer, contentType: string) {
    await this.bucket.putObject(key, body, { contentType, overwrite: 'true' })
    return this.url(key)
  }
  async remove(key: string) { try { await this.bucket.deleteObject(key) } catch { /* already gone */ } }
  url(key: string) { return `${this.publicUrl.replace(/\/$/, '')}/${key}` }
  keyOf(url: string) { const base = `${this.publicUrl.replace(/\/$/, '')}/`; return url.startsWith(base) ? url.slice(base.length) : null }
}

export class LocalFiles implements Files {
  constructor(private dir: string, private baseUrl: string) {}
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
