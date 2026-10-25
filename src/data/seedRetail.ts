// Demo data for two retail businesses: a supermarket and a hardware / electricals shop.
// Same common core as the restaurant demo — only the template, catalogue and units differ.
import { makeItem } from '@/core/orderItem'
import { computeTotals, r2 } from '@/core/pricing'
import type { Business, Customer, Order, OrderItem, OrderType, PaymentMethod, Product, ProductDetails } from '@/core/types'
import { dateKey } from '@/core/specials'
import type { DB } from './db'
import { defaultRoles, newBusiness, rng } from './seed'

interface ItemDef {
  name: string; cat: string; price: number; cost: number; unit: string; tax: 0 | 5 | 12 | 18; emoji: string
  barcode?: boolean; low?: number; pop?: number; qty?: number[]
  // food shops
  variants?: [string, number][]; addOns?: [string, number][]; nonVeg?: boolean; kitchen?: boolean; noStock?: boolean
  // textile shops
  mrp?: number; details?: ProductDetails
}
interface ShopSpec {
  id: string; name: string; subType: string; category?: 'retail' | 'food'; orderTypes?: OrderType[]
  specials?: [string, number | null, string][] // product name, offer price, tag (today)
  emoji: string; address: string; phone: string; email: string; gstin: string
  invoicePrefix: string; defaultTax: 'tax_0' | 'tax_5' | 'tax_18'; footer: string; seed: number; ean: string
  categories: [string, string, string, string?][] // id, name, emoji, HSN (optional)
  items: ItemDef[]
  users: { id: string; name: string; phone: string; role: 'Owner' | 'Manager' | 'Cashier' | 'Kitchen Staff' }[]
  customers: { name: string; notes?: string; credit?: boolean }[]
  perDay: [number, number]; linesPerBill: [number, number]; deliveryShare: number; creditShare: number
  expenses: { notes: string; category: 'purchase' | 'transport' | 'electricity' | 'other'; min: number; max: number; every: number }[]
  /** Counter salespeople without an app login (textile): picked on bills, paid salary + commission. */
  sellers?: { id: string; name: string; phone: string; salary: number; commissionPct: number }[]
  /** In-store codes (20…) on every item, for QR price stickers. */
  inStoreCodes?: boolean
}

/** EAN-13 with a valid check digit, e.g. 890 + 4-digit company + 5-digit item. */
function ean13(prefix12: string) {
  const digits = prefix12.split('').map(Number)
  const sum = digits.reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0)
  return prefix12 + ((10 - (sum % 10)) % 10)
}

