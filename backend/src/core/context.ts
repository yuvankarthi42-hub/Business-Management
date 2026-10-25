// Everything a handler knows about the request: the database, who is signed in, and the rules that
// apply to every call (branch access, read-only accounts, support view). Built by app.ts per request.
import type { Business, Branch, Permission, Role, User } from '@/core/types'
import { subscriptionState, DEACTIVATED_MESSAGE, READ_ONLY_MESSAGE } from '@/core/subscription'
import { adminCan, ADMIN_ROLES, type AdminPermission } from '@/core/adminRoles'
import type { Databases } from '../db/databases'
import { memoized, scoped } from '../db/scoped'
import type { Db } from '../db/types'
import type { Epochs } from './epochs'
import type { Kv } from './kv'
import type { Files } from './files'
import type { PushSender } from './webpush'
import type { EventSink } from '../events/publish'
import type { HubEvent } from '../events/hub'
import { ApiError, forbidden, notSignedIn } from './errors'

/** What every request gets from the host (Catalyst function, local server, tests). */
export interface Env {
  dbs: Databases; kv: Kv; files: Files; epochs: Epochs
  /** Cache shared by every function instance (Catalyst Cache) — order-tracking snapshots, rate limits. Default: kv. */
  shared?: Kv
  /** Browser push for order tracking; null/undefined = not set up. */
  push?: PushSender | null
  /** Live updates for open screens (event hub); null/undefined = not set up (screens use the change feed). */
  events?: EventSink | null
}

export const ALL_BRANCHES = 'all'
export const SUPPORT_MESSAGE = 'Support view is read-only — nothing can be changed from here.'

export interface SupportClaim { adminId: string; adminName: string; reason: string; startedAt: string }

/** The signed-in customer user, loaded once per request (cached in Kv between requests). */
export interface Session {
  user: User
  role: Role
  business: Business
  /** Every branch of the business (active or not). */
  allBranches: Branch[]
  /** Branch ids this user may open. */
  allowed: string[]
  permissions: Set<Permission> | 'all'
  /** Branch chosen in the top bar (x-branch header), or 'all'. Always one the user may open. */
  branchId: string
  support: SupportClaim | null
  /** Features the product admin released to this business. */
  features: Record<string, boolean>
}

export interface AdminSession { id: string; name: string; username: string; role: keyof typeof ADMIN_ROLES }

/** Confirmed changes the app can apply to data it already has, instead of reading it again. */
export interface Effects {
  /** New stock of a product in a branch (after a bill, return, adjustment…). */
  stock?: { productId: string; branchId: string; stock: number }[]
}

export class Ctx {
  session: Session | null = null
  admin: AdminSession | null = null
  effects: Effects = {}
  addStock(productId: string, branchId: string, stock: number) {
    const list = (this.effects.stock ??= [])
    const i = list.findIndex((x) => x.productId === productId && x.branchId === branchId)
    if (i >= 0) list[i].stock = stock; else list.push({ productId, branchId, stock })
  }
  readonly dbs: Databases
  readonly kv: Kv
  readonly files: Files
  readonly epochs: Epochs
  readonly shared: Kv
  readonly push: PushSender | null
  readonly events: EventSink | null
  /** Events of this request, sent to the hub only after everything is saved (app.ts). */
  private outbox: HubEvent[] = []
  emit(ev: HubEvent) { if (this.events) this.outbox.push(ev) }
  takeEvents() { const x = this.outbox; this.outbox = []; return x }
  /** The caller's address (for rate limits on public lookups). */
  ip = ''
  /** Raw handles (the open transaction's handle while one runs). Use c.platform / c.db, which check the tables. */
  private rawPlatform: Db
  private rawShop: Db | null = null
  private views: { platform?: Db; shop?: Db } = {}
  private txOpen: 'shop' | 'platform' | null = null
  /** The shop whose database c.db is. */
  shopId: string | null = null
  /** Set by app.ts for writes: the action name goes to the change feed when the change commits. */
  changeName: string | null = null
  changeLogged = false
  /** The change_log row of this request (events carry it, so screens notice a missed one). */
  changeId: number | null = null
  /** The device that sent the request (x-device), so the change feed can skip its own changes. */
  origin: string | null = null
  /** The signed-in shop's session epoch (changes when users, settings, the subscription… change). */
  epoch: string | null = null

