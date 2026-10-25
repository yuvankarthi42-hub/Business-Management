// Business ⇄ tables: businesses + business_settings (JSON) + tax_rates + sequences + price_lists.
// Produces exactly the `Business` / `Branch` shapes the app already uses (src/core/types.ts).
import type { BillingSettings, Branch, BranchPrinter, Business, LoyaltySettings, ModuleConfig, QrSettings, StickerSettings, Terminology } from '@/core/types'
import { DEFAULT_TERMS, modulesFor, templateFor } from '@/core/config'
import type { Db, Row } from '../db/types'
import type { Files } from '../core/files'
import { code, E, fromBp, json, nameOf, str, strOrNull, toBp, type SeqName } from './util'

export const LOGO_EMOJI: Record<Business['category'], string> = { food: '🍔', restaurant: '🍽️', retail: '🛒', service: '✂️' }

/** Stored in business_settings 'billing' (prefixes and next numbers live in sequences, tax rates in tax_rates). */
type BillingJson = Omit<BillingSettings, 'invoicePrefix' | 'nextInvoiceNumber' | 'orderPrefix' | 'nextOrderNumber' | 'nextKotNumber' | 'taxRates' | 'defaultTaxRateId' | 'wholesale' | 'creditNotePrefix' | 'nextCreditNoteNumber'>

export function defaultBilling(category: Business['category']): BillingJson {
  return {
    taxEnabled: category !== 'service', taxMode: 'exclusive', discountEnabled: true,
    paymentMethods: ['cash', 'upi', 'card', 'credit'], orderTypes: templateFor(category).orderTypes,
    receiptFooter: 'Thank you! Visit again.', roundOff: true,
  }
}
export const DEFAULT_SEQ: Record<SeqName, { prefix: string; start: number }> = {
  invoice: { prefix: 'INV-', start: 10001 }, order: { prefix: '#', start: 1001 }, kot: { prefix: 'KOT-', start: 1 },
  credit_note: { prefix: 'CN-', start: 1001 }, purchase: { prefix: 'PUR-', start: 1 },
}

export interface BusinessBundle { business: Business; branches: Branch[] }

/** Loads one business with everything the app keeps on `Business` (≈ 10–20 rows). */
export async function loadBusiness(c: { platform: Db; db: Db; files?: Files }, businessId: string): Promise<BusinessBundle | null> {
  const row = await c.platform.get('businesses', businessId)
  if (!row || row.deleted_at) return null
  const db = c.db
  const [settings, taxes, seqs, lists, branches] = await Promise.all([
    db.select('business_settings', { where: { business_id: businessId } }),
    db.select('tax_rates', { where: { business_id: businessId }, orderBy: [['rate_bp', 'ASC']] }),
    db.select('sequences', { where: { business_id: businessId } }),
    db.select('price_lists', { where: { business_id: businessId } }),
    db.select('branches', { where: { business_id: businessId } }),
  ])
  return { business: businessFrom(row, settings, taxes, seqs, lists, c.files), branches: branches.map((b) => branchFrom(b, seqs)) }
}

