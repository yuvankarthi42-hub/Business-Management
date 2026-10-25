// Business settings, sign-up setup, branches, roles and staff logins.
import { COUNTRIES, normalizePhone } from '@/core/phone'
import { branchLimitMessage } from '@/core/subscription'
import { isHardware, isSupermarket, isTextile } from '@/core/config'
import { cleanStickers, stickerSettings } from '@/core/stickers'
import { cleanGstin, GST_STATES, gstinError } from '@/core/gst'
import { cleanLoyalty, loyaltyOf } from '@/core/loyalty'
import type { BillingSettings, Branch, BranchPrinter, Business, OrderType, Permission, Role, User } from '@/core/types'
import { PERMISSIONS } from '@/core/config'
import type { Ctx } from '../core/context'
import { ApiError, forbidden } from '../core/errors'
import { assertPassword, hashPassword } from '../core/passwords'
import { define, userRead, userWrite } from '../core/registry'
import { branchFrom, loadBusiness, PRINTER_DEFAULTS } from '../domain/business'
import { storeImage } from './catalog'
import { loadRoles, loadUsers, payColumns, setUserBranches } from '../domain/people'
import { saveUserWithLogins, syncBranchCount, syncOwner } from '../domain/directory'
import { bumpEpoch } from '../domain/session'
import { audit, code, E, getSetting, isId, keyPart, own, putSetting, readSequence, setSequence, str, toBp, type SeqName } from '../domain/util'

export function cleanPhone(input: string | null | undefined, iso: string | undefined, required?: string) {
  let v: string | null
  try { v = normalizePhone(input, iso || 'IN') } catch (e) { throw new ApiError((e as Error).message) }
  if (!v && required) throw new ApiError(required)
  return v ?? ''
}

async function freshBusiness(c: Ctx): Promise<Business> {
  const b = await loadBusiness(c, c.businessId)
  if (!b) throw new ApiError('Business not found', 404)
  return b.business
}

/** Next numbers can be raised but never lowered — a lower number would repeat bill numbers already printed. */
async function setSeqSafely(c: Ctx, branchId: string | null, name: SeqName, prefix: string | undefined, next: number | undefined) {
  const cur = await readSequence(c.db, c.businessId, branchId, name)
  const n = next !== undefined && Number.isFinite(next) ? Math.floor(next) : undefined
  await setSequence(c.db, c.businessId, branchId, name, {
    ...(prefix !== undefined ? { prefix: prefix.trim().slice(0, 20) } : {}),
    ...(n !== undefined && (!cur || n > Number(cur.next_value)) ? { next: n } : {}),
  })
}