const SUPERMARKET: ShopSpec = {
  id: 'biz_freshmart', name: 'FreshMart Supermarket', subType: 'Supermarket', emoji: '🛒',
  address: '45, 2nd Avenue, Anna Nagar, Chennai 600040', phone: '+91 98765 11110', email: 'hello@freshmart.in', gstin: '33FRSHM1234A1Z2',
  invoicePrefix: 'FM-', defaultTax: 'tax_5', footer: 'Thank you for shopping with us!', seed: 5150, ean: '8904000',
  categories: [['rice', 'Rice & Atta', '🌾'], ['dal', 'Dal & Pulses', '🫘'], ['oil', 'Oil & Ghee', '🫗'], ['masala', 'Masala & Spices', '🌶️'],
    ['snacks', 'Snacks & Biscuits', '🍪'], ['bev', 'Tea & Coffee', '☕'], ['dairy', 'Milk & Dairy', '🥛'], ['care', 'Personal Care', '🧴'], ['home', 'Household', '🧽']],
  items: [
    { name: 'Ponni Rice (loose)', cat: 'rice', price: 62, cost: 52, unit: 'kg', tax: 0, emoji: '🍚', low: 40, pop: 9, qty: [1, 2, 5, 10] },
    { name: 'Basmati Rice 1 kg', cat: 'rice', price: 145, cost: 118, unit: 'pack', tax: 5, emoji: '🍚', barcode: true, pop: 3 },
    { name: 'Wheat Atta 5 kg', cat: 'rice', price: 285, cost: 248, unit: 'pack', tax: 5, emoji: '🌾', barcode: true, pop: 4 },
    { name: 'Sugar (loose)', cat: 'rice', price: 46, cost: 41, unit: 'kg', tax: 5, emoji: '🧂', low: 25, pop: 7, qty: [0.5, 1, 2] },
    { name: 'Salt 1 kg', cat: 'rice', price: 28, cost: 21, unit: 'pack', tax: 0, emoji: '🧂', barcode: true, pop: 4 },
    { name: 'Toor Dal 1 kg', cat: 'dal', price: 160, cost: 138, unit: 'pack', tax: 5, emoji: '🫘', barcode: true, pop: 6 },
    { name: 'Moong Dal 500 g', cat: 'dal', price: 78, cost: 66, unit: 'pack', tax: 5, emoji: '🫘', barcode: true, pop: 3 },
    { name: 'Urad Dal 1 kg', cat: 'dal', price: 140, cost: 121, unit: 'pack', tax: 5, emoji: '🫘', barcode: true, pop: 4 },
    { name: 'Chana Dal 1 kg', cat: 'dal', price: 96, cost: 82, unit: 'pack', tax: 5, emoji: '🫘', barcode: true, pop: 2 },
    { name: 'Sunflower Oil 1 L', cat: 'oil', price: 145, cost: 128, unit: 'pack', tax: 5, emoji: '🫗', barcode: true, pop: 6 },
    { name: 'Groundnut Oil 1 L', cat: 'oil', price: 190, cost: 168, unit: 'pack', tax: 5, emoji: '🥜', barcode: true, pop: 3 },
    { name: 'Gingelly Oil 500 ml', cat: 'oil', price: 180, cost: 155, unit: 'bottle', tax: 5, emoji: '🫗', barcode: true, pop: 2 },
    { name: 'Cow Ghee 500 ml', cat: 'oil', price: 320, cost: 280, unit: 'bottle', tax: 12, emoji: '🧈', barcode: true, pop: 2, low: 6 },
    { name: 'Sambar Powder 100 g', cat: 'masala', price: 48, cost: 38, unit: 'pack', tax: 5, emoji: '🌶️', barcode: true, pop: 4 },
    { name: 'Turmeric Powder 100 g', cat: 'masala', price: 32, cost: 25, unit: 'pack', tax: 5, emoji: '🟡', barcode: true, pop: 3 },
    { name: 'Chilli Powder 100 g', cat: 'masala', price: 40, cost: 31, unit: 'pack', tax: 5, emoji: '🌶️', barcode: true, pop: 3 },
    { name: 'Garam Masala 50 g', cat: 'masala', price: 55, cost: 43, unit: 'pack', tax: 5, emoji: '🫙', barcode: true, pop: 2 },
    { name: 'Marie Biscuits', cat: 'snacks', price: 30, cost: 25, unit: 'pack', tax: 18, emoji: '🍪', barcode: true, pop: 5 },
    { name: 'Good Day Cashew', cat: 'snacks', price: 35, cost: 29, unit: 'pack', tax: 18, emoji: '🍪', barcode: true, pop: 4 },
    { name: 'Potato Chips 52 g', cat: 'snacks', price: 20, cost: 16, unit: 'pack', tax: 12, emoji: '🥔', barcode: true, pop: 6 },
    { name: 'Murukku 200 g', cat: 'snacks', price: 60, cost: 46, unit: 'pack', tax: 12, emoji: '🥨', barcode: true, pop: 3 },
    { name: 'Tea Powder 250 g', cat: 'bev', price: 140, cost: 118, unit: 'pack', tax: 5, emoji: '🍵', barcode: true, pop: 4 },
    { name: 'Instant Coffee 50 g', cat: 'bev', price: 165, cost: 140, unit: 'jar', tax: 18, emoji: '☕', barcode: true, pop: 2 },
    { name: 'Health Drink 500 g', cat: 'bev', price: 265, cost: 228, unit: 'jar', tax: 18, emoji: '🥤', barcode: true, pop: 2, low: 5 },
    { name: 'Milk 500 ml', cat: 'dairy', price: 27, cost: 24, unit: 'pack', tax: 0, emoji: '🥛', barcode: true, pop: 9, low: 30, qty: [1, 1, 2, 2, 4] },
    { name: 'Curd 400 g', cat: 'dairy', price: 40, cost: 33, unit: 'pack', tax: 0, emoji: '🥣', barcode: true, pop: 5, low: 10 },
    { name: 'Paneer 200 g', cat: 'dairy', price: 90, cost: 76, unit: 'pack', tax: 5, emoji: '🧀', barcode: true, pop: 2, low: 6 },
    { name: 'Butter 100 g', cat: 'dairy', price: 58, cost: 50, unit: 'pack', tax: 12, emoji: '🧈', barcode: true, pop: 2 },
    { name: 'Toothpaste 150 g', cat: 'care', price: 110, cost: 92, unit: 'pc', tax: 18, emoji: '🪥', barcode: true, pop: 3 },
    { name: 'Bath Soap', cat: 'care', price: 45, cost: 36, unit: 'pc', tax: 18, emoji: '🧼', barcode: true, pop: 4 },
    { name: 'Shampoo 180 ml', cat: 'care', price: 185, cost: 152, unit: 'bottle', tax: 18, emoji: '🧴', barcode: true, pop: 2 },
    { name: 'Detergent Powder 1 kg', cat: 'home', price: 130, cost: 108, unit: 'pack', tax: 18, emoji: '🧺', barcode: true, pop: 3 },
    { name: 'Dishwash Bar', cat: 'home', price: 25, cost: 20, unit: 'pc', tax: 18, emoji: '🧽', barcode: true, pop: 4 },
    { name: 'Floor Cleaner 1 L', cat: 'home', price: 199, cost: 165, unit: 'bottle', tax: 18, emoji: '🧴', barcode: true, pop: 2, low: 4 },
  ],
  users: [
    { id: 'usr_fm_owner', name: 'Lakshmi Narayanan', phone: '9876511111', role: 'Owner' },
    { id: 'usr_fm_cash', name: 'Kavya', phone: '9876511112', role: 'Cashier' },
  ],
  customers: [{ name: 'Revathi', credit: true, notes: 'Monthly account' }, { name: 'Karthik' }, { name: 'Nandhini' }, { name: 'Suresh Kumar', credit: true }, { name: 'Bhavani' }, { name: 'Prabhu' }, { name: 'Geetha' }, { name: 'Ashok' }],
  perDay: [22, 34], linesPerBill: [2, 7], deliveryShare: 0.12, creditShare: 0.04,
  expenses: [
    { notes: 'Supplier — dairy (milk, curd)', category: 'purchase', min: 1800, max: 2600, every: 1 },
    { notes: 'Delivery boy petrol', category: 'transport', min: 150, max: 300, every: 1 },
    { notes: 'Wholesale — FMCG stock', category: 'purchase', min: 12000, max: 22000, every: 4 },
  ],
}

