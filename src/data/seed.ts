// Deterministic demo data for a food business ("Food Corner" — restaurant + fast food).
// History is generated relative to "now" so the dashboard and reports always look alive.
import { DEFAULT_ROLES, DEFAULT_TERMS, modulesFor, templateFor } from '@/core/config'
import { computeTotals, r2 } from '@/core/pricing'
import { makeItem } from '@/core/orderItem'
import type {
  Audit, Business, Category, Special, Customer, DiningTable, Expense, ExpenseCategory, KitchenTicket, KotStatus, Order, OrderItem,
  OrderType, Payment, PaymentMethod, Product, Role, StockMovement, User,
} from '@/core/types'
import type { DB } from './db'
import { dateKey } from '@/core/specials'

const BIZ = 'biz_foodcorner'
const BR = 'br_main'
const OWNER = 'usr_owner'

export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function newBusiness(input: {
  id: string; name: string; category: Business['category']; subType: string; phone?: string; createdAt: string
}): Business {
  const tpl = templateFor(input.category)
  return {
    id: input.id,
    name: input.name,
    category: input.category,
    subType: input.subType,
    logoEmoji: tpl.emoji,
    address: '',
    phone: input.phone ?? '',
    email: '',
    gstin: '',
    currency: 'INR',
    currencySymbol: '₹',
    timezone: 'Asia/Kolkata',
    terminology: { ...DEFAULT_TERMS, ...tpl.terms },
    modules: modulesFor(input.category),
    billing: {
      invoicePrefix: 'INV-',
      nextInvoiceNumber: 10001,
      orderPrefix: '#',
      nextOrderNumber: 1001,
      nextKotNumber: 1,
      taxEnabled: input.category !== 'service',
      taxMode: 'exclusive',
      taxRates: [
        { id: 'tax_0', name: 'No Tax', rate: 0 },
        { id: 'tax_5', name: 'GST 5%', rate: 5 },
        { id: 'tax_12', name: 'GST 12%', rate: 12 },
        { id: 'tax_18', name: 'GST 18%', rate: 18 },
      ],
      defaultTaxRateId: input.category === 'retail' ? 'tax_0' : 'tax_5',
      discountEnabled: true,
      paymentMethods: ['cash', 'upi', 'card', 'credit'],
      orderTypes: tpl.orderTypes,
      receiptFooter: 'Thank you! Visit again.',
      roundOff: true,
    },
    onboarded: true,
    createdAt: input.createdAt,
  }
}

export function defaultRoles(businessId: string): Role[] {
  return DEFAULT_ROLES.map((r) => ({ id: `${businessId}_${r.id}`, businessId, name: r.name, system: true, permissions: r.permissions }))
}