export function businessFrom(row: Row, settings: Row[], taxes: Row[], seqs: Row[], lists: Row[], files?: Files): Business {
  const category = nameOf(E.BusinessCategory, row.category) as Business['category']
  const setting = <T,>(k: string, fb: T) => { const r = settings.find((s) => s.setting_key === k); return r ? json<T>(r.value_json, fb) : fb }
  const seq = (name: SeqName) => seqs.find((s) => s.branch_id == null && Number(s.name) === code(E.SequenceName, name))
  const tpl = templateFor(category)
  const billingJson = { ...defaultBilling(category), ...setting<Partial<BillingJson>>('billing', {}) }
  const wholesaleList = lists.find((l) => !l.is_default)
  const def = taxes.find((t) => t.is_default) ?? taxes[0]
  const billing: BillingSettings = {
    ...billingJson,
    invoicePrefix: str(seq('invoice')?.prefix ?? DEFAULT_SEQ.invoice.prefix), nextInvoiceNumber: Number(seq('invoice')?.next_value ?? DEFAULT_SEQ.invoice.start),
    orderPrefix: str(seq('order')?.prefix ?? DEFAULT_SEQ.order.prefix), nextOrderNumber: Number(seq('order')?.next_value ?? DEFAULT_SEQ.order.start),
    nextKotNumber: Number(seq('kot')?.next_value ?? DEFAULT_SEQ.kot.start),
    creditNotePrefix: str(seq('credit_note')?.prefix ?? DEFAULT_SEQ.credit_note.prefix), nextCreditNoteNumber: Number(seq('credit_note')?.next_value ?? DEFAULT_SEQ.credit_note.start),
    taxRates: taxes.filter((t) => t.is_active !== false).map((t) => ({ id: t.ROWID, name: str(t.name), rate: fromBp(t.rate_bp) })),
    defaultTaxRateId: def?.ROWID ?? null,
    ...(wholesaleList ? { wholesale: { enabled: !!wholesaleList.is_active, label: str(wholesaleList.name) } } : {}),
  }
  const start = strOrNull(row.subscription_start_at), end = strOrNull(row.subscription_end_at)
  const logoKey = setting<{ logoKey?: string }>('brand', {}).logoKey
  const logoUrl = logoKey && files ? files.url(logoKey) : null
  return {
    id: row.ROWID, name: str(row.name), category, subType: str(row.sub_type), logoEmoji: LOGO_EMOJI[category], logoUrl,
    address: str(row.address), phone: str(row.phone), email: str(row.email), gstin: str(row.gstin),
    currency: str(row.currency_code) || 'INR', currencySymbol: str(row.currency_symbol) || '₹', timezone: str(row.timezone) || 'Asia/Kolkata',
    defaultCountry: str(row.country_code) || 'IN',
    terminology: { ...DEFAULT_TERMS, ...tpl.terms, ...setting<Partial<Terminology>>('terminology', {}) },
    modules: { ...modulesFor(category), ...setting<Partial<ModuleConfig>>('modules', {}) },
    billing,
    ...(settings.some((s) => s.setting_key === 'qr') ? { qr: setting<QrSettings>('qr', undefined as unknown as QrSettings) } : {}),
    ...(settings.some((s) => s.setting_key === 'stickers') ? { stickers: setting<StickerSettings>('stickers', undefined as unknown as StickerSettings) } : {}),
    ...(setting<{ stateCode?: string }>('gst', {}).stateCode ? { stateCode: setting<{ stateCode: string }>('gst', { stateCode: '' }).stateCode } : {}),
    ...(settings.some((s) => s.setting_key === 'loyalty') ? { loyalty: setting<LoyaltySettings>('loyalty', undefined as unknown as LoyaltySettings) } : {}),
    onboarded: !!row.onboarded_at, createdAt: row.CREATEDTIME,
    status: nameOf(E.BusinessStatus, row.status) as Business['status'],
    ...(start && end ? { subscription: { startAt: start, endAt: end } } : {}),
    maxBranches: Number(row.max_branches ?? 1), adminNote: str(row.admin_note), remindersPaused: !!row.reminders_paused,
  }
}

export const PRINTER_DEFAULTS: BranchPrinter = { transport: 'browser', paper: null, mode: 'auto', autoPrint: false, copies: 1, cut: true, drawer: false, baudRate: 9600 }

export function branchFrom(b: Row, seqs: Row[]): Branch {
  const own = seqs.find((s) => s.branch_id === b.ROWID && Number(s.name) === E.SequenceName.invoice)
  const printer = json<BranchPrinter | null>(b.printer_json, null)
  return {
    id: b.ROWID, businessId: str(b.business_id), name: str(b.name), address: str(b.address), phone: str(b.phone),
    isDefault: !!b.is_default, active: b.is_active !== false,
    ...(b.invoice_prefix ? { invoicePrefix: str(b.invoice_prefix), nextInvoiceNumber: Number(own?.next_value ?? 10001) } : {}),
    ...(printer ? { printer } : {}),
  }
}

/** Default tax rates for a new business (same as the app's starter list). */
export async function seedTaxRates(db: Db, businessId: string, category: Business['category']) {
  const rates = [{ name: 'No Tax', rate: 0 }, { name: 'GST 5%', rate: 5 }, { name: 'GST 12%', rate: 12 }, { name: 'GST 18%', rate: 18 }]
  const def = category === 'retail' ? 0 : 5
  return db.insertMany('tax_rates', rates.map((r) => ({ business_id: businessId, name: r.name, rate_bp: toBp(r.rate), is_inclusive: false, is_default: r.rate === def, is_active: true })))
}
