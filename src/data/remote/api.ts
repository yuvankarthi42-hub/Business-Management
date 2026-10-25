// The app's `api` for the Zoho Catalyst backend. Same shape as the mock in ../api.ts, so the screens
// don't change: every action becomes POST /rpc/<namespace>.<method>, reads are cached (cache.ts),
// writes go straight to the server. Only actions that need the browser (sign-in tokens, branch choice,
// compressing photos before upload, export files) are written out below — everything else is generic.
import { modulesFor } from '@/core/config'
import type { ImportItem } from '@/core/productImport'
import { APP_VERSION, type Api, type ExportBundle } from '../api'
import { compressImage, ensureStoredImage, LOGO_IMAGE } from '../media'
import { cachedRead, clearAll, confirmedWrite, invalidate, notify } from './cache'
import { ApiError, auth, rpc, setSignedOutHandler, type TokenKind } from './http'
import { isRead } from './policy'
import { startSync } from './sync'
import { restartLive, stopLive } from './live'

/** Reads that must never be cached (big one-off downloads). */
// public.order / public.track: the server answers from its own shared cache; Refresh must really ask.
const UNCACHED = new Set(['dataExport.mine', 'public.order', 'public.track'])

const tokenFor = (name: string): TokenKind => {
  if (name === 'admin.login' || name === 'admin.setup' || name === 'auth.login') return 'none'
  if (name === 'admin.endSupport') return 'user'
  if (name.startsWith('admin.')) return 'admin'
  return 'user'
}
export function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const token = tokenFor(name)
  if (UNCACHED.has(name)) return rpc<T>(name, args, token).then((r) => r.data)
  return isRead(name) ? cachedRead<T>(name, args, token) : confirmedWrite<T>(name, args, token)
}

// A token that stopped working (password changed, login turned off): forget cached data and show sign-in.
setSignedOutHandler(() => { stopLive(); clearAll() })

const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(b) })

/** Photos are compressed in this browser (≤ 50 KB, 320 px thumbnail), then stored by the server, which checks the size again. */
async function uploadPhoto(file: Blob, purpose: 'product' | 'category' = 'product') {
  const img = await compressImage(file)
  const stored = await call<{ url: string; thumbUrl: string | null; bytes: number }>('media.store', { image: img.url, thumb: img.thumbUrl, width: img.width, height: img.height, quality: img.quality, originalBytes: img.originalBytes, purpose })
  return { ...img, url: stored.url, thumbUrl: stored.thumbUrl ?? img.thumbUrl, bytes: stored.bytes }
}
async function uploadScreenshot(name: 'support.storeScreenshot' | 'admin.storeScreenshot', file: Blob) {
  const img = await compressImage(file, { maxBytes: 200 * 1024, maxSide: 1600 })
  return (await call<{ url: string }>(name, { image: img.url, width: img.width, height: img.height })).url
}

/** The server sends photo links; the export screens expect the image data, so it is fetched here. */
async function withImageData(b: ExportBundle & { images: { path: string; url?: string; dataUrl?: string }[] }): Promise<ExportBundle> {
  const images: { path: string; dataUrl: string }[] = []
  for (const im of b.images ?? []) {
    if (im.dataUrl) { images.push({ path: im.path, dataUrl: im.dataUrl }); continue }
    try { const r = await fetch(im.url!); if (r.ok) images.push({ path: im.path, dataUrl: await blobToDataUrl(await r.blob()) }) } catch { /* photo left out of the ZIP */ }
  }
  return { ...b, images }
}

const notAvailable = (what: string) => async () => { throw new ApiError(`${what} is only available in the demo app`) }