async function saveBilling(c: Ctx, patch: Partial<BillingSettings>) {
  const { invoicePrefix, nextInvoiceNumber, orderPrefix, nextOrderNumber, nextKotNumber, creditNotePrefix, nextCreditNoteNumber, taxRates, defaultTaxRateId, wholesale, ...rest } = patch
  if (rest.mrpDiscounts !== undefined) rest.mrpDiscounts = rest.mrpDiscounts !== false
  if (Object.keys(rest).length) {
    const cur = await getSetting<Record<string, unknown>>(c.db, c.businessId, 'billing', {})
    await putSetting(c.db, c.businessId, 'billing', { ...cur, ...rest }, c.userId)
  }
  if (invoicePrefix !== undefined || nextInvoiceNumber !== undefined) await setSeqSafely(c, null, 'invoice', invoicePrefix, nextInvoiceNumber)
  if (orderPrefix !== undefined || nextOrderNumber !== undefined) await setSeqSafely(c, null, 'order', orderPrefix, nextOrderNumber)
  if (nextKotNumber !== undefined) await setSeqSafely(c, null, 'kot', undefined, nextKotNumber)
  if (creditNotePrefix !== undefined || nextCreditNoteNumber !== undefined) await setSeqSafely(c, null, 'credit_note', creditNotePrefix, nextCreditNoteNumber)

  if (taxRates) {
    const existing = await c.db.select('tax_rates', { where: { business_id: c.businessId } })
    const keep = new Set<string>()
    const idMap = new Map<string, string>() // id from the app → ROWID (new rates)
    for (const t of taxRates) {
      if (!String(t.name ?? '').trim()) throw new ApiError('Every tax rate needs a name')
      if (!(t.rate >= 0 && t.rate <= 100)) throw new ApiError('Tax rate must be between 0 and 100%')
      const ex = isId(t.id) ? existing.find((x) => x.ROWID === t.id) : undefined
      if (ex) { await c.db.update('tax_rates', ex.ROWID, { name: t.name.trim(), rate_bp: toBp(t.rate), is_active: true }); keep.add(ex.ROWID) }
      else { const r = await c.db.insert('tax_rates', { business_id: c.businessId, name: t.name.trim(), rate_bp: toBp(t.rate), is_inclusive: false, is_default: false, is_active: true }); keep.add(r.ROWID); idMap.set(t.id, r.ROWID) }
    }
    // Rates taken out of the list are hidden, not deleted — old bills and items still point at them.
    for (const x of existing) if (!keep.has(x.ROWID) && x.is_active !== false) await c.db.update('tax_rates', x.ROWID, { is_active: false, is_default: false })
    if (defaultTaxRateId !== undefined) patch.defaultTaxRateId = idMap.get(String(defaultTaxRateId)) ?? defaultTaxRateId
  }
  const def = patch.defaultTaxRateId ?? defaultTaxRateId
  if (def !== undefined) {
    const all = await c.db.select('tax_rates', { where: { business_id: c.businessId } })
    if (def && !all.some((x) => x.ROWID === def)) throw new ApiError('Choose a tax rate')
    for (const x of all) if (!!x.is_default !== (x.ROWID === def)) await c.db.update('tax_rates', x.ROWID, { is_default: x.ROWID === def })
  }
  if (wholesale) {
    const list = await c.db.first('price_lists', { business_id: c.businessId, is_default: false })
    const name = String(wholesale.label ?? '').trim() || 'Wholesale'
    if (list) await c.db.update('price_lists', list.ROWID, { name, is_active: !!wholesale.enabled, uniq_key: `${c.businessId}:${keyPart(name)}` })
    else await c.db.insert('price_lists', { business_id: c.businessId, name, is_default: false, is_active: !!wholesale.enabled, uniq_key: `${c.businessId}:${keyPart(name)}` })
  }
}

/** Default tax rate by percentage (sign-up picks 0 / 5 / 18 %). */
async function setDefaultTaxByRate(c: Ctx, rate: number) {
  const all = await c.db.select('tax_rates', { where: { business_id: c.businessId, is_active: true } })
  const pick = all.find((x) => Number(x.rate_bp) === toBp(rate)) ?? all[0]
  if (pick) await saveBilling(c, { defaultTaxRateId: pick.ROWID })
}

async function branchesWithCounts(c: Ctx) {
  const [rows, seqs, users, roles, tables] = await Promise.all([
    c.db.select('branches', { where: { business_id: c.businessId } }),
    c.db.select('sequences', { where: { business_id: c.businessId } }),
    loadUsers(c.db, c.businessId), loadRoles(c.db, c.businessId),
    c.db.aggregate('dining_tables', { where: { business_id: c.businessId, is_active: true }, groupBy: ['branch_id'], fns: { n: ['COUNT', 'ROWID'] } }),
  ])
  return rows.map((r) => {
    const b = branchFrom(r, seqs)
    const staff = users.filter((u) => u.active && ((roles.find((x) => x.id === u.roleId)?.permissions as string[] | undefined)?.includes('*') || (u.branchIds?.length ? u.branchIds : [u.branchId]).includes(b.id))).length
    return { ...b, staff, tables: Number(tables.find((t) => t.branch_id === b.id)?.n ?? 0) }
  })
}

