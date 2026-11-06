// How a branch's bill looks (Settings → Printer and bill → Bill format): the item columns, the lines at the top and
// bottom, and their names. Each branch has its own (table bill_formats). Shared by the app, the demo app and the
// server (which cleans what is saved). A branch without a format prints the bill exactly as before
// (features/printing/doc.ts → receiptDoc).
import { isAutoParts, isHardware, isSupermarket, isVegetableShop } from './config'
import { isTextileShop } from './stickers'
import type { Business, Permission } from './types'

/** The four item layouts. Every line reads left to right: Rate × Qty − Discount = Amount. */
export type BillLayout = 'basic' | 'mrp' | 'mrpDisc' | 'disc'
export type BillCol = 'no' | 'item' | 'mrp' | 'rate' | 'qty' | 'disc' | 'amt'
export const LAYOUT_COLS: Record<BillLayout, BillCol[]> = {
  basic: ['no', 'item', 'rate', 'qty', 'amt'],
  mrp: ['no', 'item', 'mrp', 'rate', 'qty', 'amt'],
  mrpDisc: ['no', 'item', 'mrp', 'rate', 'qty', 'disc', 'amt'],
  disc: ['no', 'item', 'rate', 'qty', 'disc', 'amt'],
}
export const LAYOUT_LABEL: Record<BillLayout, string> = { basic: 'Basic', mrp: 'With MRP', mrpDisc: 'MRP + discount', disc: 'Discount' }
export const BILL_COLS: BillCol[] = ['no', 'item', 'mrp', 'rate', 'qty', 'disc', 'amt']
export const COL_DEFAULT: Record<BillCol, string> = { no: 'No', item: 'Item', mrp: 'MRP', rate: 'Rate', qty: 'Qty', disc: 'Discount', amt: 'Amount' }
/** What each column holds (shown next to its name box). */
export const COL_HINT: Record<BillCol, string> = {
  no: 'Line number', item: 'Item name', mrp: 'MRP of the item', rate: 'Selling price', qty: 'Quantity',
  disc: 'Discount given on the item', amt: 'Rate × Qty − Discount',
}

/** One line at the top or bottom: printed or not, and what it is called. */
export interface BillLine { on: boolean; label: string }
export type TopKey = 'name2' | 'address' | 'phone' | 'gstin' | 'email' | 'title' | 'billNo' | 'orderNo' | 'date' | 'time' | 'cashier' | 'waiter' | 'customer' | 'state'
export type BottomKey = 'totalQty' | 'roundOff' | 'total' | 'words' | 'savings' | 'received' | 'orderType' | 'signature'

export interface BillFormat {
  v: 1
  layout: BillLayout
  /** Column names on the bill (empty = the default name). */
  cols: Record<BillCol, string>
  /** Quantity: auto = whole numbers plain, loose items with up to 3 decimals. */
  qtyDecimals: 'auto' | 0 | 2 | 3
  /** Shop name on the bill (empty = the business name) and an optional second line under it. */
  name1: string
  name2: string
  /** Address on the bill (empty = the branch's / business address). New lines are kept. */
  address: string
  /** A second phone number printed next to the shop's. */
  phone2: string
  /** Bill title (empty = TAX INVOICE / BILL). */
  title: string
  /** Shown as the customer when a bill has none, e.g. "Cash Sales" (empty = nothing). */
  cashSales: string
  /** Footer lines at the bottom of the bill (empty = nothing). */
  footer1: string
  footer2: string
  top: Record<TopKey, BillLine>
  bottom: Record<BottomKey, BillLine>
}

export const TOP_KEYS: TopKey[] = ['name2', 'address', 'phone', 'gstin', 'email', 'title', 'billNo', 'orderNo', 'date', 'time', 'cashier', 'waiter', 'customer', 'state']
export const BOTTOM_KEYS: BottomKey[] = ['totalQty', 'roundOff', 'total', 'words', 'savings', 'received', 'orderType', 'signature']
/** The setting's name in the form, and the label printed on the bill by default. */
export const TOP_INFO: Record<TopKey, { name: string; label: string }> = {
  name2: { name: 'Second name line', label: '' }, address: { name: 'Address', label: '' }, phone: { name: 'Phone', label: 'Ph' },
  gstin: { name: 'GSTIN', label: 'GSTIN' }, email: { name: 'Email', label: 'Email' }, title: { name: 'Bill title', label: '' },
  billNo: { name: 'Bill number', label: 'Bill No' }, orderNo: { name: 'Order number', label: 'Order' }, date: { name: 'Date', label: 'Date' },
  time: { name: 'Time', label: 'Time' }, cashier: { name: 'Cashier', label: 'Cashier' }, waiter: { name: 'Waiter / salesperson', label: 'Waiter' },
  customer: { name: 'Customer', label: 'To' }, state: { name: 'State (place of supply)', label: 'State' },
}
export const BOTTOM_INFO: Record<BottomKey, { name: string; label: string }> = {
  totalQty: { name: 'Total quantity', label: 'Total' }, roundOff: { name: 'Round off', label: 'Round off' },
  total: { name: 'Grand total (big)', label: 'TOTAL' }, words: { name: 'Amount in words', label: '' },
  savings: { name: 'Savings', label: 'You saved' }, received: { name: 'Received amount', label: 'Received' },
  orderType: { name: 'Order type (Dine in…)', label: '' }, signature: { name: 'Signature "For shop"', label: 'For' },
}