  constructor(env: Env, platform: Db, readonly requestId: string | null, readonly now = new Date()) {
    this.dbs = env.dbs; this.kv = env.kv; this.files = env.files; this.epochs = env.epochs
    this.shared = env.shared ?? env.kv; this.push = env.push ?? null; this.events = env.events ?? null
    this.rawPlatform = platform
  }

  private afterHooks: (() => Promise<void>)[] = []
  private failHooks: (() => Promise<void>)[] = []
  /** Runs once the whole request has been saved (after the transaction committed). */
  afterCommit(fn: () => Promise<void>) { this.afterHooks.push(fn) }
  /** Runs when the request fails (its transaction was rolled back): undo what was saved elsewhere. */
  onFail(fn: () => Promise<void>) { this.failHooks.push(fn) }
  /** Called by app.ts. Hook errors are logged, never shown to the user (the request itself is done). */
  async finish(ok: boolean) {
    const list = ok ? this.afterHooks : this.failHooks
    this.afterHooks = []; this.failHooks = []
    for (const fn of ok ? list : list.reverse()) await fn().catch((e) => console.error(`[${ok ? 'afterCommit' : 'onFail'}]`, e))
  }

  // ---------- databases ----------
  /** Product-admin data, the shop directory, plans, support tickets, sign-in names. */
  get platform(): Db { return (this.views.platform ??= scoped(this.rawPlatform, 'platform')) }
  /** The signed-in shop's own database (or the QR menu's shop). */
  get db(): Db {
    if (!this.rawShop) throw new Error('No shop selected for this request')
    return (this.views.shop ??= this.memo ? memoized(scoped(this.rawShop, 'shop'), this.memo) : scoped(this.rawShop, 'shop'))
  }
  private memo: Map<string, Promise<unknown>> | null = null
  /**
   * From now on in this request, catalogue reads (products, prices, variants, add-ons, specials, taxes) are
   * kept once made. A bill reads them before its transaction, so inside it they cost no round trip.
   */
  memoCatalog() { if (!this.memo) { this.memo = new Map(); this.views.shop = undefined } }
  get hasShop() { return !!this.rawShop }

  /** Selects the shop for this request (sign-in token, QR menu, product admin). */
  async useShop(businessId: string) {
    if (this.shopId === String(businessId) && this.rawShop) return
    if (this.txOpen === 'shop') throw new Error('Can’t switch shops inside a shop transaction')
    // One database for everything: the shop handle is the platform handle (and its open transaction).
    this.rawShop = this.dbs.perShop ? await this.dbs.shop(String(businessId)) : this.rawPlatform
    this.shopId = String(businessId)
    this.views.shop = undefined
  }
  /** Another shop's database (product admin). The current shop's comes back as c.db (and joins its transaction). */
  async shopDb(businessId: string): Promise<Db> {
    if (this.rawShop && this.shopId === String(businessId)) return this.db
    // One database for everything: the platform handle is that database (and its open transaction).
    if (!this.dbs.perShop) return scoped(this.rawPlatform, 'shop')
    return scoped(await this.dbs.shop(String(businessId)), 'shop')
  }