define('business', {
  update: userWrite(async (c, patch: Partial<Business>) => {
    const b = c.business
    if (patch.defaultCountry && !COUNTRIES.some((x) => x.iso === patch.defaultCountry)) throw new ApiError('Unknown country')
    const row: Record<string, string | number | null> = {}
    if (patch.name !== undefined) { if (!patch.name.trim()) throw new ApiError('Enter your business name'); row.name = patch.name.trim().slice(0, 150) }
    if (patch.category !== undefined) row.category = code(E.BusinessCategory, patch.category)
    if (patch.subType !== undefined) row.sub_type = String(patch.subType).slice(0, 60)
    if (patch.address !== undefined) row.address = patch.address.slice(0, 255)
    if (patch.email !== undefined) row.email = patch.email.trim().slice(0, 150) || null
    if (patch.gstin !== undefined && cleanGstin(patch.gstin) !== cleanGstin(b.gstin)) {
      // Checked only when it changes, so a profile with an older GSTIN can still be saved.
      const err = gstinError(patch.gstin)
      if (err) throw new ApiError(err)
      row.gstin = cleanGstin(patch.gstin) || null
    }
    if (patch.defaultCountry !== undefined) row.country_code = patch.defaultCountry
    if (patch.currency !== undefined) row.currency_code = patch.currency.slice(0, 3)
    if (patch.currencySymbol !== undefined) row.currency_symbol = patch.currencySymbol.slice(0, 5)
    if (patch.timezone !== undefined) row.timezone = patch.timezone.slice(0, 40)
    if (patch.phone !== undefined) row.phone = cleanPhone(patch.phone, patch.defaultCountry ?? b.defaultCountry) || null
    if (patch.terminology) await putSetting(c.db, b.id, 'terminology', patch.terminology, c.userId)
    if (patch.modules) await putSetting(c.db, b.id, 'modules', patch.modules, c.userId)
    if (patch.qr) await putSetting(c.db, b.id, 'qr', patch.qr, c.userId)
    if (patch.stateCode !== undefined) {
      if (patch.stateCode && !GST_STATES[patch.stateCode]) throw new ApiError('Choose a state')
      await putSetting(c.db, b.id, 'gst', { stateCode: patch.stateCode || '' }, c.userId)
    }
    if (patch.loyalty) {
      let l
      try { l = cleanLoyalty(patch.loyalty, loyaltyOf(b)) } catch (e) { throw new ApiError((e as Error).message) }
      await putSetting(c.db, b.id, 'loyalty', l, c.userId)
    }
    if (patch.stickers) {
      let st
      try { st = cleanStickers(patch.stickers, stickerSettings(b)) } catch (e) { throw new ApiError((e as Error).message) }
      await putSetting(c.db, b.id, 'stickers', st, c.userId)
    }
    if (patch.billing) await saveBilling(c, patch.billing)
    await audit(c, 'settings', b.id, 'update', Object.keys(patch).join(', '))
    await bumpEpoch(c, b.id)
    // The businesses row is in the platform database: written last, after every check above has passed.
    if (Object.keys(row).length) await c.platform.update('businesses', b.id, row)
    return freshBusiness(c)
  }, { perm: 'settings.manage' }),
  /** Shop logo, compressed in the browser (≤ 80 KB, 512 px). null removes it — the Kadai Kalanjiyam logo shows again. */
  setLogo: userWrite(async (c, input: { image: string; width?: number; height?: number; quality?: number; originalBytes?: number } | null) => {
    const old = await getSetting<{ logoKey?: string; mediaId?: string }>(c.db, c.businessId, 'brand', {})
    const img = input ? await storeImage(c, 'logo', input) : null
    const key = img ? c.files.keyOf(img.url) : null
    await putSetting(c.db, c.businessId, 'brand', img && key ? { logoKey: key, mediaId: img.id } : {}, c.userId)
    await c.platform.update('businesses', c.businessId, { logo_media_id: img?.id ?? null })
    // The old file is removed only after the new one is saved.
    if (old.logoKey && old.logoKey !== key) {
      await c.files.remove(old.logoKey)
      if (old.mediaId) await c.db.delete('media_files', old.mediaId).catch(() => {})
    }
    await audit(c, 'settings', c.businessId, 'update', img ? 'logo uploaded' : 'logo removed')
    await bumpEpoch(c, c.businessId)
    return freshBusiness(c)
  }, { perm: 'settings.manage', tx: 'none' }),

  /**
   * Sign-up setup, saved before items are added so the normal product form can be used.
   * Safe to call again (user goes Back and changes things): categories and tables are synced.
   */
  saveSetup: userWrite(async (c, input: {
    name: string; category: Business['category']; subType: string; modules: Business['modules']; terminology: Business['terminology']; orderTypes: OrderType[]
    categories: { id?: string; name: string; emoji: string }[]; tables: { floor: string; count: number; seats: number }[]
  }) => {
    if (!String(input.name ?? '').trim()) throw new ApiError('Enter your business name')
    const probe = { category: input.category, subType: input.subType }
    const modules = { ...input.modules, ...(isHardware(probe) ? { mobileOrders: true, customerOrders: true } : {}) }
    await c.platform.update('businesses', c.businessId, { name: input.name.trim().slice(0, 150), category: code(E.BusinessCategory, input.category), sub_type: String(input.subType).slice(0, 60) })
    await putSetting(c.db, c.businessId, 'modules', modules, c.userId)
    await putSetting(c.db, c.businessId, 'terminology', input.terminology, c.userId)
    // MRP / shelf prices include GST in supermarkets and textile shops (MRP on the sticker is what the customer pays).
    await saveBilling(c, { orderTypes: input.orderTypes, taxMode: isSupermarket(probe) || isTextile(probe) ? 'inclusive' : 'exclusive' })
    await setDefaultTaxByRate(c, isHardware(probe) ? 18 : isTextile(probe) ? 5 : input.category === 'retail' ? 0 : 5)

    // Categories: update kept ones, add new ones, remove the ones taken out of the list.
    const cats = await c.db.select('categories', { where: { business_id: c.businessId } })
    const seen = new Set<string>()
    const ids: (string | null)[] = []
    let sort = 0
    for (const x of input.categories ?? []) {
      const name = String(x.name ?? '').trim()
      if (!name || seen.has(name.toLowerCase())) { ids.push(null); continue }
      seen.add(name.toLowerCase())
      const ex = x.id && isId(x.id) ? cats.find((k) => k.ROWID === x.id) : undefined
      const data = { name: name.slice(0, 80), emoji: (x.emoji || '⭐').slice(0, 8), sort_order: sort++, is_active: true, uniq_key: `${c.businessId}:${keyPart(name)}` }
      if (ex) { await c.db.update('categories', ex.ROWID, data); ids.push(ex.ROWID) }
      else {
        const clash = cats.find((k) => k.uniq_key === data.uniq_key)
        if (clash) { await c.db.update('categories', clash.ROWID, data); ids.push(clash.ROWID) }
        else ids.push((await c.db.insert('categories', { business_id: c.businessId, ...data })).ROWID)
      }
    }
    const keep = new Set(ids.filter(Boolean) as string[])
    if (!keep.size) throw new ApiError('Add at least one category')
    const removed = cats.filter((k) => !keep.has(k.ROWID)).map((k) => k.ROWID)
    if (removed.length) await c.db.deleteMany('categories', removed) // products.category_id is cleared (On Delete = Null)

    // Tables: T1, T2… across the areas. Rebuilt while no bill uses a table yet.
    const used = await c.db.first('orders', { business_id: c.businessId, table_id: { ne: null } })
    if (!used) {
      const old = await c.db.select('dining_tables', { where: { business_id: c.businessId } })
      if (old.length) await c.db.deleteMany('dining_tables', old.map((t) => t.ROWID))
      if (modules.tables) {
        const branchId = c.writeBranch({ fallback: true })
        const rows: Record<string, string | number | boolean>[] = []
        for (const area of input.tables ?? []) {
          const count = Math.floor(Number(area.count))
          if (!(count >= 1)) continue
          if (rows.length + count > 200) throw new ApiError('Up to 200 tables can be added here — add more later in Settings → Tables')
          for (let i = 0; i < count; i++) {
            const label = `T${rows.length + 1}`
            rows.push({ business_id: c.businessId, branch_id: branchId, label, area: String(area.floor ?? '').trim().slice(0, 40) || 'Main', seats: Math.max(1, Math.floor(Number(area.seats)) || 4), is_active: true, uniq_key: `${branchId}:${label.toLowerCase()}` })
          }
        }
        if (rows.length) await c.db.insertMany('dining_tables', rows)
      }
    }
    await audit(c, 'settings', c.businessId, 'update', `setup: ${input.subType} · ${keep.size} categories`)
    await bumpEpoch(c, c.businessId)
    return { categoryIds: ids }
  }, { perm: 'settings.manage' }),

  /** Last sign-up step: the app opens normally from now on. */
  finishOnboarding: userWrite(async (c) => {
    if (!c.business.name.trim()) throw new ApiError('Enter your business name')
    await c.platform.update('businesses', c.businessId, { onboarded_at: c.now.toISOString() })
    await audit(c, 'settings', c.businessId, 'update', `onboarded: ${c.business.name}`)
    await bumpEpoch(c, c.businessId)
    return freshBusiness(c)
  }, { perm: 'settings.manage' }),
})