export function buildSeed(version: number): DB {
  const rand = rng(20251005)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1))
  const now = new Date()
  const start = new Date(now); start.setDate(start.getDate() - 30); start.setHours(9, 0, 0, 0)
  const audit = (at: Date | string, by = OWNER): Audit => {
    const iso = typeof at === 'string' ? at : at.toISOString()
    return { createdAt: iso, createdBy: by, updatedAt: iso, updatedBy: by }
  }

  // ---------- Business ----------
  const biz = newBusiness({ id: BIZ, name: 'Food Corner', category: 'restaurant', subType: 'Restaurant & Fast Food', phone: '+91 98765 43210', createdAt: start.toISOString() })
  biz.logoEmoji = '🍔'
  biz.address = '12, Gandhi Road, T. Nagar, Chennai 600017'
  biz.email = 'hello@foodcorner.in'
  biz.gstin = '33ABCDE1234F1Z5'
  biz.modules = { ...biz.modules, inventory: true, orders: true, kitchen: true, tables: true, mobileOrders: true, specials: true, qrOrdering: true }
  biz.billing.orderTypes = ['dine_in', 'takeaway', 'delivery']

  const roles = defaultRoles(BIZ)
  const roleId = (k: string) => `${BIZ}_${k}`
  const users: User[] = [
    { id: OWNER, name: 'Karthick', phone: '9876543210', email: 'owner@foodcorner.in', roleId: roleId('owner') },
    { id: 'usr_mgr', name: 'Priya', phone: '9876500001', email: 'priya@foodcorner.in', roleId: roleId('manager') },
    { id: 'usr_cash', name: 'Ravi', phone: '9876500002', email: 'ravi@foodcorner.in', roleId: roleId('cashier') },
    { id: 'usr_wait', name: 'Suresh', phone: '9876500003', email: 'suresh@foodcorner.in', roleId: roleId('waiter') },
    { id: 'usr_wait2', name: 'Anbu', phone: '9876500005', email: '', roleId: roleId('waiter') },
    { id: 'usr_kit', name: 'Murugan', phone: '9876500004', email: '', roleId: roleId('kitchen') },
  ].map((u) => ({ ...u, businessId: BIZ, branchId: BR, password: 'demo123', active: true, ...audit(start) }))

  // ---------- Catalogue ----------
  const cats: Category[] = [
    ['burgers', 'Burgers', '🍔'], ['pizza', 'Pizza', '🍕'], ['biryani', 'Biryani & Rice', '🍛'], ['south', 'South Indian', '🥞'],
    ['starters', 'Starters', '🍗'], ['bev', 'Beverages', '🥤'], ['dessert', 'Desserts', '🍨'],
  ].map(([id, name, emoji], i) => ({ id: `cat_${id}`, businessId: BIZ, name, emoji, sort: i }))

  type P = Partial<Product> & { name: string; cat: string; emoji: string; price: number }
  const ao = (id: string, name: string, price: number) => ({ id: `ao_${id}`, name, price })
  const vr = (id: string, name: string, price: number) => ({ id: `v_${id}`, name, price })
  const burgerAddOns = [ao('cheese', 'Cheese', 30), ao('egg', 'Egg', 20), ao('patty', 'Extra Patty', 70)]
  const pizzaAddOns = [ao('xcheese', 'Extra Cheese', 40), ao('jala', 'Jalapeño', 30), ao('olive', 'Olives', 30)]
  const defs: P[] = [
    { name: 'Chicken Burger', cat: 'burgers', emoji: '🍔', price: 120, costPrice: 55, addOns: burgerAddOns, isVeg: false },
    { name: 'Veg Burger', cat: 'burgers', emoji: '🍔', price: 100, costPrice: 40, addOns: [burgerAddOns[0]] },
    { name: 'Paneer Burger', cat: 'burgers', emoji: '🍔', price: 140, costPrice: 60, addOns: [burgerAddOns[0]] },
    { name: 'Crispy Chicken Wrap', cat: 'burgers', emoji: '🌯', price: 130, costPrice: 55, isVeg: false },
    { name: 'Margherita Pizza', cat: 'pizza', emoji: '🍕', price: 180, costPrice: 80, variants: [vr('mg_s', 'Small', 180), vr('mg_m', 'Medium', 280), vr('mg_l', 'Large', 380)], addOns: pizzaAddOns },
    { name: 'Chicken Pizza', cat: 'pizza', emoji: '🍕', price: 220, costPrice: 100, variants: [vr('cp_s', 'Small', 220), vr('cp_m', 'Medium', 320), vr('cp_l', 'Large', 420)], addOns: pizzaAddOns, isVeg: false },
    { name: 'Paneer Tikka Pizza', cat: 'pizza', emoji: '🍕', price: 200, costPrice: 90, variants: [vr('pt_s', 'Small', 200), vr('pt_m', 'Medium', 300), vr('pt_l', 'Large', 400)], addOns: pizzaAddOns },
    { name: 'Chicken Biryani', cat: 'biryani', emoji: '🍛', price: 180, costPrice: 85, variants: [vr('cb_h', 'Half', 180), vr('cb_f', 'Full', 280)], addOns: [ao('egg2', 'Extra Egg', 20), ao('raita', 'Extra Raita', 15)], isVeg: false },
    { name: 'Mutton Biryani', cat: 'biryani', emoji: '🍛', price: 280, costPrice: 150, variants: [vr('mb_h', 'Half', 280), vr('mb_f', 'Full', 420)], isVeg: false },
    { name: 'Veg Fried Rice', cat: 'biryani', emoji: '🍚', price: 140, costPrice: 50 },
    { name: 'Egg Fried Rice', cat: 'biryani', emoji: '🍳', price: 150, costPrice: 55, isVeg: false },
    { name: 'Curd Rice', cat: 'biryani', emoji: '🍚', price: 80, costPrice: 25 },
    { name: 'Masala Dosa', cat: 'south', emoji: '🥞', price: 80, costPrice: 25 },
    { name: 'Ghee Roast', cat: 'south', emoji: '🥞', price: 100, costPrice: 35 },
    { name: 'Idli (2 pcs)', cat: 'south', emoji: '🍥', price: 40, costPrice: 12 },
    { name: 'Parotta', cat: 'south', emoji: '🫓', price: 25, costPrice: 8, unit: 'pc' },
    { name: 'Chicken 65', cat: 'starters', emoji: '🍗', price: 160, costPrice: 70, variants: [vr('c65_h', 'Half', 160), vr('c65_f', 'Full', 280)], isVeg: false },
    { name: 'Gobi Manchurian', cat: 'starters', emoji: '🥦', price: 130, costPrice: 45 },
    { name: 'French Fries', cat: 'starters', emoji: '🍟', price: 70, costPrice: 25, variants: [vr('ff_r', 'Regular', 70), vr('ff_l', 'Large', 110)], addOns: [ao('peri', 'Peri Peri', 15), ao('cheesedip', 'Cheese Dip', 25)] },
    { name: 'Chicken Lollipop', cat: 'starters', emoji: '🍗', price: 200, costPrice: 90, isVeg: false },
    { name: 'Cold Coffee', cat: 'bev', emoji: '🧋', price: 90, costPrice: 30, addOns: [ao('icecream', 'Ice Cream Scoop', 30)] },
    { name: 'Fresh Lime Soda', cat: 'bev', emoji: '🍋', price: 60, costPrice: 15, sendToKitchen: false },
    { name: 'Mango Lassi', cat: 'bev', emoji: '🥭', price: 80, costPrice: 25 },
    { name: 'Masala Tea', cat: 'bev', emoji: '☕', price: 20, costPrice: 6, unit: 'cup' },
    { name: 'Filter Coffee', cat: 'bev', emoji: '☕', price: 25, costPrice: 8, unit: 'cup' },
    { name: 'Coke (300ml)', cat: 'bev', emoji: '🥤', price: 50, costPrice: 32, trackStock: true, lowStockAt: 12, sendToKitchen: false, taxRateId: 'tax_18' },
    { name: 'Sprite (300ml)', cat: 'bev', emoji: '🥤', price: 50, costPrice: 32, trackStock: true, lowStockAt: 12, sendToKitchen: false, taxRateId: 'tax_18' },
    { name: 'Mineral Water (1L)', cat: 'bev', emoji: '💧', price: 20, costPrice: 11, trackStock: true, lowStockAt: 20, sendToKitchen: false, unit: 'bottle' },
    { name: 'Gulab Jamun (2 pcs)', cat: 'dessert', emoji: '🍡', price: 50, costPrice: 15, trackStock: true, lowStockAt: 15 },
    { name: 'Ice Cream', cat: 'dessert', emoji: '🍨', price: 60, costPrice: 25, variants: [vr('ic_v', 'Vanilla', 60), vr('ic_c', 'Chocolate', 70), vr('ic_b', 'Butterscotch', 70)], trackStock: true, lowStockAt: 10 },
    { name: 'Brownie with Ice Cream', cat: 'dessert', emoji: '🍫', price: 140, costPrice: 55, trackStock: true, lowStockAt: 8 },
  ]
  const products: Product[] = defs.map((d, i) => ({
    id: `prd_${String(i + 1).padStart(3, '0')}`,
    businessId: BIZ,
    name: d.name,
    categoryId: `cat_${d.cat}`,
    kind: 'goods',
    emoji: d.emoji,
    sku: `FC${String(i + 1).padStart(3, '0')}`,
    barcode: d.trackStock ? `890${String(1000000000 + i * 7919).slice(0, 10)}` : '',
    unit: d.unit ?? 'plate',
    price: d.price,
    costPrice: d.costPrice ?? 0,
    variants: d.variants ?? [],
    addOns: d.addOns ?? [],
    taxRateId: d.taxRateId ?? null,
    trackStock: d.trackStock ?? false,
    stock: 0,
    lowStockAt: d.lowStockAt ?? 0,
    isVeg: d.isVeg ?? true,
    sendToKitchen: d.sendToKitchen ?? true,
    active: true,
    ...audit(start),
  }))
  // Fix units for drinks
  products.forEach((p) => { if (p.categoryId === 'cat_bev' && p.unit === 'plate') p.unit = p.trackStock ? 'bottle' : 'glass' })
  products.forEach((p) => { if (p.categoryId === 'cat_dessert') p.unit = p.name.startsWith('Ice') ? 'scoop' : 'pc' })
  products.forEach((p) => { if (p.categoryId === 'cat_burgers' || p.categoryId === 'cat_pizza') p.unit = 'pc' })

  // Popularity weights drive realistic "top selling" reports.
  const weight: Record<string, number> = {
    'Chicken Biryani': 14, 'Chicken Burger': 11, 'French Fries': 9, 'Cold Coffee': 8, 'Masala Dosa': 8, 'Chicken 65': 7,
    'Parotta': 7, 'Margherita Pizza': 6, 'Coke (300ml)': 6, 'Veg Burger': 5, 'Masala Tea': 6, 'Filter Coffee': 5,
  }
  const pool: Product[] = []
  products.forEach((p) => { for (let i = 0; i < (weight[p.name] ?? 3); i++) pool.push(p) })

  // ---------- Customers ----------
  const names = ['Kumar', 'Lakshmi', 'Arun Prakash', 'Divya', 'Senthil', 'Meena', 'Vijay', 'Anitha', 'Prakash', 'Kavitha',
    'Ramesh', 'Saranya', 'Gopal', 'Deepa', 'Hari', 'Nithya', 'Balaji', 'Revathi']
  const areas = ['T. Nagar', 'Adyar', 'Mylapore', 'Velachery', 'Anna Nagar', 'Tambaram']
  const customers: Customer[] = names.map((n, i) => ({
    id: `cus_${String(i + 1).padStart(3, '0')}`,
    businessId: BIZ, name: n,
    phone: `9${String(840000000 + i * 1373911).slice(0, 9)}`,
    email: i % 3 === 0 ? `${n.split(' ')[0].toLowerCase()}@gmail.com` : '',
    address: i % 2 === 0 ? `${between(1, 90)}, ${pick(['Main Road', 'Cross Street', '2nd Avenue'])}, ${pick(areas)}` : '',
    notes: i === 0 ? 'Regular — monthly credit account' : '',
    ...audit(start),
  }))
  const creditCustomers = customers.slice(0, 6)

  // ---------- Tables ----------
  const tables: DiningTable[] = []
  for (let i = 1; i <= 12; i++) {
    tables.push({ id: `tbl_${i}`, businessId: BIZ, branchId: BR, label: `T${i}`, floor: i <= 8 ? 'Ground Floor' : 'First Floor (AC)', seats: [2, 4, 4, 6][i % 4], mergedInto: null })
  }

  // ---------- Orders, payments, KOTs ----------
  const orders: Order[] = []
  const payments: Payment[] = []
  const kots: KitchenTicket[] = []
  let orderNo = biz.billing.nextOrderNumber
  let invNo = biz.billing.nextInvoiceNumber
  let kotNo = 1
  const staff = ['usr_owner', 'usr_cash', 'usr_cash', 'usr_mgr']
  const waiters = ['usr_wait', 'usr_wait2']

  const randomItems = (): OrderItem[] => {
    const n = rand() < 0.35 ? 1 : rand() < 0.7 ? 2 : between(3, 5)
    const items: OrderItem[] = []
    for (let i = 0; i < n; i++) {
      const p = pick(pool)
      if (items.some((x) => x.productId === p.id)) continue
      const variant = p.variants.length ? pick(p.variants) : null
      const addOns = p.addOns.length && rand() < 0.3 ? [pick(p.addOns)] : []
      const qty = p.unit === 'pc' && p.categoryId === 'cat_south' ? between(2, 4) : rand() < 0.75 ? 1 : 2
      items.push(makeItem(p, biz.billing, { variant, addOns, qty }))
    }
    return items
  }

  const hourWeights = [8, 9, 10, 11, 12, 12, 13, 13, 13, 14, 14, 15, 16, 17, 18, 19, 19, 20, 20, 20, 21, 21, 22]
  const methodRoll = (): PaymentMethod | 'split' => {
    const x = rand()
    return x < 0.38 ? 'cash' : x < 0.78 ? 'upi' : x < 0.9 ? 'card' : x < 0.96 ? 'credit' : 'split'
  }

  const createOrder = (at: Date, opts: { status: 'completed' | 'open' | 'cancelled'; type?: OrderType; tableId?: string | null; by?: string; items?: OrderItem[] }) => {
    const type: OrderType = opts.type ?? (rand() < 0.5 ? 'dine_in' : rand() < 0.75 ? 'takeaway' : 'delivery')
    const items = opts.items ?? randomItems()
    const discount = rand() < 0.08 ? pick([10, 20, 50]) : 0
    const t = computeTotals(items, discount, biz.billing)
    const by = opts.by ?? (type === 'dine_in' ? pick(waiters) : pick(staff))
    let method = methodRoll()
    const order: Order = {
      id: `ord_${orderNo}`, number: `${biz.billing.orderPrefix}${orderNo++}`,
      businessId: BIZ, branchId: BR, type,
      tableId: type === 'dine_in' ? (opts.tableId ?? pick(tables).id) : null,
      customerId: null, status: opts.status, items: items.map((i) => ({ ...i, kotQty: i.qty })), notes: '',
      ...t, paid: 0, balance: t.total, paymentStatus: 'unpaid',
      invoiceNumber: null, billedAt: null, cancelledAt: null, cancelReason: null,
      source: type === 'dine_in' ? 'table' : rand() < 0.3 ? 'mobile' : 'pos',
      ...audit(at, by),
    }
    if (method === 'credit' || rand() < 0.15) order.customerId = method === 'credit' ? pick(creditCustomers).id : pick(customers).id
    if (opts.status === 'completed') {
      const billedAt = new Date(at.getTime() + (type === 'dine_in' ? between(25, 55) : between(3, 12)) * 60000)
      order.invoiceNumber = `${biz.billing.invoicePrefix}${invNo++}`
      order.billedAt = billedAt.toISOString()
      order.updatedAt = order.billedAt
      order.updatedBy = pick(staff)
      const pay = (m: PaymentMethod, amount: number) => payments.push({
        id: `pay_${payments.length + 1}`, businessId: BIZ, branchId: BR, orderId: order.id, customerId: order.customerId,
        method: m, kind: 'sale', amount, reference: m === 'upi' ? `UPI${between(100000, 999999)}` : '', voided: false, ...audit(billedAt, order.updatedBy),
      })
      if (method === 'credit') {
        // Partial or zero payment; remaining goes to customer's credit.
        const part = rand() < 0.5 ? 0 : Math.round(order.total / 2)
        if (part) pay('cash', part)
        order.paid = part
      } else if (method === 'split') {
        const cash = Math.round(order.total * 0.4)
        pay('cash', cash); pay('upi', r2(order.total - cash))
        order.paid = order.total
      } else {
        pay(method, order.total)
        order.paid = order.total
      }
      order.balance = r2(order.total - order.paid)
      order.paymentStatus = order.balance <= 0 ? 'paid' : order.paid > 0 ? 'partial' : 'unpaid'
      method = method === 'split' ? 'cash' : method
    }
    if (opts.status === 'cancelled') {
      order.cancelledAt = new Date(at.getTime() + 5 * 60000).toISOString()
      order.cancelReason = pick(['Customer left', 'Wrong order', 'Duplicate entry'])
    }
    orders.push(order)
    return order
  }

  const tableLabel = (id: string | null) => tables.find((t) => t.id === id)?.label ?? null
  const createKot = (o: Order, at: Date, status: KotStatus) => {
    const items = o.items.filter((i) => products.find((p) => p.id === i.productId)?.sendToKitchen)
    if (!items.length) return
    kots.push({
      id: `kot_${kotNo}`, number: `KOT-${String(kotNo++).padStart(4, '0')}`, businessId: BIZ, branchId: BR,
      orderId: o.id, orderNumber: o.number, orderType: o.type, tableLabel: tableLabel(o.tableId),
      items: items.map((i) => ({
        name: i.name + (i.variantName ? ` (${i.variantName})` : '') + (i.addOns.length ? ` + ${i.addOns.map((a) => a.name).join(', ')}` : ''),
        qty: i.qty, notes: i.notes, isVeg: products.find((p) => p.id === i.productId)?.isVeg ?? true,
      })),
      status, statusAt: at.toISOString(), ...audit(at, o.createdBy),
    })
  }

  // History: from start until yesterday, then today up to the current time.
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0)
  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const isToday = d.getTime() >= today0.getTime()
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const count = isToday ? 999 : between(weekend ? 42 : 28, weekend ? 58 : 40)
    const times: Date[] = []
    for (let i = 0; i < count; i++) {
      const t = new Date(d); t.setHours(pick(hourWeights), between(0, 59), between(0, 59), 0)
      if (isToday) {
        // ~3.4 orders per elapsed hour, never in the future
        if (t.getTime() > now.getTime() - 20 * 60000) continue
        if (times.length >= Math.max(0, Math.floor(((now.getHours() - 8) + now.getMinutes() / 60) * 3.4))) break
      }
      times.push(t)
    }
    times.sort((a, b) => a.getTime() - b.getTime())
    for (const t of times) createOrder(t, { status: rand() < 0.015 ? 'cancelled' : 'completed' })
  }

  // Completed KOTs for the last few billed orders today (fills the "Completed" column).
  orders.filter((o) => o.status === 'completed' && new Date(o.createdAt) >= today0).slice(-8)
    .forEach((o) => createKot(o, new Date(o.createdAt), 'completed'))

  // Running orders right now: occupied tables + takeaway.
  const mins = (m: number) => new Date(now.getTime() - m * 60000)
  const byName = (n: string) => products.find((p) => p.name === n)!
  const mk = (n: string, qty = 1, vIdx = -1, addOnIdx: number[] = [], notes = '') => {
    const p = byName(n)
    return makeItem(p, biz.billing, { qty, variant: vIdx >= 0 ? p.variants[vIdx] : null, addOns: addOnIdx.map((i) => p.addOns[i]), notes })
  }
  const running: { table?: string; type: OrderType; at: number; kot: KotStatus; items: OrderItem[]; by: string }[] = [
    { table: 'tbl_1', type: 'dine_in', at: 42, kot: 'ready', by: 'usr_wait', items: [mk('Chicken Biryani', 2, 1), mk('Chicken 65', 1, 0), mk('Coke (300ml)', 2)] },
    { table: 'tbl_3', type: 'dine_in', at: 18, kot: 'preparing', by: 'usr_wait2', items: [mk('Margherita Pizza', 1, 1, [0]), mk('French Fries', 1, 1), mk('Cold Coffee', 2)] },
    { table: 'tbl_5', type: 'dine_in', at: 9, kot: 'new', by: 'usr_wait', items: [mk('Masala Dosa', 2), mk('Filter Coffee', 2), mk('Idli (2 pcs)', 1, -1, [], 'Extra chutney')] },
    { table: 'tbl_8', type: 'dine_in', at: 27, kot: 'preparing', by: 'usr_wait2', items: [mk('Paneer Burger', 1, -1, [0]), mk('Chicken Burger', 2, -1, [0, 1]), mk('Mango Lassi', 2)] },
    { table: 'tbl_10', type: 'dine_in', at: 55, kot: 'completed', by: 'usr_wait', items: [mk('Mutton Biryani', 1, 1), mk('Parotta', 4), mk('Gulab Jamun (2 pcs)', 2)] },
    { type: 'takeaway', at: 6, kot: 'new', by: 'usr_cash', items: [mk('Chicken Burger', 1, -1, [0]), mk('French Fries', 1, 0, [0])] },
    { type: 'takeaway', at: 12, kot: 'ready', by: 'usr_cash', items: [mk('Veg Fried Rice', 1), mk('Gobi Manchurian', 1, -1, [], 'Less spicy')] },
  ]
  running.forEach((r) => {
    const at = mins(r.at)
    const o = createOrder(at, { status: 'open', type: r.type, tableId: r.table ?? null, by: r.by, items: r.items })
    o.source = r.type === 'dine_in' ? 'table' : 'mobile'
    createKot(o, mins(Math.max(1, r.at - 1)), r.kot)
  })

  // Outstanding: a couple of older credit dues partially collected.
  creditCustomers.slice(0, 2).forEach((c, i) => {
    const due = orders.find((o) => o.customerId === c.id && o.balance > 0)
    if (!due) return
    const amt = Math.min(due.balance, i === 0 ? 100 : Math.round(due.balance / 2))
    const at = new Date(due.createdAt); at.setDate(at.getDate() + 2)
    if (at > now) return
    payments.push({ id: `pay_${payments.length + 1}`, businessId: BIZ, branchId: BR, orderId: due.id, customerId: c.id, method: 'upi', kind: 'due_collection', amount: amt, reference: '', voided: false, ...audit(at) })
    due.paid = r2(due.paid + amt); due.balance = r2(due.total - due.paid)
    due.paymentStatus = due.balance <= 0 ? 'paid' : 'partial'
  })

  // ---------- Expenses ----------
  const expenses: Expense[] = []
  const exp = (at: Date, category: ExpenseCategory, amount: number, notes: string, method: PaymentMethod = 'cash') =>
    expenses.push({ id: `exp_${expenses.length + 1}`, businessId: BIZ, branchId: BR, date: at.toISOString(), category, amount, method, notes, voided: false, ...audit(at) })
  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const at = new Date(d); at.setHours(8, between(5, 50), 0, 0)
    if (at > now) at.setTime(now.getTime() - 60 * 60000)
    exp(at, 'purchase', between(14, 26) * 50, pick(['Vegetables — Koyambedu market', 'Vegetables & greens', 'Onion, tomato, chilli']))
    if (rand() < 0.75) exp(new Date(at.getTime() + 30 * 60000), 'purchase', between(18, 32) * 50, pick(['Chicken — 12 kg', 'Chicken — 15 kg', 'Mutton — 4 kg']), 'upi')
    // Big monthly bills only on past days so today's demo dashboard reads naturally.
    const past = d.getTime() < today0.getTime()
    if (past && d.getDate() === 1) exp(at, 'salary', 68000, 'Staff salary — 6 staff', 'bank')
    if (past && d.getDate() === 5) exp(at, 'rent', 35000, 'Shop rent', 'bank')
    if (past && d.getDate() === 10) exp(at, 'electricity', between(70, 95) * 100, 'EB bill', 'upi')
    if (rand() < 0.2) exp(at, 'transport', between(3, 8) * 50, 'Auto — market pickup')
    if (rand() < 0.08) exp(at, 'maintenance', between(5, 25) * 100, pick(['Gas stove repair', 'Fridge service', 'Plumbing']))
    if (past && d.getDay() === 1) exp(at, 'purchase', between(40, 70) * 100, 'Rice, oil, masala — wholesale', 'bank')
    if (d.getDay() === 3) exp(at, 'other', 1450, 'LPG cylinder')
  }

  // ---------- Inventory movements (tracked items) ----------
  const stockMovements: StockMovement[] = []
  const tracked = products.filter((p) => p.trackStock)
  const balances: Record<string, number> = {}
  const move = (p: Product, at: Date, type: StockMovement['type'], qty: number, note: string) => {
    balances[p.id] = (balances[p.id] ?? 0) + qty
    stockMovements.push({ id: `stm_${stockMovements.length + 1}`, businessId: BIZ, branchId: BR, productId: p.id, type, qty, balanceAfter: balances[p.id], refId: null, note, ...audit(at) })
  }
  tracked.forEach((p) => move(p, start, 'opening', p.lowStockAt * 4, 'Opening stock'))
  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const day0 = new Date(d); day0.setHours(0, 0, 0, 0)
    const day1 = new Date(day0); day1.setDate(day1.getDate() + 1)
    tracked.forEach((p) => {
      const sold = orders.filter((o) => o.status !== 'cancelled' && new Date(o.createdAt) >= day0 && new Date(o.createdAt) < day1)
        .reduce((s, o) => s + o.items.filter((i) => i.productId === p.id).reduce((a, i) => a + i.qty, 0), 0)
      if ((balances[p.id] ?? 0) - sold < p.lowStockAt * 0.8 && d.getTime() < today0.getTime()) {
        const at = new Date(day0); at.setHours(9, 30)
        move(p, at, 'purchase', p.lowStockAt * 3, 'Supplier delivery')
      }
      if (sold) { const at = new Date(day0); at.setHours(22, 45); move(p, at > now ? now : at, 'sale', -sold, isTodayLabel(day0, today0)) }
    })
  }
  // A couple of wastage/damage entries + push two items low for alerts.
  const coke = byName('Coke (300ml)'); const ice = byName('Ice Cream')
  move(byName('Brownie with Ice Cream'), mins(300), 'wastage', -2, 'Expired')
  move(coke, mins(240), 'damage', -3, 'Broken bottles')
  if ((balances[coke.id] ?? 0) > 9) move(coke, mins(120), 'adjustment', -((balances[coke.id] ?? 0) - 9), 'Physical count correction')
  if ((balances[ice.id] ?? 0) > 6) move(ice, mins(90), 'wastage', -((balances[ice.id] ?? 0) - 6), 'Freezer issue — melted')
  tracked.forEach((p) => { p.stock = Math.max(0, balances[p.id] ?? 0) })

  biz.billing.nextOrderNumber = orderNo
  biz.billing.nextInvoiceNumber = invNo
  biz.billing.nextKotNumber = kotNo

  const db: DB = {
    version,
    seededAt: now.toISOString(),
    businesses: [biz],
    branches: [{ id: BR, businessId: BIZ, name: 'T. Nagar', address: biz.address, phone: biz.phone, isDefault: true, active: true }],
    roles, users, categories: cats, products, customers, orders, payments, kots, tables, expenses, stockMovements,
    specials: demoSpecials(BIZ, products), campaigns: [], batches: [], auditLogs: [],
    admins: [], subscriptionPeriods: [], adminAudit: [], platform: { pricePerBranchMonth: 499 }, waMessages: [], secrets: [], returns: [], attendance: [], advances: [], salaries: [], reminderLog: [], tickets: [], suppliers: [], purchases: [], supplierPayments: [], points: [],
  }
  // Per-branch stock for the main branch, then two extra demo branches.
  for (const p of products) p.stockByBranch = p.trackStock ? { [BR]: p.stock } : {}
  addDemoBranches(db, BIZ)
  return db
}

