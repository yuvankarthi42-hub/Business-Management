// Product admin: customer accounts (create with owner login, edit, password, renew, branch limit, status, delete).
import { normalizePhone } from '@/core/phone'
import { featuresFor } from '@/core/features'
import type { Ctx } from '../../core/context'
import { ApiError } from '../../core/errors'
import { assertPassword, hashPassword } from '../../core/passwords'
import { adminRead, adminWrite, define } from '../../core/registry'
import type { Row } from '../../db/types'
import { seedTaxRates } from '../../domain/business'
import { seedRoles } from '../../domain/people'
import { claimLogins, loginFree, saveUserWithLogins, syncOwner } from '../../domain/directory'
import { bumpEpoch, featureFlags, pricePerBranch } from '../../domain/session'
import { code, E, str, strOrNull } from '../../domain/util'
import { addPeriod, adminLog, adminLogFrom, businessLite, checkBranches, checkUsername, findBiz, fmtDay, ownerOf, periodFor, periodFrom, type Validity } from './shared'

function cleanEmail(input: string | undefined) {
  const email = String(input ?? '').trim().toLowerCase()
  if (email && (email.length > 150 || !/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email))) throw new ApiError('Enter a valid email')
  return email
}

function cleanPhone(input: string | undefined, iso: string, required?: string) {
  let v: string | null
  try { v = normalizePhone(input, iso || 'IN') } catch (e) { throw new ApiError((e as Error).message) }
  if (!v && required) throw new ApiError(required)
  return v ?? ''
}

/** One row of the admin customer list — from the directory copies on the businesses rows (no shop reads). */
async function customerRows(c: Ctx, businesses: Row[]) {
  if (!businesses.length) return []
  const price = await pricePerBranch(c.platform)
  return businesses.map((r) => {
    const b = businessLite(r)
    return {
      id: b.id, name: b.name || '(setup not finished)', category: b.category, subType: b.subType, onboarded: b.onboarded, createdAt: b.createdAt,
      ownerName: str(r.owner_name), username: str(r.owner_username), phone: str(r.owner_phone) || b.phone, email: str(r.owner_email),
      status: b.status, state: b.st.state, daysLeft: b.st.daysLeft, startAt: b.st.startAt, endAt: b.st.endAt,
      maxBranches: b.maxBranches, branchesUsed: Number(r.branches_used ?? 0),
      monthlyPrice: b.maxBranches * price,
      lastActivity: strOrNull(r.last_activity_at),
      lastLoginAt: strOrNull(r.last_login_at),
    }
  })
}
export type CustomerRow = Awaited<ReturnType<typeof customerRows>>[number]