define('branches', {
  /** One branch's printer setup. Cashiers may set up the printer of a branch they work in. */
  savePrinter: userWrite(async (c, branchId: string, patch: Partial<BranchPrinter>) => {
    if (!c.can('settings.manage') && !c.can('billing.create')) throw forbidden('You don’t have permission to change the printer')
    const br = await own(c, 'branches', branchId, 'Branch not found')
    if (!c.s.allowed.includes(br.ROWID)) throw new ApiError('Branch not found', 404)
    const cur: BranchPrinter = { ...PRINTER_DEFAULTS, ...JSON.parse(str(br.printer_json) || '{}') }
    const next: BranchPrinter = { ...cur }
    if (patch.transport && ['browser', 'usb', 'serial', 'bluetooth'].includes(patch.transport)) next.transport = patch.transport
    if (patch.paper !== undefined) next.paper = patch.paper === '58mm' || patch.paper === '80mm' ? patch.paper : null
    if (patch.mode && ['auto', 'text', 'image'].includes(patch.mode)) next.mode = patch.mode
    if (patch.copies !== undefined) next.copies = Math.min(3, Math.max(1, Math.round(patch.copies)))
    if (patch.baudRate !== undefined) next.baudRate = [9600, 19200, 38400, 57600, 115200].includes(patch.baudRate) ? patch.baudRate : cur.baudRate
    for (const k of ['autoPrint', 'cut', 'drawer'] as const) if (patch[k] !== undefined) next[k] = !!patch[k]
    const saved = { ...next, updatedAt: c.now.toISOString(), updatedBy: c.userId }
    await c.db.update('branches', br.ROWID, { printer_json: JSON.stringify(saved) })
    await audit(c, 'branch', br.ROWID, 'printer', `${str(br.name)}: ${next.transport}${next.autoPrint ? ', auto print' : ''}`, br.ROWID)
    await bumpEpoch(c, c.businessId)
    return saved
  }),

  list: userRead(async (c) => branchesWithCounts(c)),

  save: userWrite(async (c, input: Partial<Branch> & { name: string }) => {
    const name = String(input.name ?? '').trim()
    if (!name) throw new ApiError('Enter a branch name')
    const all = await c.db.select('branches', { where: { business_id: c.businessId } })
    const prefix = String(input.invoicePrefix ?? '').trim().toUpperCase().slice(0, 10)
    if (prefix && all.some((b) => b.ROWID !== input.id && str(b.invoice_prefix).toUpperCase() === prefix)) throw new ApiError(`Bill prefix ${prefix} is already used by another branch`)
    const ex = input.id ? all.find((b) => b.ROWID === input.id) : undefined
    if (input.id && !ex) throw new ApiError('Branch not found', 404)
    if (ex) {
      if (ex.is_default && input.active === false) throw new ApiError('The main branch can’t be closed')
      await c.db.update('branches', ex.ROWID, {
        name: name.slice(0, 120), address: input.address !== undefined ? input.address.slice(0, 255) : str(ex.address),
        phone: input.phone !== undefined ? cleanPhone(input.phone, c.business.defaultCountry) || null : (ex.phone as string | null),
        is_active: input.active ?? ex.is_active !== false, invoice_prefix: prefix || (ex.invoice_prefix as string | null),
      })
      if ((prefix || ex.invoice_prefix) && (input.nextInvoiceNumber !== undefined || prefix)) await setSeqSafely(c, ex.ROWID, 'invoice', prefix || str(ex.invoice_prefix), input.nextInvoiceNumber)
      await audit(c, 'branch', ex.ROWID, 'update', name, ex.ROWID)
      await bumpEpoch(c, c.businessId)
      return (await branchesWithCounts(c)).find((b) => b.id === ex.ROWID)
    }
    const max = c.business.maxBranches ?? 1
    if (all.length >= max) throw new ApiError(branchLimitMessage(max))
    let auto = prefix || `${name.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || 'BR'}-`
    if (all.some((b) => str(b.invoice_prefix).toUpperCase() === auto)) auto = `${auto.slice(0, -1)}${all.length + 1}-`
    const nb = await c.db.insert('branches', { business_id: c.businessId, name: name.slice(0, 120), address: (input.address ?? '').slice(0, 255), phone: cleanPhone(input.phone, c.business.defaultCountry) || null, is_default: false, is_active: true, invoice_prefix: auto })
    await setSequence(c.db, c.businessId, nb.ROWID, 'invoice', { prefix: auto, next: input.nextInvoiceNumber ?? 10001 })
    await audit(c, 'branch', nb.ROWID, 'create', name, nb.ROWID)
    await bumpEpoch(c, c.businessId)
    await syncBranchCount(c, c.businessId)
    return (await branchesWithCounts(c)).find((b) => b.id === nb.ROWID)
  }, { perm: 'settings.manage' }),

  /** Demo-only: sample branches with sample data exist only in the demo app. */
  addDemo: userWrite(async () => { throw new ApiError('Sample branches are only available in the demo app') }, { perm: 'settings.manage' }),
})