const HARDWARE: ShopSpec = {
  id: 'biz_murugan_hw', name: 'Sri Murugan Hardware & Electricals', subType: 'Hardware', emoji: '🔧',
  address: '8, GST Road, Tambaram, Chennai 600045', phone: '+91 98765 22220', email: 'murugan.hw@gmail.com', gstin: '33MRGHW5678B1Z9',
  invoicePrefix: 'HW-', defaultTax: 'tax_18', footer: 'Goods once sold can be exchanged within 7 days with bill.', seed: 9090, ean: '8905000',
  categories: [['switch', 'Switches & Sockets', '🔌'], ['wire', 'Wires & Cables', '🧵'], ['pipe', 'Pipes & Fittings', '🔧'], ['light', 'Lighting', '💡'],
    ['fan', 'Fans', '🌀'], ['tools', 'Tools', '🛠️'], ['paint', 'Paints', '🎨'], ['plumb', 'Plumbing', '🚰'], ['fast', 'Screws & Nails', '🔩']],
  items: [
    { name: 'Modular Switch 6A', cat: 'switch', price: 45, cost: 32, unit: 'pc', tax: 18, emoji: '🔘', barcode: true, pop: 8, qty: [1, 2, 4, 6, 10] },
    { name: 'Modular Switch 16A', cat: 'switch', price: 85, cost: 62, unit: 'pc', tax: 18, emoji: '🔘', barcode: true, pop: 4, qty: [1, 2, 4] },
    { name: '5-Pin Socket 6A', cat: 'switch', price: 95, cost: 70, unit: 'pc', tax: 18, emoji: '🔌', barcode: true, pop: 5, qty: [1, 2, 4] },
    { name: 'Switch Plate 8-Module', cat: 'switch', price: 180, cost: 130, unit: 'pc', tax: 18, emoji: '⬜', barcode: true, pop: 3 },
    { name: 'MCB 32A Single Pole', cat: 'switch', price: 320, cost: 245, unit: 'pc', tax: 18, emoji: '⚡', barcode: true, pop: 2, low: 5 },
    { name: 'Extension Box 4-Way', cat: 'switch', price: 350, cost: 260, unit: 'pc', tax: 18, emoji: '🔌', barcode: true, pop: 3 },
    { name: 'Wire 1.0 sqmm (90 m)', cat: 'wire', price: 1450, cost: 1180, unit: 'coil', tax: 18, emoji: '🧵', barcode: true, pop: 2, low: 4 },
    { name: 'Wire 1.5 sqmm', cat: 'wire', price: 22, cost: 16, unit: 'mtr', tax: 18, emoji: '🧵', pop: 6, low: 100, qty: [5, 10, 15, 20, 30] },
    { name: 'Wire 2.5 sqmm (90 m)', cat: 'wire', price: 2750, cost: 2280, unit: 'coil', tax: 18, emoji: '🧵', barcode: true, pop: 1, low: 3 },
    { name: 'Insulation Tape', cat: 'wire', price: 15, cost: 9, unit: 'roll', tax: 18, emoji: '🎞️', barcode: true, pop: 7, qty: [1, 2, 5] },
    { name: 'PVC Pipe 20 mm (3 m)', cat: 'pipe', price: 120, cost: 88, unit: 'pc', tax: 18, emoji: '🟫', barcode: true, pop: 4, qty: [1, 2, 5, 10] },
    { name: 'Conduit Pipe 25 mm', cat: 'pipe', price: 12, cost: 8, unit: 'ft', tax: 18, emoji: '🟫', pop: 3, low: 80, qty: [10, 20, 40] },
    { name: 'PVC Elbow 20 mm', cat: 'pipe', price: 8, cost: 5, unit: 'pc', tax: 18, emoji: '↪️', barcode: true, pop: 5, qty: [2, 4, 6, 10] },
    { name: 'PVC Tee 20 mm', cat: 'pipe', price: 10, cost: 6, unit: 'pc', tax: 18, emoji: '⊤', barcode: true, pop: 3, qty: [2, 4, 6] },
    { name: 'CPVC Pipe ½" (3 m)', cat: 'pipe', price: 290, cost: 225, unit: 'pc', tax: 18, emoji: '🟨', barcode: true, pop: 2 },
    { name: 'LED Bulb 9W', cat: 'light', price: 99, cost: 68, unit: 'pc', tax: 18, emoji: '💡', barcode: true, pop: 7, qty: [1, 2, 4] },
    { name: 'LED Tube Light 20W', cat: 'light', price: 290, cost: 210, unit: 'pc', tax: 18, emoji: '💡', barcode: true, pop: 3 },
    { name: 'LED Panel 15W', cat: 'light', price: 450, cost: 330, unit: 'pc', tax: 18, emoji: '⬜', barcode: true, pop: 2 },
    { name: 'Ceiling Fan 1200 mm', cat: 'fan', price: 2250, cost: 1820, unit: 'pc', tax: 18, emoji: '🌀', barcode: true, pop: 1, low: 3 },
    { name: 'Exhaust Fan 150 mm', cat: 'fan', price: 1150, cost: 900, unit: 'pc', tax: 18, emoji: '🌀', barcode: true, pop: 1, low: 2 },
    { name: 'Claw Hammer', cat: 'tools', price: 280, cost: 195, unit: 'pc', tax: 18, emoji: '🔨', barcode: true, pop: 2 },
    { name: 'Screwdriver Set', cat: 'tools', price: 350, cost: 240, unit: 'set', tax: 18, emoji: '🪛', barcode: true, pop: 2 },
    { name: 'Line Tester', cat: 'tools', price: 45, cost: 28, unit: 'pc', tax: 18, emoji: '🪛', barcode: true, pop: 4 },
    { name: 'Drill Bit Set', cat: 'tools', price: 420, cost: 300, unit: 'set', tax: 18, emoji: '🛠️', barcode: true, pop: 1 },
    { name: 'Measuring Tape 5 m', cat: 'tools', price: 160, cost: 110, unit: 'pc', tax: 18, emoji: '📏', barcode: true, pop: 2 },
    { name: 'Wall Putty 20 kg', cat: 'paint', price: 780, cost: 640, unit: 'bag', tax: 18, emoji: '🧱', barcode: true, pop: 2, low: 5 },
    { name: 'Primer 1 L', cat: 'paint', price: 260, cost: 200, unit: 'pc', tax: 18, emoji: '🎨', barcode: true, pop: 2 },
    { name: 'Emulsion Paint 4 L', cat: 'paint', price: 1450, cost: 1180, unit: 'pc', tax: 18, emoji: '🎨', barcode: true, pop: 1 },
    { name: 'Bib Tap (Brass)', cat: 'plumb', price: 380, cost: 280, unit: 'pc', tax: 18, emoji: '🚰', barcode: true, pop: 2 },
    { name: 'Teflon Tape', cat: 'plumb', price: 20, cost: 11, unit: 'roll', tax: 18, emoji: '🎞️', barcode: true, pop: 5, qty: [1, 2, 3] },
    { name: 'Ball Valve ½"', cat: 'plumb', price: 240, cost: 175, unit: 'pc', tax: 18, emoji: '🔧', barcode: true, pop: 2 },
    { name: 'Wall Plug (100 pcs)', cat: 'fast', price: 60, cost: 38, unit: 'pack', tax: 18, emoji: '🔩', barcode: true, pop: 4 },
    { name: 'Screws 1" (box)', cat: 'fast', price: 90, cost: 60, unit: 'box', tax: 18, emoji: '🔩', barcode: true, pop: 4 },
    { name: 'Nails 2"', cat: 'fast', price: 110, cost: 82, unit: 'kg', tax: 18, emoji: '📌', pop: 3, low: 15, qty: [0.5, 1, 2] },
  ],
  users: [
    { id: 'usr_hw_owner', name: 'Murugan S', phone: '9876522221', role: 'Owner' },
    { id: 'usr_hw_cash', name: 'Ramesh', phone: '9876522222', role: 'Cashier' },
  ],
  customers: [{ name: 'Raja Electricals (Contractor)', credit: true, notes: 'Pays every Saturday' }, { name: 'Ganesh Plumbing Works', credit: true, notes: 'Contractor — 15 days credit' },
    { name: 'Senthil Builders', credit: true }, { name: 'Anand' }, { name: 'Mohan' }, { name: 'Vasanth' }, { name: 'Priya Interiors', credit: true }],
  perDay: [10, 16], linesPerBill: [1, 4], deliveryShare: 0.08, creditShare: 0.22,
  expenses: [
    { notes: 'Auto charges — stock pickup', category: 'transport', min: 200, max: 500, every: 2 },
    { notes: 'Distributor — electricals', category: 'purchase', min: 18000, max: 35000, every: 5 },
    { notes: 'Shop electricity', category: 'electricity', min: 2800, max: 3400, every: 30 },
  ],
}