function isTodayLabel(day: Date, today0: Date) {
  return day.getTime() >= today0.getTime() ? 'Sales today (running)' : 'Daily sales'
}

/** A sample "today's specials" list for the demo restaurant. */
export function demoSpecials(businessId: string, products: Product[], date = dateKey()): Special[] {
  const picks: [string, number | null, string][] = [
    ['Chicken Biryani', null, 'Chef’s pick'],
    ['Ghee Roast', 90, 'Today only'],
    ['Mango Lassi', 60, 'Offer'],
    ['Paneer Tikka Pizza', null, 'New'],
    ['Gulab Jamun (2 pcs)', 40, 'Sweet deal'],
  ]
  return picks.flatMap(([name, price, tag], i) => {
    const p = products.find((x) => x.businessId === businessId && x.name === name)
    return p ? [{ id: `spl_${date}_${i}`, businessId, date, productId: p.id, specialPrice: p.variants.length ? null : price, tag, sort: i }] : []
  })
}

/**
 * Adds two sample branches (Adyar, Velachery) with staff, tables, per-branch stock and ~10 days of
 * lighter sales history to an existing business. Used by fresh demo seeds and by Settings → Branches.
 */
export function addDemoBranches(d: DB, businessId: string) {
  const biz = d.businesses.find((x) => x.id === businessId)
  if (!biz || d.branches.some((x) => x.businessId === businessId && (x.name === 'Adyar' || x.name === 'Velachery'))) return
  const rand = rng(424242)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1))
  const now = new Date()
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0)
  const owner = d.users.find((u) => u.businessId === businessId && d.roles.find((r) => r.id === u.roleId)?.permissions.includes('*' as never))?.id ?? 'system'
  const stampAt = (at: Date, by: string) => { const iso = at.toISOString(); return { createdAt: iso, createdBy: by, updatedAt: iso, updatedBy: by } }
  const roleId = (name: string) => d.roles.find((r) => r.businessId === businessId && r.name === name)?.id ?? d.roles.find((r) => r.businessId === businessId)!.id

  const products = d.products.filter((p) => p.businessId === businessId && p.active)
  if (!products.length) return
  const popular: Record<string, number> = { 'Chicken Biryani': 12, 'Chicken Burger': 10, 'Masala Dosa': 9, 'French Fries': 7, 'Cold Coffee': 6, 'Filter Coffee': 6, 'Parotta': 6 }
  const pool = products.flatMap((p) => Array.from({ length: popular[p.name] ?? 2 }, () => p))
  const customers = d.customers.filter((c) => c.businessId === businessId)

  const defs = [
    { name: 'Adyar', address: '4, LB Road, Adyar, Chennai 600020', phone: '+91 98765 43211', prefix: 'AD-', tables: 8, perDay: [16, 24] as const,
      staff: [{ name: 'Selvi', phone: '9876500011', role: 'Cashier' }, { name: 'Mani', phone: '9876500012', role: 'Waiter' }], lowCoke: true },
    { name: 'Velachery', address: '21, 100 Feet Road, Velachery, Chennai 600042', phone: '+91 98765 43212', prefix: 'VL-', tables: 6, perDay: [9, 15] as const,
      staff: [{ name: 'Deepak', phone: '9876500013', role: 'Cashier' }], lowCoke: false },
  ]

  for (const def of defs) {
    const branchId = `br_${def.name.toLowerCase()}`
    d.branches.push({ id: branchId, businessId, name: def.name, address: def.address, phone: def.phone, isDefault: false, active: true, invoicePrefix: def.prefix, nextInvoiceNumber: 10001 })
    const br = d.branches[d.branches.length - 1]

    const tableIds: string[] = []
    for (let i = 1; i <= def.tables; i++) {
      const id = `tbl_${def.name.toLowerCase()}_${i}`
      tableIds.push(id)
      d.tables.push({ id, businessId, branchId, label: `T${i}`, floor: 'Main hall', seats: [2, 4, 4, 6][i % 4], mergedInto: null })
    }

    const staffIds: string[] = []
    for (const st of def.staff) {
      if (d.users.some((u) => u.phone === st.phone)) continue
      const id = `usr_${st.name.toLowerCase()}`
      d.users.push({ id, businessId, branchId, branchIds: [branchId], name: st.name, phone: st.phone, email: '', password: 'demo123', roleId: roleId(st.role), active: true, ...stampAt(today0, owner) })
      staffIds.push(id)
    }
    if (!staffIds.length) staffIds.push(owner)

    // Separate stock per branch
    for (const p of products.filter((x) => x.trackStock)) {
      p.stockByBranch ??= {}
      const qty = def.lowCoke && p.name.startsWith('Coke') ? 3 : p.lowStockAt * 3
      p.stockByBranch[branchId] = qty
      p.stock = Object.values(p.stockByBranch).reduce((a, v) => a + v, 0)
      d.stockMovements.push({ id: `stm_${branchId}_${p.id}`, businessId, branchId, productId: p.id, type: 'opening', qty, balanceAfter: qty, refId: null, note: 'Opening stock', ...stampAt(today0, owner) })
    }

    const makeOrder = (at: Date, status: 'completed' | 'open', opts: { type?: OrderType; tableId?: string | null; qr?: boolean } = {}) => {
      const items: OrderItem[] = []
      for (let i = 0, n = between(1, 3); i < n; i++) {
        const p = pick(pool)
        if (items.some((x) => x.productId === p.id)) continue
        items.push(makeItem(p, biz.billing, { variant: p.variants.length ? pick(p.variants) : null, qty: rand() < 0.8 ? 1 : 2 }))
      }
      const type: OrderType = opts.type ?? (rand() < 0.45 ? 'dine_in' : rand() < 0.75 ? 'takeaway' : 'delivery')
      const t = computeTotals(items, 0, biz.billing)
      const by = pick(staffIds)
      const o: Order = {
        id: `ord_${branchId}_${biz.billing.nextOrderNumber}`, number: `${biz.billing.orderPrefix}${biz.billing.nextOrderNumber++}`,
        businessId, branchId, type, tableId: type === 'dine_in' ? (opts.tableId ?? pick(tableIds)) : null,
        customerId: customers.length && rand() < 0.15 ? pick(customers).id : null, status, items: items.map((i) => ({ ...i, kotQty: i.qty })), notes: '',
        ...t, paid: 0, balance: t.total, paymentStatus: 'unpaid', invoiceNumber: null, billedAt: null, cancelledAt: null, cancelReason: null,
        source: opts.qr ? 'qr' : type === 'dine_in' ? 'table' : 'pos', ...stampAt(at, by),
      }
      if (opts.qr) { o.qrStatus = 'pending'; o.items.forEach((i) => { i.kotQty = 0 }); o.guest = { name: pick(['Arun', 'Meena', 'Vijay']), phone: '98400' + between(10000, 99999), address: '' } }
      if (status === 'completed') {
        const billedAt = new Date(at.getTime() + between(5, 40) * 60000)
        o.invoiceNumber = `${br.invoicePrefix}${br.nextInvoiceNumber!++}`
        o.billedAt = o.updatedAt = billedAt.toISOString()
        const x = rand()
        const method: PaymentMethod = x < 0.4 ? 'cash' : x < 0.82 ? 'upi' : 'card'
        d.payments.push({ id: `pay_${o.id}`, businessId, branchId, orderId: o.id, customerId: o.customerId, method, kind: 'sale', amount: o.total, reference: '', voided: false, ...stampAt(billedAt, by) })
        o.paid = o.total; o.balance = 0; o.paymentStatus = 'paid'
      }
      d.orders.push(o)
      return o
    }

    const hours = [8, 9, 11, 12, 12, 13, 13, 14, 16, 17, 19, 19, 20, 20, 21, 21]
    for (let back = 10; back >= 0; back--) {
      const day = new Date(today0); day.setDate(day.getDate() - back)
      const isToday = back === 0
      let count = between(def.perDay[0], def.perDay[1])
      if (isToday) count = Math.max(0, Math.floor(((now.getHours() - 8) + now.getMinutes() / 60) * (count / 14)))
      const times = Array.from({ length: count }, () => { const t = new Date(day); t.setHours(pick(hours), between(0, 59), 0, 0); return t })
        .filter((t) => !isToday || t.getTime() < now.getTime() - 15 * 60000).sort((a, b) => a.getTime() - b.getTime())
      times.forEach((t) => makeOrder(t, 'completed'))
      const exAt = new Date(day); exAt.setHours(8, 30, 0, 0)
      if (exAt <= now) d.expenses.push({ id: `exp_${branchId}_${back}`, businessId, branchId, date: exAt.toISOString(), category: 'purchase', amount: between(8, 16) * 50, method: 'cash', notes: 'Vegetables & groceries', voided: false, ...stampAt(exAt, owner) })
    }

    // Live right now: a running table with a late kitchen ticket, and (Velachery) a QR order waiting
    const running = makeOrder(new Date(now.getTime() - 26 * 60000), 'open', { type: 'dine_in', tableId: tableIds[1] })
    d.kots.push({
      id: `kot_${branchId}_1`, number: `KOT-${String(biz.billing.nextKotNumber++).padStart(4, '0')}`, businessId, branchId, orderId: running.id, orderNumber: running.number,
      orderType: 'dine_in', tableLabel: 'T2', items: running.items.map((i) => ({ name: i.name + (i.variantName ? ` (${i.variantName})` : ''), qty: i.qty, notes: '', isVeg: true })),
      status: 'preparing', statusAt: new Date(now.getTime() - 20 * 60000).toISOString(), ...stampAt(new Date(now.getTime() - 25 * 60000), running.createdBy),
    })
    if (def.name === 'Velachery') makeOrder(new Date(now.getTime() - 3 * 60000), 'open', { type: 'takeaway', qr: true })
  }

  // The demo manager looks after the main branch and Adyar.
  const main = d.branches.find((x) => x.businessId === businessId && x.isDefault)
  const manager = d.users.find((u) => u.businessId === businessId && d.roles.find((r) => r.id === u.roleId)?.name === 'Manager')
  if (main && manager) manager.branchIds = [main.id, 'br_adyar']
}
