// Image / file storage on Cloudflare R2 (the Cloudflare setup). Two buckets:
//   • MEDIA — public read through its custom domain (R2_PUBLIC_URL): product / category photos, logos, posters.
//   • MEDIA_PRIVATE — NOT public (no custom domain, no r2.dev URL): support screenshots. They are read only by the API,
//     through GET /media/p/… with a signed link that runs out after 30–60 minutes (core/media.ts); after that, or with
//     a changed key or signature, the API answers 404 and never reads the bucket.
// Unlike Stratus there is no fallback to the public bucket: without MEDIA_PRIVATE a private file is refused.
import type { Files } from '../core/files'
import { ApiError } from '../core/errors'
import type { R2BucketLike } from './types'

const toBuffer = async (o: { arrayBuffer(): Promise<ArrayBuffer> } | null) => (o ? Buffer.from(await o.arrayBuffer()) : null)

export class R2Files implements Files {
  constructor(private bucket: R2BucketLike, private publicUrl: string, private privateBucket: R2BucketLike | null) {}
  get hasPrivate() { return !!this.privateBucket }
  private priv() {
    if (!this.privateBucket) throw new ApiError('Private file storage is not set up (MEDIA_PRIVATE)', 500, 'CONFIG')
    return this.privateBucket
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.bucket.put(key, body, { httpMetadata: { contentType } })
    return this.url(key)
  }
  async remove(key: string) { try { await this.bucket.delete(key) } catch { /* already gone */ } }
  async get(key: string) { try { return await toBuffer(await this.bucket.get(key)) } catch { return null } }
  url(key: string) { return `${this.publicUrl.replace(/\/$/, '')}/${key}` }
  keyOf(url: string) { const base = `${this.publicUrl.replace(/\/$/, '')}/`; return url.startsWith(base) ? url.slice(base.length) : null }
  async putPrivate(key: string, body: Buffer, contentType: string) { await this.priv().put(key, body, { httpMetadata: { contentType } }) }
  async getPrivate(key: string) { if (!this.privateBucket) return null; try { return await toBuffer(await this.privateBucket.get(key)) } catch { return null } }
  async removePrivate(key: string) { if (this.privateBucket) try { await this.privateBucket.delete(key) } catch { /* already gone */ } }
}