const VALID_PERMS = new Set(PERMISSIONS.map((p) => p.key))

define('roles', {
  list: userRead(async (c) => loadRoles(c.db, c.businessId)),
  save: userWrite(async (c, role: Omit<Role, 'businessId' | 'id'> & { id?: string }) => {
    const name = String(role.name ?? '').trim()
    if (!name) throw new ApiError('Enter a role name')
    const perms = ((role.permissions ?? []) as string[]).filter((p) => VALID_PERMS.has(p as Permission))
    let row = role.id ? await own(c, 'roles', role.id, 'Role not found') : null
    if (row) {
      if (Number(row.system_key) === E.RoleKey.owner) throw new ApiError('Owner role always has full access')
      await c.db.update('roles', row.ROWID, { name: name.slice(0, 60), uniq_key: `${c.businessId}:${keyPart(name)}` })
    } else {
      row = await c.db.insert('roles', { business_id: c.businessId, name: name.slice(0, 60), system_key: null, is_all_access: false, uniq_key: `${c.businessId}:${keyPart(name)}` })
    }
    const cur = await c.db.select('role_permissions', { where: { role_id: row.ROWID } })
    const want = new Set(perms)
    const drop = cur.filter((p) => !want.has(str(p.permission))).map((p) => p.ROWID)
    if (drop.length) await c.db.deleteMany('role_permissions', drop)
    const have = new Set(cur.map((p) => str(p.permission)))
    const add = perms.filter((p) => !have.has(p))
    if (add.length) await c.db.insertMany('role_permissions', add.map((p) => ({ role_id: row!.ROWID, permission: p, uniq_key: `${row!.ROWID}:${p}` })))
    await audit(c, 'role', row.ROWID, role.id ? 'update' : 'create', name)
    await bumpEpoch(c, c.businessId)
    return (await loadRoles(c.db, c.businessId)).find((r) => r.id === row!.ROWID)
  }, { perm: 'users.manage' }),
  remove: userWrite(async (c, id: string) => {
    const r = await own(c, 'roles', id, 'Role not found')
    if (r.system_key != null) throw new ApiError('Built-in roles cannot be deleted')
    if (await c.db.first('users', { business_id: c.businessId, role_id: r.ROWID })) throw new ApiError('Role is assigned to staff — reassign them first')
    await c.db.delete('roles', r.ROWID)
    await bumpEpoch(c, c.businessId)
  }, { perm: 'users.manage' }),
})