function buildShop(d: DB, spec: ShopSpec) {
  if (d.businesses.some((b) => b.id === spec.id)) return
  const rand = rng(spec.seed)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1))
  const now = new Date()
  const start = new Date(now); start.setDate(start.getDate() - 14); start.setHours(9, 0, 0, 0)
  const ownerId = spec.users[0].id
  const at = (t: Date, by = ownerId) => { const iso = t.toISOString(); return { createdAt: iso, createdBy: by, updatedAt: iso, updatedBy: by } }

  const category = spec.category ?? 'retail'
  const food = category === 'food'
  const biz: Business = newBusiness({ id: spec.id, name: spec.name, category, subType: spec.subType, phone: spec.phone, createdAt: start.toISOString() })
  Object.assign(biz, { logoEmoji: spec.emoji, address: spec.address, email: spec.email, gstin: spec.gstin })
  biz.modules = { ...biz.modules, orders: true, inventory: true, customers: true, employees: true, ...(food ? { kitchen: true, mobileOrders: true, specials: true, qrOrdering: true, tables: false } : {}) }
  if (spec.id === 'biz_freshmart' || spec.inStoreCodes) biz.billing.taxMode = 'inclusive' // shelf / MRP prices already include GST
  if (spec.inStoreCodes) biz.modules.customerOrders = false
  if (spec.id === 'biz_murugan_hw') biz.modules.mobileOrders = true // salesmen take orders on the shop floor
  Object.assign(biz.billing, { invoicePrefix: spec.invoicePrefix, defaultTaxRateId: spec.defaultTax, receiptFooter: spec.footer, orderTypes: spec.orderTypes ?? ['counter', 'delivery'], paymentMethods: ['cash', 'upi', 'card', 'credit'] })
  d.businesses.push(biz)

  const branchId = `br_${spec.id.slice(4)}`
  d.branches.push({ id: branchId, businessId: spec.id, name: 'Main', address: spec.address, phone: spec.phone, isDefault: true, active: true })
  const roles = defaultRoles(spec.id)
  d.roles.push(...roles)
  const roleId = (name: string) => roles.find((r) => r.name === name)!.id
  for (const u of spec.users) {
    d.users.push({ id: u.id, businessId: spec.id, branchId, name: u.name, phone: u.phone, email: '', password: 'demo123', roleId: roleId(u.role), active: true, ...at(start) })
  }
  const cashiers = spec.users.filter((u) => u.role !== 'Kitchen Staff').map((u) => u.id)
  for (const x of spec.sellers ?? []) {
    d.users.push({ id: x.id, businessId: spec.id, branchId, name: x.name, phone: x.phone, email: '', password: '', roleId: '', active: true, canLogin: false, pay: { type: 'monthly', amount: x.salary, commissionPct: x.commissionPct }, ...at(start) })
  }
  const sellers = (spec.sellers ?? []).map((x) => x.id)

  spec.categories.forEach(([id, name, emoji, hsn], i) => d.categories.push({ id: `cat_${spec.id}_${id}`, businessId: spec.id, name, emoji, sort: i, ...(hsn ? { hsn } : {}) }))

  const products: Product[] = spec.items.map((it, i) => ({
    id: `prd_${spec.id.slice(4)}_${String(i + 1).padStart(3, '0')}`, businessId: spec.id, name: it.name, categoryId: `cat_${spec.id}_${it.cat}`,
    kind: 'goods', emoji: it.emoji, imageUrl: null, sku: `${spec.invoicePrefix.replace('-', '')}${String(i + 1).padStart(3, '0')}`,
    barcode: spec.inStoreCodes ? ean13(`20${String(i + 1).padStart(10, '0')}`) : it.barcode ? ean13(`${spec.ean}${String(10000 + i * 37).slice(-5)}`) : '',
    unit: it.unit, price: it.variants?.[0]?.[1] ?? it.price, costPrice: it.cost,
    mrp: it.mrp ?? (spec.id === 'biz_freshmart' && it.barcode ? (i % 3 === 0 ? it.price : Math.ceil((it.price * 1.08) / 5) * 5) : null),
    ...(it.details ? { details: it.details } : {}),
    variants: (it.variants ?? []).map(([n, pr], j) => ({ id: `v_${spec.id.slice(4)}_${i}_${j}`, name: n, price: pr })),
    addOns: (it.addOns ?? []).map(([n, pr], j) => ({ id: `ao_${spec.id.slice(4)}_${i}_${j}`, name: n, price: pr })),
    taxRateId: `tax_${it.tax}`,
    trackStock: !it.noStock, stock: 0, stockByBranch: {}, lowStockAt: it.low ?? 10, isVeg: !it.nonVeg, sendToKitchen: !!it.kitchen, active: true, ...at(start),
  }))
  d.products.push(...products)
  const pool = products.flatMap((p, i) => Array.from({ length: spec.items[i].pop ?? 2 }, () => ({ p, def: spec.items[i] })))

  const customers: Customer[] = spec.customers.map((c, i) => ({
    id: `cus_${spec.id.slice(4)}_${i + 1}`, businessId: spec.id, name: c.name, phone: `9${String(830000000 + spec.seed * 7 + i * 98765).slice(0, 9)}`,
    email: '', address: c.credit ? spec.address.split(',').slice(-2).join(',').trim() : '', notes: c.notes ?? '', marketingOptIn: true, ...at(start),
  }))
  d.customers.push(...customers)
  const creditCustomers = customers.filter((_, i) => spec.customers[i].credit)

  // ---- sales history ----
  const sold = new Map<string, number>()
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0)
  const hours = [9, 10, 10, 11, 11, 12, 13, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21]
  for (let day = new Date(start); day <= now; day.setDate(day.getDate() + 1)) {
    const isToday = day.getTime() >= today0.getTime()
    let count = between(spec.perDay[0], spec.perDay[1])
    if (isToday) count = Math.max(0, Math.floor(Math.max(0, now.getHours() - 9 + now.getMinutes() / 60) * (count / 12)))
    const times = Array.from({ length: count }, () => { const t = new Date(day); t.setHours(pick(hours), between(0, 59), 0, 0); return t })
      .filter((t) => !isToday || t.getTime() < now.getTime() - 10 * 60000).sort((a, b) => a.getTime() - b.getTime())
    for (const t of times) {
      const items: OrderItem[] = []
      for (let i = 0, n = between(spec.linesPerBill[0], spec.linesPerBill[1]); i < n; i++) {
        const { p, def } = pick(pool)
        if (items.some((x) => x.productId === p.id)) continue
        const qty = def.qty ? pick(def.qty) : rand() < 0.8 ? 1 : 2
        const variant = p.variants.length ? pick(p.variants) : null
        const addOns = p.addOns.length && rand() < 0.25 ? [pick(p.addOns)] : []
        items.push(makeItem(p, biz.billing, { qty, variant, addOns }))
        sold.set(p.id, r2((sold.get(p.id) ?? 0) + qty))
      }
      const discount = rand() < 0.06 ? pick([5, 10, 20]) : 0
      const totals = computeTotals(items, discount, biz.billing)
      const by = pick(cashiers)
      const billedAt = new Date(t.getTime() + between(1, 4) * 60000)
      const credit = creditCustomers.length > 0 && rand() < spec.creditShare
      const customer = credit ? pick(creditCustomers) : rand() < 0.2 ? pick(customers) : null
      const o: Order = {
        id: `ord_${spec.id.slice(4)}_${biz.billing.nextOrderNumber}`, number: `${biz.billing.orderPrefix}${biz.billing.nextOrderNumber++}`,
        businessId: spec.id, branchId, type: rand() < spec.deliveryShare ? 'delivery' : food && rand() < 0.35 ? 'takeaway' : 'counter', tableId: null, customerId: customer?.id ?? null,
        status: 'completed', items, notes: '', ...totals, paid: 0, balance: totals.total, paymentStatus: 'unpaid',
        invoiceNumber: `${biz.billing.invoicePrefix}${biz.billing.nextInvoiceNumber++}`, billedAt: billedAt.toISOString(),
        cancelledAt: null, cancelReason: null, source: 'pos', ...at(t, by),
        ...(sellers.length && rand() < 0.85 ? { salespersonId: pick(sellers) } : {}),
      }
      if (!credit) {
        const x = rand()
        const method: PaymentMethod = x < 0.42 ? 'cash' : x < 0.85 ? 'upi' : 'card'
        d.payments.push({ id: `pay_${o.id}`, businessId: spec.id, branchId, orderId: o.id, customerId: o.customerId, method, kind: 'sale', amount: o.total, reference: '', voided: false, ...at(billedAt, by) })
        o.paid = o.total; o.balance = 0; o.paymentStatus = 'paid'
      }
      d.orders.push(o)
    }
    let n = 0
    for (const e of spec.expenses) {
      const dayNo = Math.round((day.getTime() - start.getTime()) / 86400000)
      if (dayNo % e.every !== 0) continue
      const t = new Date(day); t.setHours(9, 15 + n * 10, 0, 0)
      if (t > now) continue
      d.expenses.push({ id: `exp_${spec.id.slice(4)}_${dayNo}_${n++}`, businessId: spec.id, branchId, date: t.toISOString(), category: e.category, amount: Math.round(between(e.min, e.max) / 50) * 50, method: e.category === 'purchase' && e.min > 5000 ? 'bank' : 'cash', notes: e.notes, voided: false, ...at(t) })
    }
  }

  // ---- stock: opening − sold, with a few items deliberately low ----
  for (const [i, p] of products.entries()) {
    if (!p.trackStock) continue
    const out = sold.get(p.id) ?? 0
    const low = i % 9 === 4
    const opening = r2(out + (low ? Math.max(1, Math.floor(p.lowStockAt / 2)) : p.lowStockAt * 3 + between(0, p.lowStockAt * 2)))
    const balance = r2(opening - out)
    p.stockByBranch = { [branchId]: balance }
    p.stock = balance
    d.stockMovements.push({ id: `stm_${p.id}_open`, businessId: spec.id, branchId, productId: p.id, type: 'opening', qty: opening, balanceAfter: opening, refId: null, note: 'Opening stock', ...at(start) })
    if (out) d.stockMovements.push({ id: `stm_${p.id}_sold`, businessId: spec.id, branchId, productId: p.id, type: 'sale', qty: -out, balanceAfter: balance, refId: null, note: 'Sales (last 14 days)', ...at(now) })
  }

  // ---- food shops: today's specials + one order cooking in the kitchen ----
  if (food) {
    const today = dateKey()
    for (const [i, [name, price, tag]] of (spec.specials ?? []).entries()) {
      const p = products.find((x) => x.name === name)
      if (p) d.specials.push({ id: `spl_${spec.id}_${i}`, businessId: spec.id, date: today, productId: p.id, specialPrice: p.variants.length ? null : price, tag, sort: i })
    }
    const cook = products.filter((p) => p.sendToKitchen).slice(0, 2)
    if (cook.length) {
      const items = cook.map((p) => ({ ...makeItem(p, biz.billing, { variant: p.variants[0] ?? null }), kotQty: 1 }))
      const t0 = new Date(now.getTime() - 7 * 60000)
      const o: Order = {
        id: `ord_${spec.id.slice(4)}_${biz.billing.nextOrderNumber}`, number: `${biz.billing.orderPrefix}${biz.billing.nextOrderNumber++}`,
        businessId: spec.id, branchId, type: 'takeaway', tableId: null, customerId: null, status: 'open', items, notes: '',
        ...computeTotals(items, 0, biz.billing), paid: 0, balance: 0, paymentStatus: 'unpaid', invoiceNumber: null, billedAt: null,
        cancelledAt: null, cancelReason: null, source: 'pos', ...at(t0, cashiers[cashiers.length - 1]),
      }
      o.balance = o.total
      d.orders.push(o)
      d.kots.push({
        id: `kot_${spec.id}_1`, number: `KOT-${String(biz.billing.nextKotNumber++).padStart(4, '0')}`, businessId: spec.id, branchId, orderId: o.id, orderNumber: o.number,
        orderType: 'takeaway', tableLabel: null, items: items.map((i) => ({ name: i.name + (i.variantName ? ` (${i.variantName})` : ''), qty: i.qty, notes: '', isVeg: true })),
        status: 'preparing', statusAt: t0.toISOString(), ...at(t0, o.createdBy),
      })
    }
  }
}