/** Builds the API object from the mock's list of actions, then replaces the browser-specific ones. */
export function createRemoteApi(shape: Api): Api {
  startSync()
  const out: Record<string, Record<string, unknown>> = {}
  for (const [ns, fns] of Object.entries(shape)) {
    out[ns] = {}
    for (const [m, v] of Object.entries(fns as Record<string, unknown>)) out[ns][m] = typeof v === 'function' ? (...args: unknown[]) => call(`${ns}.${m}`, ...args) : v
  }
  const a = out as unknown as Api

  // ---- customer sign-in ----
  a.auth.login = (async (identifier: string, password: string) => {
    const r = await call<{ token: string; branchId: string }>('auth.login', identifier, password)
    auth.user = r.token; auth.branch = r.branchId || null
    clearAll()
    restartLive()
    return (await a.auth.me())?.user
  }) as Api['auth']['login']
  a.auth.demoLogin = notAvailable('Demo login') as Api['auth']['demoLogin']
  a.auth.demoUsers = (() => []) as unknown as Api['auth']['demoUsers']
  a.auth.logout = (async () => { stopLive(); auth.user = null; auth.branch = null; clearAll() }) as Api['auth']['logout']
  a.auth.me = (async () => {
    if (!auth.user) return null
    try { return await cachedRead('auth.me', [], 'user') } catch (e) { if ((e as ApiError).status === 401 || (e as ApiError).code === 'DEACTIVATED') { auth.user = null; return null } throw e }
  }) as Api['auth']['me']
  a.auth.switchBranch = (async (branchId: string) => {
    await rpc('auth.switchBranch', [branchId], 'user')
    auth.branch = branchId
    clearAll() // everything on screen belongs to a branch
  }) as Api['auth']['switchBranch']
  a.auth.setLanguage = (async (language: string) => {
    const me = await a.auth.me()
    if (me?.support) return language // support view: this device only
    return call('auth.setLanguage', language)
  }) as Api['auth']['setLanguage']

  // ---- product admin sign-in & support view ----
  a.admin.login = (async (username: string, password: string) => {
    const r = await call<{ token: string; admin: Awaited<ReturnType<Api['admin']['login']>> }>('admin.login', username, password)
    auth.admin = r.token
    invalidate(['adminMe', 'admin'])
    return r.admin
  }) as Api['admin']['login']
  a.admin.logout = (async () => { auth.admin = null; invalidate(['adminMe', 'admin']); notify() }) as Api['admin']['logout']
  a.admin.me = (async () => {
    if (!auth.admin) return null
    try { return await cachedRead('admin.me', [], 'admin') } catch (e) { if ((e as ApiError).status === 401) { auth.admin = null; return null } throw e }
  }) as Api['admin']['me']
  a.admin.startSupport = (async (businessId: string, reason: string) => {
    const r = await call<{ onboarded: boolean; token: string; branchId: string }>('admin.startSupport', businessId, reason)
    auth.user = r.token; auth.branch = r.branchId || null
    clearAll()
    restartLive()
    return { onboarded: r.onboarded }
  }) as Api['admin']['startSupport']
  a.admin.endSupport = (async () => {
    if (!auth.user) return null
    const id = await rpc<string | null>('admin.endSupport', [], 'user').then((r) => r.data).catch(() => null)
    stopLive()
    auth.user = null; auth.branch = null
    clearAll()
    return id
  }) as Api['admin']['endSupport']

  // ---- support tickets: the server also gets the browser and app version (helps the support team) ----
  a.support.create = ((input: Parameters<Api['support']['create']>[0]) => call('support.create', {
    ...input, browser: navigator.userAgent.replace(/^.*?(Chrome|Firefox|Safari|Edg)\/([\d.]+).*$/, '$1 $2').slice(0, 60), version: APP_VERSION,
  })) as Api['support']['create']

  // ---- files ----
  a.media.upload = ((file: Blob) => uploadPhoto(file)) as Api['media']['upload']
  a.business.setLogo = (async (file: Blob | null) => {
    if (!file) return call('business.setLogo', null)
    const img = await compressImage(file, LOGO_IMAGE)
    return call('business.setLogo', { image: img.url, width: img.width, height: img.height, quality: img.quality, originalBytes: img.originalBytes })
  }) as Api['business']['setLogo']
  a.support.uploadScreenshot = ((file: Blob) => uploadScreenshot('support.storeScreenshot', file)) as Api['support']['uploadScreenshot']
  a.admin.uploadScreenshot = ((file: Blob) => uploadScreenshot('admin.storeScreenshot', file)) as Api['admin']['uploadScreenshot']
  a.dataExport.mine = (async () => withImageData(await call('dataExport.mine'))) as Api['dataExport']['mine']
  a.admin.exportCustomer = (async (id: string) => withImageData(await call('admin.exportCustomer', id))) as Api['admin']['exportCustomer']

  /** CSV import: photo links are compressed here when the site allows it, else kept as links (like the demo app). */
  a.products.importMany = (async (rows: (ImportItem & { row: number })[], opts: { onExisting: 'skip' | 'update'; fileName: string }) => {
    let photosCompressed = 0, photosLinked = 0
    const items = [...rows]
    const withPhoto = items.map((it, i) => ({ it, i })).filter((x) => x.it.imageUrl)
    for (let k = 0; k < withPhoto.length; k += 4) {
      await Promise.all(withPhoto.slice(k, k + 4).map(async ({ it, i }) => {
        const r = await ensureStoredImage(it.imageUrl).catch(() => null)
        if (r?.imageUrl?.startsWith('data:')) {
          const blob = await (await fetch(r.imageUrl)).blob()
          const up = await uploadPhoto(blob).catch(() => null)
          if (up) { items[i] = { ...it, imageUrl: up.url, thumbUrl: up.thumbUrl }; photosCompressed++; return }
        }
        if (r?.imageUrl && /^https:\/\//.test(r.imageUrl)) { items[i] = { ...it, imageUrl: r.imageUrl, thumbUrl: null }; photosLinked++; return }
        items[i] = { ...it, imageUrl: null, thumbUrl: null }
      }))
    }
    const res = await call<Awaited<ReturnType<Api['products']['importMany']>>>('products.importMany', items, opts)
    return { ...res, photosCompressed, photosLinked }
  }) as Api['products']['importMany']

  // ---- things that only exist in the demo app / run on the server ----
  a.business.defaultModules = modulesFor
  a.branches.addDemo = notAvailable('Sample branches') as Api['branches']['addDemo']
  a.system.runDailyJobs = (async () => 0) as Api['system']['runDailyJobs'] // a Catalyst cron runs this at 9 AM
  a.dev.reset = notAvailable('Resetting data') as Api['dev']['reset']
  a.dev.setSubscription = notAvailable('Changing the period directly') as Api['dev']['setSubscription']
  return a
}