define('admin', {
  customers: adminRead('customers.view', async (c) => {
    const rows = await c.platform.select('businesses', { where: { deleted_at: null } })
    return (await customerRows(c, rows)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }),

  customer: adminRead('customers.view', async (c, id: string) => {
    const r = await findBiz(c, id)
    const [row] = await customerRows(c, [r])
    const b = businessLite(r)
    const shop = await c.shopDb(r.ROWID)
    const [branches, billsByBranch, staff, products, customers, periods, history, flags, wa, lastBill] = await Promise.all([
      shop.select('branches', { where: { business_id: r.ROWID } }),
      shop.aggregate('orders', { where: { business_id: r.ROWID, status: E.OrderStatus.completed }, groupBy: ['branch_id'], fns: { n: ['COUNT', 'ROWID'] } }),
      shop.count('users', { business_id: r.ROWID, is_active: true }),
      shop.count('products', { business_id: r.ROWID }),
      shop.count('customers', { business_id: r.ROWID }),
      c.platform.select('subscription_periods', { where: { business_id: r.ROWID }, orderBy: [['CREATEDTIME', 'DESC']] }),
      c.platform.select('admin_audit_logs', { where: { business_id: r.ROWID }, orderBy: [['CREATEDTIME', 'DESC']], limit: 300 }),
      featureFlags(c.platform),
      shop.first('whatsapp_accounts', { business_id: r.ROWID }),
      shop.aggregate('orders', { where: { business_id: r.ROWID }, fns: { last: ['MAX', 'CREATEDTIME'] } }),
    ])
    row.branchesUsed = branches.length
    row.lastActivity = strOrNull(lastBill[0]?.last as string) ?? row.lastActivity
    const bills = billsByBranch.reduce((a, x) => a + Number(x.n), 0)
    return {
      ...row, address: b.address, gstin: b.gstin, adminNote: b.adminNote,
      branches: branches.map((x) => ({ id: x.ROWID, name: str(x.name), active: x.is_active !== false, isDefault: !!x.is_default, bills: Number(billsByBranch.find((y) => y.branch_id === x.ROWID)?.n ?? 0) })),
      usage: { staff, products, customers, bills },
      periods: periods.map(periodFrom),
      history: history.map(adminLogFrom),
      features: featuresFor(flags, r.ROWID),
      whatsappState: !wa ? 'not_set_up' : Number(wa.status) === E.WaAccountStatus.connected ? 'connected' : 'incomplete',
    }
  }),

  /**
   * New customer: the businesses row (platform), its own database, then — in one transaction there — the main
   * branch, roles, tax rates and the owner login. Any failure removes everything made so far, so the admin
   * can simply try again.
   */
  createCustomer: {
    access: 'admin', write: true, adminPerm: 'customers.create', tx: 'none',
    run: async (c: Ctx, input: { businessName: string; ownerName: string; username: string; password: string; phone: string; email?: string; validity: Validity; maxBranches: number; note?: string }) => {
      const a = c.requireAdmin()
      const businessName = String(input?.businessName ?? '').trim().slice(0, 150), ownerName = String(input?.ownerName ?? '').trim().slice(0, 120)
      if (!businessName) throw new ApiError('Enter the business name')
      if (!ownerName) throw new ApiError('Enter the owner’s name')
      const username = await checkUsername(c, input.username)
      assertPassword(input.password)
      const maxBranches = checkBranches(input.maxBranches)
      const phone = cleanPhone(input.phone, 'IN', 'Enter the owner’s mobile number — it is their login ID')
      if (!(await loginFree(c, 'phone', phone))) throw new ApiError('This mobile number is already used by another account')
      const email = cleanEmail(input.email)
      const { startAt, endAt, months } = periodFor(input.validity, c.now)
      const hash = await hashPassword(input.password)

      // The shop starts as a fast-food outlet; the owner picks the real type in the sign-up steps.
      const biz = await c.platform.insert('businesses', {
        name: businessName, category: code(E.BusinessCategory, 'food'), sub_type: 'Fast Food', phone, email: email || null, status: E.BusinessStatus.active,
        max_branches: maxBranches, subscription_start_at: startAt, subscription_end_at: endAt, admin_note: (input.note ?? '').trim().slice(0, 255) || null,
        owner_name: ownerName, owner_username: username, owner_phone: phone, owner_email: email || null, branches_used: 1,
      })
      let claim: Awaited<ReturnType<typeof claimLogins>> | null = null
      try {
        claim = await claimLogins(c, biz.ROWID, null, { username, phone, email: email || null })
        await c.dbs.createShop(biz.ROWID)
        await c.useShop(biz.ROWID)
        const owner = await c.tx(async () => {
          const branch = await c.db.insert('branches', { business_id: biz.ROWID, name: 'Main', is_default: true, is_active: true })
          const roles = await seedRoles(c.db, biz.ROWID)
          await seedTaxRates(c.db, biz.ROWID, 'food')
          return c.db.insert('users', {
            business_id: biz.ROWID, role_id: roles[0].id, default_branch_id: branch.ROWID, name: ownerName, phone, email: email || null, username,
            password_hash: hash, must_change_password: false, is_active: true,
          })
        })
        await claim.bind(owner.ROWID)
        await c.platform.update('businesses', biz.ROWID, { owner_user_id: owner.ROWID })
        await addPeriod(c, a, biz.ROWID, maxBranches, 'new', startAt, endAt, months, input.note ?? '')
      } catch (e) {
        // Remove the half-made customer (its database first: deleting the row would forget where it is).
        await claim?.undo()
        await c.dbs.dropShop(biz.ROWID).catch((x) => console.error('[createCustomer] drop shop', x))
        await c.platform.delete('businesses', biz.ROWID).catch((x) => console.error('[createCustomer] delete row', x))
        throw e
      }
      await adminLog(c, a, 'create', { id: biz.ROWID, name: businessName }, `Username ${username} · ${maxBranches} branch${maxBranches === 1 ? '' : 'es'} · valid till ${fmtDay(endAt)}`)
      return { id: biz.ROWID, username }
    },
  },

  updateCustomer: {
    access: 'admin', write: true, adminPerm: 'customers.edit', tx: 'none',
    run: async (c: Ctx, id: string, patch: { businessName?: string; ownerName?: string; username?: string; phone?: string; email?: string; adminNote?: string }) => {
      const a = c.requireAdmin()
      const r = await findBiz(c, id)
      const owner = await ownerOf(c, r.ROWID)
      const changed: string[] = []
      const bizPatch: Record<string, string | null> = {}
      if (patch.businessName !== undefined && patch.businessName.trim() !== str(r.name)) {
        if (!patch.businessName.trim()) throw new ApiError('Enter the business name')
        bizPatch.name = patch.businessName.trim().slice(0, 150); changed.push('business name')
      }
      if (patch.adminNote !== undefined && patch.adminNote !== str(r.admin_note)) { bizPatch.admin_note = patch.adminNote.slice(0, 255) || null; changed.push('note') }
      if (owner) {
        const up: Record<string, string | null> = {}
        const self = { businessId: r.ROWID, userId: owner.ROWID }
        if (patch.ownerName !== undefined && patch.ownerName.trim() && patch.ownerName.trim() !== str(owner.name)) { up.name = patch.ownerName.trim().slice(0, 120); changed.push('owner name') }
        if (patch.username !== undefined && patch.username.trim().toLowerCase() !== str(owner.username)) { up.username = await checkUsername(c, patch.username, self); changed.push(`username → ${up.username}`) }
        if (patch.phone !== undefined) {
          const phone = cleanPhone(patch.phone, str(r.country_code) || 'IN', 'The owner’s mobile number is their login ID and can’t be empty')
          if (phone !== str(owner.phone)) {
            if (!(await loginFree(c, 'phone', phone, self))) throw new ApiError('This mobile number is already used by another account')
            up.phone = phone; changed.push('mobile')
          }
        }
        if (patch.email !== undefined && patch.email.trim().toLowerCase() !== str(owner.email)) { up.email = cleanEmail(patch.email) || null; changed.push('email') }
        if (Object.keys(up).length) {
          const next = { username: 'username' in up ? up.username : strOrNull(owner.username), phone: 'phone' in up ? up.phone : strOrNull(owner.phone), email: 'email' in up ? up.email : strOrNull(owner.email) }
          const shop = await c.shopDb(r.ROWID)
          const saved = await saveUserWithLogins(c, r.ROWID, owner, next, () => shop.update('users', owner.ROWID, up))
          await syncOwner(c, r.ROWID, saved)
        }
      }
      if (Object.keys(bizPatch).length) await c.platform.update('businesses', r.ROWID, bizPatch)
      if (changed.length) { await adminLog(c, a, 'update', { id: r.ROWID, name: bizPatch.name ?? str(r.name) }, changed.join(', ')); await bumpEpoch(c, r.ROWID) }
      return businessLite(await findBiz(c, r.ROWID))
    },
  },

  resetPassword: adminWrite('customers.password', async (c, id: string, password: string) => {
    const a = c.requireAdmin()
    const r = await findBiz(c, id)
    const owner = await ownerOf(c, r.ROWID)
    if (!owner) throw new ApiError('This customer has no owner login')
    assertPassword(password)
    // A new token version signs the owner out on every device.
    await (await c.shopDb(r.ROWID)).update('users', owner.ROWID, { password_hash: await hashPassword(password), token_version: Number(owner.token_version ?? 1) + 1, failed_logins: 0, locked_until: null, password_changed_at: c.now.toISOString() })
    await adminLog(c, a, 'password', { id: r.ROWID, name: str(r.name) }, `Password reset for ${str(owner.username) || str(owner.name)}`)
    await bumpEpoch(c, r.ROWID)
  }),

  /** Renew or extend. Months are added to the current end date while it's still valid, otherwise from today. */
  renew: adminWrite('customers.renew', async (c, id: string, validity: Validity, note = '') => {
    const a = c.requireAdmin()
    const r = await findBiz(c, id)
    const b = businessLite(r)
    const from = b.st.readOnly || !b.subscription ? c.now : new Date(new Date(b.subscription.endAt).getTime() + 1)
    const p = periodFor(validity, from)
    if (new Date(p.endAt) <= c.now) throw new ApiError('Choose an end date in the future')
    const kind = b.st.readOnly ? 'renew' : 'extend'
    const startAt = b.st.readOnly || !b.subscription ? p.startAt : b.subscription.startAt
    await addPeriod(c, a, r.ROWID, b.maxBranches, kind, p.startAt, p.endAt, p.months, note)
    await c.platform.update('businesses', r.ROWID, { subscription_start_at: startAt, subscription_end_at: p.endAt })
    await adminLog(c, a, 'renew', b, `${kind === 'renew' ? 'Renewed' : 'Extended'}${p.months ? ` by ${p.months} month${p.months === 1 ? '' : 's'}` : ''} · valid till ${fmtDay(p.endAt)}${note ? ` · ${note}` : ''}`)
    await bumpEpoch(c, r.ROWID)
    return { startAt, endAt: p.endAt }
  }),

  setBranchLimit: adminWrite('customers.branches', async (c, id: string, max: number) => {
    const a = c.requireAdmin()
    const r = await findBiz(c, id)
    const n = checkBranches(max)
    const used = await (await c.shopDb(r.ROWID)).count('branches', { business_id: r.ROWID })
    if (n < used) throw new ApiError(`This customer already has ${used} branches. The limit can’t be lower than that.`)
    const before = Number(r.max_branches ?? 1)
    if (n === before) return n
    await c.platform.update('businesses', r.ROWID, { max_branches: n })
    await adminLog(c, a, 'branch_limit', { id: r.ROWID, name: str(r.name) }, `Branch limit ${before} → ${n} (${(await pricePerBranch(c.platform)) * n}/month from next renewal)`)
    await bumpEpoch(c, r.ROWID)
    return n
  }),

  setStatus: adminWrite('customers.status', async (c, id: string, status: 'active' | 'deactivated', reason = '') => {
    const a = c.requireAdmin()
    const r = await findBiz(c, id)
    if (!['active', 'deactivated'].includes(status)) throw new ApiError('Unknown status')
    if (Number(r.status) === code(E.BusinessStatus, status)) return
    await c.platform.update('businesses', r.ROWID, { status: code(E.BusinessStatus, status) })
    await adminLog(c, a, status === 'active' ? 'activate' : 'deactivate', { id: r.ROWID, name: str(r.name) }, reason || (status === 'active' ? 'Account activated' : 'Account deactivated'))
    await bumpEpoch(c, r.ROWID)
  }),

  /**
   * Permanently removes the customer: its own database (one per shop), or with one database the cascade from
   * the businesses row. The platform rows that belong to it (periods, sign-in names, tickets) go with the
   * businesses row. Needs the exact business name. Safe to try again if it stops half-way.
   */
  deleteCustomer: {
    access: 'admin', write: true, adminPerm: 'customers.delete', tx: 'none',
    run: async (c: Ctx, id: string, confirmName: string) => {
      const a = c.requireAdmin()
      const r = await findBiz(c, id)
      if (String(confirmName ?? '').trim() !== str(r.name)) throw new ApiError('Type the business name exactly to confirm')
      const where = { business_id: r.ROWID }
      let counts = [0, 0, 0, 0]
      try {
        const shop = await c.shopDb(r.ROWID)
        counts = await Promise.all([shop.count('orders', where), shop.count('products', where), shop.count('customers', where), shop.count('users', where)])
      } catch { /* the shop's database may already be gone (an earlier try) */ }
      const [orders, products, customers, users] = counts
      // Log first: the log row keeps the business name, and its business_id is cleared by the delete (On Delete = Null).
      await adminLog(c, a, 'delete', { id: r.ROWID, name: str(r.name) }, `Deleted permanently: ${orders} orders, ${products} products, ${customers} customers, ${users} users`)
      // Signed-in devices stop at once: no businesses row, and (one database per shop) no database.
      await c.platform.update('businesses', r.ROWID, { status: E.BusinessStatus.deactivated })
      if (!c.dbs.perShop) await bumpEpoch(c, r.ROWID)
      await c.dbs.dropShop(r.ROWID)
      await c.platform.delete('businesses', r.ROWID)
    },
  },
})