const BAKERY: ShopSpec = {
  id: 'biz_sweetspot', name: 'Sweet Spot Bakery & Café', subType: 'Bakery', emoji: '🧁', category: 'food',
  orderTypes: ['counter', 'takeaway', 'delivery'],
  address: '17, Arcot Road, Vadapalani, Chennai 600026', phone: '+91 98765 33330', email: 'orders@sweetspot.in', gstin: '33SWTSP4321C1Z4',
  invoicePrefix: 'SS-', defaultTax: 'tax_5', footer: 'Fresh every day · Order cakes 1 day ahead', seed: 7373, ean: '8906000',
  categories: [['cake', 'Cakes', '🎂'], ['pastry', 'Pastries', '🧁'], ['puff', 'Puffs & Snacks', '🥐'], ['bread', 'Breads', '🍞'],
    ['cookie', 'Cookies & Biscuits', '🍪'], ['sweet', 'Sweets', '🍬'], ['hot', 'Tea & Coffee', '☕'], ['cool', 'Juices & Shakes', '🥤']],
  items: [
    { name: 'Black Forest Cake', cat: 'cake', price: 450, cost: 230, unit: 'pc', tax: 5, emoji: '🎂', variants: [['½ kg', 450], ['1 kg', 850]], addOns: [['Name on cake', 0], ['Candles', 20]], pop: 3, low: 4 },
    { name: 'Pineapple Cake', cat: 'cake', price: 420, cost: 210, unit: 'pc', tax: 5, emoji: '🍰', variants: [['½ kg', 420], ['1 kg', 800]], addOns: [['Name on cake', 0]], pop: 2, low: 4 },
    { name: 'Chocolate Truffle Cake', cat: 'cake', price: 550, cost: 290, unit: 'pc', tax: 5, emoji: '🎂', variants: [['½ kg', 550], ['1 kg', 1050]], addOns: [['Name on cake', 0], ['Candles', 20]], pop: 2, low: 3, nonVeg: true },
    { name: 'Plum Cake 250 g', cat: 'cake', price: 160, cost: 85, unit: 'pc', tax: 5, emoji: '🍰', barcode: true, pop: 2, nonVeg: true },
    { name: 'Chocolate Pastry', cat: 'pastry', price: 70, cost: 32, unit: 'pc', tax: 5, emoji: '🧁', pop: 6, low: 10, qty: [1, 2, 4] },
    { name: 'Red Velvet Pastry', cat: 'pastry', price: 90, cost: 42, unit: 'pc', tax: 5, emoji: '🧁', pop: 4, low: 8, qty: [1, 2] },
    { name: 'Cup Cake', cat: 'pastry', price: 40, cost: 17, unit: 'pc', tax: 5, emoji: '🧁', pop: 4, low: 12, qty: [1, 2, 6] },
    { name: 'Veg Puff', cat: 'puff', price: 25, cost: 10, unit: 'pc', tax: 5, emoji: '🥐', pop: 9, low: 20, qty: [1, 2, 4, 6], kitchen: true },
    { name: 'Egg Puff', cat: 'puff', price: 30, cost: 12, unit: 'pc', tax: 5, emoji: '🥐', pop: 8, low: 20, qty: [1, 2, 4], nonVeg: true, kitchen: true },
    { name: 'Chicken Puff', cat: 'puff', price: 40, cost: 17, unit: 'pc', tax: 5, emoji: '🥐', pop: 6, low: 15, qty: [1, 2, 4], nonVeg: true, kitchen: true },
    { name: 'Paneer Sandwich', cat: 'puff', price: 80, cost: 34, unit: 'pc', tax: 5, emoji: '🥪', pop: 4, noStock: true, kitchen: true, addOns: [['Extra cheese', 20]] },
    { name: 'Samosa', cat: 'puff', price: 15, cost: 6, unit: 'pc', tax: 5, emoji: '🥟', pop: 6, low: 25, qty: [2, 4, 6], kitchen: true },
    { name: 'Milk Bread 400 g', cat: 'bread', price: 45, cost: 28, unit: 'pc', tax: 0, emoji: '🍞', barcode: true, pop: 6, low: 10 },
    { name: 'Brown Bread 400 g', cat: 'bread', price: 55, cost: 34, unit: 'pc', tax: 0, emoji: '🍞', barcode: true, pop: 3, low: 8 },
    { name: 'Bun (pack of 4)', cat: 'bread', price: 40, cost: 22, unit: 'pack', tax: 0, emoji: '🥯', barcode: true, pop: 3, low: 8 },
    { name: 'Butter Cookies 250 g', cat: 'cookie', price: 120, cost: 62, unit: 'box', tax: 18, emoji: '🍪', barcode: true, pop: 3 },
    { name: 'Coconut Biscuits 200 g', cat: 'cookie', price: 70, cost: 36, unit: 'pack', tax: 18, emoji: '🍪', barcode: true, pop: 3 },
    { name: 'Rusk 300 g', cat: 'cookie', price: 60, cost: 34, unit: 'pack', tax: 5, emoji: '🍞', barcode: true, pop: 2 },
    { name: 'Mysore Pak', cat: 'sweet', price: 120, cost: 60, unit: 'box', tax: 5, emoji: '🍬', variants: [['250 g', 120], ['500 g', 230]], pop: 2, low: 6 },
    { name: 'Badusha', cat: 'sweet', price: 100, cost: 48, unit: 'box', tax: 5, emoji: '🍩', variants: [['250 g', 100], ['500 g', 190]], pop: 2, low: 6 },
    { name: 'Masala Tea', cat: 'hot', price: 20, cost: 6, unit: 'cup', tax: 5, emoji: '☕', pop: 9, noStock: true, kitchen: true, qty: [1, 1, 2] },
    { name: 'Filter Coffee', cat: 'hot', price: 25, cost: 8, unit: 'cup', tax: 5, emoji: '☕', pop: 8, noStock: true, kitchen: true, qty: [1, 1, 2] },
    { name: 'Hot Chocolate', cat: 'hot', price: 90, cost: 32, unit: 'cup', tax: 5, emoji: '🍫', pop: 2, noStock: true, kitchen: true },
    { name: 'Cold Coffee', cat: 'cool', price: 90, cost: 30, unit: 'glass', tax: 5, emoji: '🧋', pop: 4, noStock: true, kitchen: true, addOns: [['Ice cream scoop', 30]] },
    { name: 'Fresh Lime Juice', cat: 'cool', price: 50, cost: 14, unit: 'glass', tax: 5, emoji: '🍋', pop: 4, noStock: true, kitchen: true },
    { name: 'Chocolate Milkshake', cat: 'cool', price: 110, cost: 40, unit: 'glass', tax: 5, emoji: '🥤', pop: 3, noStock: true, kitchen: true, variants: [['Regular', 110], ['Large', 150]] },
  ],
  users: [
    { id: 'usr_ss_owner', name: 'Anitha Raj', phone: '9876533331', role: 'Owner' },
    { id: 'usr_ss_cash', name: 'Vignesh', phone: '9876533332', role: 'Cashier' },
    { id: 'usr_ss_kit', name: 'Banu', phone: '9876533333', role: 'Kitchen Staff' },
  ],
  customers: [{ name: 'Priyanka', notes: 'Birthday cake regular' }, { name: 'Sathish' }, { name: 'Meera' }, { name: 'Office — Zoho Vadapalani', credit: true, notes: 'Evening snacks, pays monthly' }, { name: 'Rahul' }, { name: 'Janani' }],
  perDay: [40, 60], linesPerBill: [1, 3], deliveryShare: 0.08, creditShare: 0.02,
  expenses: [
    { notes: 'Flour, sugar, butter — supplier', category: 'purchase', min: 2500, max: 4500, every: 1 },
    { notes: 'Milk & cream', category: 'purchase', min: 900, max: 1400, every: 1 },
    { notes: 'Gas cylinder', category: 'other', min: 1450, max: 1450, every: 4 },
  ],
  specials: [['Black Forest Cake', null, 'Today’s pick'], ['Chicken Puff', 35, 'Offer'], ['Cold Coffee', 75, 'Happy hour'], ['Mysore Pak', null, 'Fresh batch']],
}