const line = (on: boolean, label: string): BillLine => ({ on, label })

/** Which of the four layouts a shop type starts with. */
export function layoutFor(b: Pick<Business, 'category' | 'subType'>): BillLayout {
  if (isTextileShop(b)) return 'mrpDisc'
  if (b.category !== 'retail' || isVegetableShop(b)) return 'basic' // restaurants, food, services, vegetables
  if (isSupermarket(b) || isAutoParts(b) || /grocery|maligai|kirana|provision/i.test(b.subType)) return 'mrp'
  if (isHardware(b) || /fancy|stationery|electronic/i.test(b.subType)) return 'disc'
  return 'mrp'
}

/** Who may change a branch's bill: the owner / manager (Business settings), or a role given "Change bill format". */
export const canEditBillFormat = (can: (p: Permission) => boolean) => can('settings.manage') || can('bill.format')

/** The format we set up for each shop type — the owner changes what they want from here. */
export function defaultBillFormat(b: Pick<Business, 'category' | 'subType'>, footer1 = ''): BillFormat {
  const layout = layoutFor(b)
  const food = b.category === 'food' || b.category === 'restaurant'
  const shopRetail = b.category === 'retail' && !isVegetableShop(b)
  const mrpShop = layout !== 'basic'
  return {
    v: 1, layout, cols: { ...COL_DEFAULT }, qtyDecimals: 'auto',
    name1: '', name2: '', address: '', phone2: '', title: '', cashSales: shopRetail ? 'Cash Sales' : '', footer1: one(footer1, 60), footer2: '',
    top: {
      name2: line(false, ''), address: line(true, ''), phone: line(true, 'Ph'), gstin: line(true, 'GSTIN'),
      email: line(shopRetail, 'Email'), title: line(true, ''), billNo: line(true, 'Bill No'), orderNo: line(food, 'Order'),
      date: line(true, 'Date'), time: line(true, 'Time'), cashier: line(!food, 'Cashier'), waiter: line(food || isTextileShop(b), food ? 'Waiter' : 'Sales'),
      customer: line(true, 'To'), state: line(shopRetail, 'State'),
    },
    bottom: {
      totalQty: line(true, 'Total'), roundOff: line(true, 'Round off'), total: line(true, 'TOTAL'),
      words: line(shopRetail, ''), savings: line(mrpShop, b.category === 'retail' ? "Today's savings" : 'You saved'),
      received: line(isVegetableShop(b), 'Received'), orderType: line(food, ''), signature: line(shopRetail, 'For'),
    },
  }
}

const txt = (v: unknown, max: number) => String(v ?? '').replace(/[\r\t]/g, ' ').slice(0, max)
const one = (v: unknown, max: number) => txt(v, max).replace(/\n/g, ' ').trim()

/** A saved / sent format made safe: known keys only, lengths limited, anything missing from the shop type's default. */
export function cleanBillFormat(input: unknown, b: Pick<Business, 'category' | 'subType'>): BillFormat {
  const d = defaultBillFormat(b)
  const x = (input && typeof input === 'object' ? input : {}) as Partial<BillFormat>
  const layout = (Object.keys(LAYOUT_COLS) as BillLayout[]).includes(x.layout as BillLayout) ? (x.layout as BillLayout) : d.layout
  const qty = [0, 2, 3, 'auto'].includes(x.qtyDecimals as never) ? (x.qtyDecimals as BillFormat['qtyDecimals']) : 'auto'
  const cols = {} as Record<BillCol, string>
  for (const c of BILL_COLS) cols[c] = one(x.cols?.[c], 16) || COL_DEFAULT[c]
  const lines = <K extends string>(keys: K[], src: Partial<Record<K, Partial<BillLine>>> | undefined, def: Record<K, BillLine>) => {
    const out = {} as Record<K, BillLine>
    for (const k of keys) { const s = src?.[k]; out[k] = { on: s?.on === undefined ? def[k].on : !!s.on, label: s?.label === undefined ? def[k].label : one(s.label, 24) } }
    return out
  }
  return {
    v: 1, layout, cols, qtyDecimals: qty,
    name1: one(x.name1, 60), name2: one(x.name2, 60), address: txt(x.address, 200).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4).join('\n'),
    phone2: one(x.phone2, 20), title: one(x.title, 30), cashSales: one(x.cashSales, 30), footer1: one(x.footer1, 60), footer2: one(x.footer2, 60),
    top: lines(TOP_KEYS, x.top, d.top), bottom: lines(BOTTOM_KEYS, x.bottom, d.bottom),
  }
}

/** The name the bill shows for a shop type's layout, e.g. "Vegetable shop" (Settings banner / reset line). */
export function shopTypeLabel(b: Pick<Business, 'subType'>) { return b.subType || 'your shop' }