define('users', {
  list: userRead(async (c) => loadUsers(c.db, c.businessId)),
  save: userWrite(async (c, u: Partial<User> & { name: string; phone: string; roleId: string }) => {
    const name = String(u.name ?? '').trim()
    if (!name) throw new ApiError('Enter the name')
    const existing0 = u.id ? await own(c, 'users', u.id, 'User not found') : null
    // Staff who don't use the app (cleaners, helpers): no role, no password, never sign in.
    const canLogin = u.canLogin === undefined ? (existing0 ? existing0.can_login !== false : true) : u.canLogin !== false
    if (!canLogin && existing0?.ROWID === c.userId) throw new ApiError('You can’t turn off app access for yourself')
    if (!canLogin && existing0?.username) throw new ApiError('The owner’s login can’t be turned into a staff member without app access')
    const phone = cleanPhone(u.phone, c.business.defaultCountry, canLogin ? 'Enter the mobile number (used to sign in)' : 'Enter the mobile number')
    const clash = await c.db.first('users', { phone })
    if (clash && clash.ROWID !== u.id) throw new ApiError('Mobile number already used by another user')
    const roleId = canLogin ? (await own(c, 'roles', u.roleId, 'Choose a role')).ROWID : (u.roleId ? (await own(c, 'roles', u.roleId, 'Choose a role')).ROWID : null)
    const email = String(u.email ?? '').trim().toLowerCase()
    if (email && !/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email)) throw new ApiError('Enter a valid email')
    const branchList = (u.branchIds?.length ? u.branchIds : [c.writeBranch({ fallback: true })]).filter((id) => c.s.allBranches.some((b) => b.id === id))
    if (!branchList.length) throw new ApiError('Select at least one branch')
    const existing = existing0
    if (existing && existing.ROWID === c.userId && u.active === false) throw new ApiError('You can’t turn off your own login')
    // A password is needed for a new login, or when app access is turned on for someone who had none.
    const needsPassword = canLogin && (!existing || !existing.password_hash || existing.can_login === false)
    if (needsPassword) assertPassword(u.password)
    else if (canLogin && u.password) assertPassword(u.password)
    const hash = canLogin && u.password ? await hashPassword(u.password) : null
    // Without app access nothing is a sign-in name, so the mobile / email can't be used to sign in (and are freed).
    const logins = canLogin ? { username: existing ? str(existing.username) || null : null, phone, email: email || null } : { username: null, phone: null, email: null }
    const losesAccess = !!existing && !canLogin && existing.can_login !== false
    const row = await saveUserWithLogins(c, c.businessId, existing, logins, async () => {
      if (existing) {
        const patch: Record<string, string | number | boolean | null> = { name: name.slice(0, 120), phone, email: email || null, role_id: roleId, is_active: u.active ?? existing.is_active !== false, default_branch_id: branchList[0], can_login: canLogin }
        if (hash) { patch.password_hash = hash; patch.token_version = Number(existing.token_version ?? 1) + 1 }
        if (!canLogin) patch.password_hash = null
        if ((u.active === false && existing.is_active !== false) || losesAccess) patch.token_version = Number(existing.token_version ?? 1) + 1 // signs them out everywhere
        const saved = await c.db.update('users', existing.ROWID, patch)
        if (u.branchIds) await setUserBranches(c.db, existing.ROWID, branchList)
        await audit(c, 'user', existing.ROWID, 'update', name)
        return saved
      }
      const made = await c.db.insert('users', {
        business_id: c.businessId, role_id: roleId, default_branch_id: branchList[0], name: name.slice(0, 120), phone, email: email || null,
        password_hash: hash, can_login: canLogin, must_change_password: false, is_active: true, ...payColumns(u.pay),
      })
      await setUserBranches(c.db, made.ROWID, branchList)
      await audit(c, 'user', made.ROWID, 'create', name)
      return made
    })
    // The owner's details are copied to the platform for the product admin's list.
    if (c.business && row.ROWID === (await c.platform.get('businesses', c.businessId))?.owner_user_id) await syncOwner(c, c.businessId, row)
    await bumpEpoch(c, c.businessId)
    return (await loadUsers(c.db, c.businessId)).find((x) => x.id === row!.ROWID)
  }, { perm: 'users.manage' }),
})