// ---------- Silk & saree shop ----------

type Design = [name: string, cat: string, design: string, fabric: string, mrp: number, pct: number, cost: number, colours: string[], sizes: string[], pop: number]
const DESIGNS: Design[] = [
  ['Kanchipuram Silk Saree', 'silk', 'KS-101', 'Pure silk', 12000, 10, 8400, ['Maroon', 'Bottle Green', 'Mustard'], [], 2],
  ['Arani Silk Saree', 'silk', 'AR-118', 'Silk', 6200, 10, 4300, ['Wine', 'Navy Blue'], [], 2],
  ['Soft Silk Saree', 'silk', 'SS-305', 'Soft silk', 4800, 15, 3100, ['Peacock Blue', 'Rani Pink', 'Lavender'], [], 3],
  ['Kanchipuram Bridal Silk Saree', 'bridal', 'KB-220', 'Pure silk, gold zari', 28500, 5, 21000, ['Red', 'Magenta'], [], 1],
  ['Chettinad Cotton Saree', 'cotton', 'CT-410', 'Cotton', 1450, 10, 900, ['Mustard', 'Grey', 'Rust'], [], 5],
  ['Kovai Cotton Saree', 'cotton', 'KC-512', 'Cotton', 980, 0, 620, ['Off-white', 'Sky Blue'], [], 5],
  ['Fancy Georgette Saree', 'fancy', 'FG-620', 'Georgette', 1850, 20, 1050, ['Black', 'Peach'], [], 4],
  ['Readymade Blouse', 'blouse', 'RB-710', 'Cotton silk', 650, 0, 380, ['Gold'], ['36', '38', '40', '42'], 3],
  ['Silk Cotton Dhoti', 'dhoti', 'SD-801', 'Silk cotton', 1250, 10, 780, ['Cream'], [], 3],
  ['Pattu Pavadai (Kids)', 'kids', 'PP-905', 'Silk', 2400, 10, 1500, ['Red', 'Green'], ['2-3Y', '4-5Y', '6-7Y'], 2],
]
const TEXTILE: ShopSpec = {
  id: 'biz_kanchi_silks', name: 'Kanchi Pattu Maaligai', subType: 'Silk & Sarees', emoji: '🥻', inStoreCodes: true, orderTypes: ['counter'],
  address: '22, Gandhi Road, Kanchipuram 631501', phone: '+91 98765 44440', email: 'sales@kanchipattu.in', gstin: '33KNCPT2468D1Z6',
  invoicePrefix: 'KP-', defaultTax: 'tax_5', footer: 'Exchange within 7 days with bill and tag. No exchange on discounted items.', seed: 4242, ean: '2000000',
  categories: [['silk', 'Silk Sarees', '🥻', '5007'], ['cotton', 'Cotton Sarees', '🌸', '5208'], ['fancy', 'Fancy Sarees', '✨', '5407'], ['bridal', 'Bridal Collection', '💒', '5007'],
    ['blouse', 'Blouse & Materials', '👗', '6206'], ['dhoti', 'Dhoti & Veshti', '🧣', '5208'], ['kids', 'Kids Wear', '🧒', '6209']],
  items: DESIGNS.flatMap(([name, cat, design, fabric, mrp, pct, cost, colours, sizes, pop]) =>
    colours.flatMap((colour) => (sizes.length ? sizes : ['']).map((size): ItemDef => ({
      name: [name, [colour, size].filter(Boolean).join(' / ')].join(' · '), cat, price: pct ? Math.round((mrp * (1 - pct / 100)) / 10) * 10 : mrp, mrp, cost,
      unit: 'pc', tax: 5, emoji: '🥻', low: 1, pop, details: { design, fabric, colour, ...(size ? { size } : {}) },
    })))),
  users: [
    { id: 'usr_kp_owner', name: 'Senthil Kumar', phone: '9876544441', role: 'Owner' },
    { id: 'usr_kp_cash', name: 'Lavanya', phone: '9876544442', role: 'Cashier' },
  ],
  sellers: [
    { id: 'usr_kp_s1', name: 'Meena', phone: '9876544451', salary: 12000, commissionPct: 1 },
    { id: 'usr_kp_s2', name: 'Saravanan', phone: '9876544452', salary: 13000, commissionPct: 1 },
    { id: 'usr_kp_s3', name: 'Divya', phone: '9876544453', salary: 11000, commissionPct: 1.5 },
  ],
  customers: [{ name: 'Kalaiselvi', notes: 'Wedding purchase — Feb' }, { name: 'Rajeswari' }, { name: 'Anusha' }, { name: 'Murali (Wedding)', credit: true, notes: 'Balance on delivery' }, { name: 'Shanthi' }, { name: 'Vidhya' }],
  perDay: [6, 12], linesPerBill: [1, 3], deliveryShare: 0, creditShare: 0.03,
  expenses: [
    { notes: 'Weaver payment — silk sarees', category: 'purchase', min: 40000, max: 90000, every: 6 },
    { notes: 'Courier / parcel', category: 'transport', min: 200, max: 600, every: 2 },
    { notes: 'Showroom electricity', category: 'electricity', min: 4200, max: 5200, every: 30 },
  ],
}