  /**
   * Runs fn as one transaction on the shop's database: everything is saved, or nothing. Writes from app.ts
   * are already wrapped (handler option tx); call this in a handler with tx: 'manual' after its reads.
   * The change-feed row is written in the same transaction.
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txOpen) return fn()
    if (!this.rawShop) throw new Error('No shop selected for this request')
    return this.rawShop.transaction(async (t) => {
      const prev = { shop: this.rawShop, platform: this.rawPlatform }
      this.swap(t, this.dbs.perShop ? prev.platform : t, 'shop')
      try {
        const out = await fn()
        await this.flushAudits()
        await this.logChange()
        return out
      } finally { this.audits = []; this.swap(prev.shop, prev.platform, null) }
    })
  }
  /** The same on the platform database (product admin writes). */
  async platformTx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txOpen) return fn()
    return this.rawPlatform.transaction(async (t) => {
      const prev = { shop: this.rawShop, platform: this.rawPlatform }
      this.swap(this.dbs.perShop ? prev.shop : (prev.shop ? t : null), t, 'platform')
      try { return await fn() } finally { this.swap(prev.shop, prev.platform, null) }
    })
  }
  private swap(shop: Db | null, platform: Db, open: Ctx['txOpen']) {
    this.rawShop = shop; this.rawPlatform = platform; this.txOpen = open; this.views = {}
  }

  private audits: Record<string, string | number | boolean | null>[] = []
  /** An audit_logs row: inside a shop transaction kept until its end and written in one insert, else now. */
  async auditRow(row: Record<string, string | number | boolean | null>) {
    if (this.txOpen === 'shop') { this.audits.push(row); return }
    await this.db.insert('audit_logs', row)
  }
  private async flushAudits() {
    if (!this.audits.length) return
    const rows = this.audits
    this.audits = []
    await this.db.insertMany('audit_logs', rows)
  }

  /** Change feed (one database per shop only): which action changed this shop, for the other devices. */
  async logChange() {
    if (!this.changeName || this.changeLogged || !this.rawShop || !this.dbs.perShop || !this.shopId) return
    const branch = this.session && this.session.branchId !== ALL_BRANCHES ? this.session.branchId : null
    const rows = await this.db.sql!('INSERT INTO "change_log" ("business_id", "branch_id", "tag", "origin") VALUES (?, ?, ?, ?) RETURNING "id"', [Number(this.shopId), branch ? Number(branch) : null, this.changeName, this.origin])
    this.changeId = rows[0]?.id != null ? Number(rows[0].id) : null
    // Keep the feed small: now and then, drop rows older than two days (same transaction, uses the index).
    if (Math.random() < 0.02) await this.db.sql!('DELETE FROM "change_log" WHERE "created_at" < ?', [new Date(this.now.getTime() - 2 * 86_400_000).toISOString()])
    this.changeLogged = true
  }

  // ---------- customer side ----------
  get s(): Session { if (!this.session) throw notSignedIn(); return this.session }
  get businessId() { return this.s.business.id }
  get userId() { return this.s.user.id }
  /** Who made a change: the signed-in user, or null for QR-menu guests. */
  get actorId(): string | null { return this.session?.user.id || null }
  get business() { return this.s.business }

  can(p: Permission) { const perms = this.s.permissions; return perms === 'all' || perms.has(p) }
  requirePerm(p: Permission) { if (!this.can(p)) throw forbidden() }

  /** Branches the current view covers: the selected one, or all allowed ones in "All branches". */
  scope(): string[] { return this.s.branchId === ALL_BRANCHES ? this.s.allowed : [this.s.branchId] }
  inScope(branchId: string) { return this.scope().includes(branchId) }

  /** The branch a write goes to. "All branches" is read-only for day-to-day work. */
  writeBranch(opts: { fallback?: boolean; requested?: string | null } = {}): string {
    const s = this.s
    if (s.branchId !== ALL_BRANCHES) return s.branchId
    if (opts.requested && s.allowed.includes(opts.requested)) return opts.requested
    if (opts.fallback) return s.allowed.includes(s.user.branchId) ? s.user.branchId : s.allowed[0]
    throw new ApiError('Choose a branch first (top bar)')
  }

  /** Same rules as every write: no writes in support view, expired accounts are read-only, deactivated ones blocked. */
  assertWritable(opts: { readOnlyOk?: boolean } = {}) {
    const s = this.s
    if (s.support) throw new ApiError(SUPPORT_MESSAGE, 403, 'SUPPORT_VIEW')
    const st = subscriptionState(s.business, this.now)
    if (st.blocked) throw new ApiError(DEACTIVATED_MESSAGE, 403, 'DEACTIVATED')
    if (st.readOnly && !opts.readOnlyOk) throw new ApiError(READ_ONLY_MESSAGE, 403, 'READ_ONLY')
  }

  // ---------- product admin ----------
  requireAdmin(perm?: AdminPermission): AdminSession {
    if (!this.admin) throw new ApiError('Product admin sign-in required', 401, 'UNAUTHORIZED')
    if (perm && !adminCan(this.admin.role, perm)) throw forbidden(`Your admin role (${ADMIN_ROLES[this.admin.role].name}) can’t do this`)
    return this.admin
  }
}