/** Silk & saree demo shop (QR price stickers, MRP + discount, salespeople). */
export function addTextileDemo(d: DB) {
  buildShop(d, TEXTILE)
}
export const TEXTILE_DEMO_ID = TEXTILE.id
/** v26: HSN codes on the saree shop's categories (GST report demo). */
export function addTextileHsn(d: DB) {
  for (const [id, , , hsn] of TEXTILE.categories) { const c = d.categories.find((x) => x.id === `cat_${TEXTILE.id}_${id}`); if (c && hsn && !c.hsn) c.hsn = hsn }
}

/** Adds the supermarket and hardware demo shops if they aren't there yet. */
export function addFoodDemo(d: DB) {
  buildShop(d, BAKERY)
}

export function addRetailDemos(d: DB) {
  buildShop(d, SUPERMARKET)
  buildShop(d, HARDWARE)
}

export const RETAIL_DEMO_IDS = [SUPERMARKET.id, HARDWARE.id]
export const FOOD_DEMO_ID = 'biz_sweetspot'

/** Demo batches with expiry dates close to today (some expiring, one expired) so expiry alerts show. */
export function seedDemoBatches(d: DB) {
  const plan: Record<string, [number, number][]> = { // product name → [share of stock, days to expiry]
    'Milk 500 ml': [[0.3, 1], [0.7, 3]],
    'Curd 400 g': [[0.4, 0], [0.6, 4]],
    'Paneer 200 g': [[1, 5]],
    'Butter 100 g': [[1, 45]],
    'Marie Biscuits': [[0.5, 20], [0.5, 120]],
    'Good Day Cashew': [[0.15, -2], [0.85, 90]],
    'Milk Bread 400 g': [[0.4, 1], [0.6, 3]],
    'Brown Bread 400 g': [[1, 2]],
    'Bun (pack of 4)': [[1, 2]],
  }
  const iso = (days: number) => { const t = new Date(); t.setDate(t.getDate() + days); return t.toISOString().slice(0, 10) }
  const now = new Date().toISOString()
  for (const p of d.products) {
    const rows = plan[p.name]
    if (!rows || p.trackExpiry || !['biz_freshmart', 'biz_sweetspot'].includes(p.businessId)) continue
    p.trackExpiry = true
    for (const [branchId, stock] of Object.entries(p.stockByBranch ?? {})) {
      if (stock <= 0) continue
      let left = stock
      rows.forEach(([share, days], i) => {
        const qty = i === rows.length - 1 ? left : Math.max(1, Math.round(stock * share))
        left = Math.round((left - qty) * 1000) / 1000
        if (qty <= 0) return
        const exp = iso(days)
        d.batches.push({ id: `bat_${p.id}_${i}`, businessId: p.businessId, branchId, productId: p.id, batchNo: `B${exp.replace(/-/g, '').slice(2)}`, expiry: exp, qty, receivedQty: qty, createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' })
      })
    }
  }
}
