// Business configuration: terminology defaults, module registry, business templates, roles.
// Adding a new business type = add a template here (+ an optional module). The core stays untouched.
import type {
  Business, BusinessCategory, QrSettings, ExpenseCategory, ModuleConfig, ModuleKey, OrderType, PaymentMethod, Permission, Terminology,
} from './types'

export const DEFAULT_TERMS: Terminology = {
  product: { singular: 'Product', plural: 'Products' },
  category: { singular: 'Category', plural: 'Categories' },
  customer: { singular: 'Customer', plural: 'Customers' },
  order: { singular: 'Order', plural: 'Orders' },
  invoice: { singular: 'Invoice', plural: 'Invoices' },
  employee: { singular: 'Employee', plural: 'Employees' },
  table: { singular: 'Table', plural: 'Tables' },
  kot: { singular: 'KOT', plural: 'KOTs' },
  expense: { singular: 'Expense', plural: 'Expenses' },
  payment: { singular: 'Payment', plural: 'Payments' },
}

export const TERM_LABELS: Record<keyof Terminology, string> = {
  product: 'Product', category: 'Category', customer: 'Customer', order: 'Order', invoice: 'Invoice',
  employee: 'Employee', table: 'Table', kot: 'Kitchen ticket', expense: 'Expense', payment: 'Payment',
}

export interface ModuleDef {
  key: ModuleKey
  name: string
  description: string
  core?: boolean // always on
  comingSoon?: boolean
  categories: BusinessCategory[] // where it is recommended by default
  /** Shown only for this kind of business (supermarket / hardware screens). */
  only?: 'retailPos'
}

export const MODULES: ModuleDef[] = [
  { key: 'billing', name: 'Billing / POS', description: 'Create bills and collect payments', core: true, categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'products', name: 'Products / Items', description: 'Catalogue with variants, add-ons and units', core: true, categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'orders', name: 'Orders', description: 'Order history, running orders and cancellations', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'customers', name: 'Customers', description: 'Customer profiles, credit and outstanding', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'payments', name: 'Payments', description: 'Payment history and due collection', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'expenses', name: 'Expenses', description: 'Track purchase, salary, rent and more', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'reports', name: 'Reports', description: 'Daily income, sales and product reports', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'inventory', name: 'Inventory', description: 'Stock levels, purchase, wastage, low-stock alerts', categories: ['retail', 'food'] },
  { key: 'customerOrders', name: 'Customer Orders', description: 'Phone / home-delivery orders: New → Packing → Ready → Delivered', categories: ['retail'], only: 'retailPos' },
  { key: 'mobileOrders', name: 'Mobile Order Taking', description: 'Staff take orders on their phone', categories: ['food', 'restaurant'] },
  { key: 'tables', name: 'Table Management', description: 'Dine-in tables, transfer and merge', categories: ['restaurant'] },
  { key: 'kitchen', name: 'Kitchen Display (KOT)', description: 'Send orders to kitchen and track status', categories: ['food', 'restaurant'] },
  { key: 'specials', name: 'Daily Specials', description: 'Highlight today’s specials in billing, menu and a TV display', categories: ['food', 'restaurant'] },
  { key: 'qrOrdering', name: 'QR Ordering', description: 'Customers scan a QR to order — dine-in, takeaway, delivery', categories: ['food', 'restaurant'] },
  { key: 'employees', name: 'Staff & Roles', description: 'Multiple users with role permissions', categories: ['retail', 'food', 'restaurant', 'service'] },
  { key: 'appointments', name: 'Appointments', description: 'Bookings for service businesses', comingSoon: true, categories: ['service'] },
]

/** Modules that apply to this business (hides supermarket-only ones for other shops). */
export const modulesShownFor = (b: Pick<Business, 'category' | 'subType'>) => MODULES.filter((m) => !m.only || usesRetailPos(b))

export function modulesFor(category: BusinessCategory): ModuleConfig {
  const cfg = {} as ModuleConfig
  for (const m of MODULES) cfg[m.key] = !m.comingSoon && (m.core || m.categories.includes(category))
  return cfg
}

export interface BusinessTemplate {
  category: BusinessCategory
  name: string
  emoji: string
  examples: string
  subTypes: string[]
  terms: Partial<Terminology>
  orderTypes: OrderType[]
  units: string[]
}

export const TEMPLATES: BusinessTemplate[] = [
  {
    category: 'food', name: 'Food', emoji: '🍔', examples: 'Bakery, Fast Food, Tea Shop, Juice',
    subTypes: ['Fast Food', 'Bakery', 'Tea Shop', 'Coffee Shop', 'Juice Shop', 'Sweets & Snacks', 'Catering'],
    terms: {
      product: { singular: 'Menu Item', plural: 'Menu Items' },
      invoice: { singular: 'Bill', plural: 'Bills' },
      employee: { singular: 'Staff', plural: 'Staff' },
    },
    orderTypes: ['counter', 'takeaway', 'delivery'],
    units: ['pc', 'plate', 'cup', 'glass', 'kg', 'g', 'box'],
  },
  {
    category: 'restaurant', name: 'Restaurant', emoji: '🍽️', examples: 'Hotel, Cafe, Dine-in, Takeaway',
    subTypes: ['Restaurant', 'Hotel', 'Cafe', 'Family Restaurant', 'Dhaba', 'Cloud Kitchen'],
    terms: {
      product: { singular: 'Menu Item', plural: 'Menu Items' },
      customer: { singular: 'Guest', plural: 'Guests' },
      invoice: { singular: 'Bill', plural: 'Bills' },
      employee: { singular: 'Staff', plural: 'Staff' },
    },
    orderTypes: ['dine_in', 'takeaway', 'delivery'],
    units: ['plate', 'pc', 'bowl', 'cup', 'glass', 'half', 'full'],
  },
  {
    category: 'retail', name: 'Retail', emoji: '🛒', examples: 'Grocery, Supermarket, Fancy Store',
    subTypes: ['Grocery / Maligai', 'Supermarket', 'Fancy Store', 'Electronics', 'Hardware', 'Stationery'],
    terms: {},
    orderTypes: ['counter', 'delivery'],
    units: ['pc', 'kg', 'g', 'ltr', 'ml', 'pack', 'box', 'dozen', 'mtr', 'ft', 'coil', 'roll', 'set', 'bag', 'pair'],
  },
  {
    category: 'service', name: 'Service', emoji: '✂️', examples: 'Salon, Laundry, Repair',
    subTypes: ['Salon', 'Laundry', 'Repair', 'Spa', 'Other Services'],
    terms: {
      product: { singular: 'Service', plural: 'Services' },
      customer: { singular: 'Client', plural: 'Clients' },
      invoice: { singular: 'Bill', plural: 'Bills' },
      employee: { singular: 'Staff', plural: 'Staff' },
    },
    orderTypes: ['counter'],
    units: ['service', 'hr', 'pc', 'kg'],
  },
]

export const templateFor = (c: BusinessCategory) => TEMPLATES.find((t) => t.category === c)!

export function qrSettings(b: Pick<Business, 'qr' | 'billing'>): QrSettings {
  return {
    orderTypes: b.billing.orderTypes.filter((t) => t !== 'counter'),
    autoAccept: false,
    // The app's own address (with its path prefix when hosted under one, e.g. Catalyst web client hosting at /app/).
    baseUrl: typeof window !== 'undefined' ? `${window.location.origin}${((import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/').replace(/\/$/, '')}${(import.meta as { env?: { VITE_ROUTER?: string } }).env?.VITE_ROUTER === 'hash' ? '/#' : ''}` : '',
    ...b.qr,
  }
}

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  counter: 'Counter', dine_in: 'Dine In', takeaway: 'Takeaway', delivery: 'Delivery',
}

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank Transfer', credit: 'Credit', credit_note: 'Credit note',
}

export const RETURN_REASON: Record<import('./types').ReturnReason, string> = {
  damaged: 'Damaged / defective', wrong_item: 'Wrong item given', not_needed: 'Customer doesn’t need it', expired: 'Expired', quality: 'Quality problem', other: 'Other',
}

export const EXPENSE_LABEL: Record<ExpenseCategory, string> = {
  purchase: 'Purchase', salary: 'Salary', rent: 'Rent', electricity: 'Electricity',
  transport: 'Transport', maintenance: 'Maintenance', other: 'Other',
}

// ---------- Permissions ----------

export const PERMISSIONS: { key: Permission; label: string; group: string }[] = [
  { key: 'dashboard.view', label: 'View dashboard', group: 'General' },
  { key: 'billing.create', label: 'Create bills', group: 'Sales' },
  { key: 'billing.discount', label: 'Give discounts', group: 'Sales' },
  { key: 'orders.view', label: 'View orders', group: 'Sales' },
  { key: 'orders.cancel', label: 'Cancel / void orders', group: 'Sales' },
  { key: 'tables.manage', label: 'Manage tables & take orders', group: 'Sales' },
  { key: 'kitchen.view', label: 'Kitchen display', group: 'Sales' },
  { key: 'payments.view', label: 'View payments', group: 'Money' },
  { key: 'payments.collect', label: 'Collect due payments', group: 'Money' },
  { key: 'expenses.manage', label: 'Record expenses', group: 'Money' },
  { key: 'reports.view', label: 'View reports', group: 'Money' },
  { key: 'reports.profit', label: 'View profit / net income', group: 'Money' },
  { key: 'products.manage', label: 'Manage products', group: 'Catalogue' },
  { key: 'inventory.manage', label: 'Manage stock', group: 'Catalogue' },
  { key: 'customers.manage', label: 'Manage customers', group: 'Catalogue' },
  { key: 'settings.manage', label: 'Business settings', group: 'Admin' },
  { key: 'users.manage', label: 'Manage staff & roles', group: 'Admin' },
]

export const DEFAULT_ROLES: { id: string; name: string; permissions: Permission[] | ['*'] }[] = [
  { id: 'owner', name: 'Owner', permissions: ['*'] },
  {
    id: 'manager', name: 'Manager',
    permissions: ['dashboard.view', 'billing.create', 'billing.discount', 'orders.view', 'orders.cancel', 'tables.manage',
      'kitchen.view', 'payments.view', 'payments.collect', 'expenses.manage', 'reports.view', 'products.manage',
      'inventory.manage', 'customers.manage'],
  },
  { id: 'cashier', name: 'Cashier', permissions: ['billing.create', 'orders.view', 'tables.manage', 'payments.view', 'payments.collect', 'customers.manage'] },
  { id: 'waiter', name: 'Waiter', permissions: ['tables.manage', 'orders.view'] },
  { id: 'kitchen', name: 'Kitchen Staff', permissions: ['kitchen.view'] },
]

// ---------- Add / edit product form, per business type ----------

/** Supermarket / grocery shops get the scan-first billing screen, MRP and scan-to-add. */
export function isSupermarket(b: Pick<Business, 'category' | 'subType'>) {
  return b.category === 'retail' && /super|grocery|maligai|kirana|provision|mart/i.test(b.subType)
}

/** Hardware / electricals shops. */
export function isHardware(b: Pick<Business, 'category' | 'subType'>) {
  return b.category === 'retail' && /hardware|electric/i.test(b.subType)
}

/** Retail shops with the scan-first billing (hold, saved orders) and the Customer Orders board. */
export const usesRetailPos = (b: Pick<Business, 'category' | 'subType'>) => isSupermarket(b) || isHardware(b)

/** Units sold by weight / volume: open the weight popup and allow decimal quantities. */
export const WEIGHT_UNITS = ['kg', 'g', 'ltr', 'ml']

export interface ProductFormProfile {
  namePlaceholder: string
  showMrp?: boolean
  showFoodType: boolean // Veg / Non-veg
  showKitchen: boolean // "Send to kitchen" toggle
  barcodeFirst: boolean // barcode + SKU right under the name (scan-to-fill)
  trackStockByDefault: boolean
  isService: boolean
  variants: { title: string; hint: string; placeholder: string }
  addOns: { title: string; hint: string; placeholder: string } | null
}

export function productFormFor(b: Pick<Business, 'category' | 'subType'>): ProductFormProfile {
  const sub = b.subType.toLowerCase()
  if (b.category === 'retail') {
    const hardware = /hardware|electric/.test(sub)
    const electronics = /electronic/.test(sub)
    return {
      namePlaceholder: hardware ? 'Modular Switch 6A' : electronics ? 'LED TV 32 inch' : /stationery/.test(sub) ? 'A4 Notebook 200 pages' : /fancy/.test(sub) ? 'Hair Clip Set' : 'Toor Dal 1 kg',
      showFoodType: false, showKitchen: false, barcodeFirst: true, trackStockByDefault: true, isService: false,
      showMrp: isSupermarket(b),
      variants: {
        title: 'Variants',
        hint: hardware ? 'e.g. 6A / 16A, 20 mm / 25 mm — each with its own price' : electronics ? 'e.g. 32 inch / 43 inch, Black / White' : 'e.g. 500 g / 1 kg, Small / Large — each with its own price',
        placeholder: hardware ? '16A' : electronics ? '43 inch' : '1 kg',
      },
      addOns: null,
    }
  }
  if (b.category === 'service') {
    return {
      namePlaceholder: /laundry/.test(sub) ? 'Shirt — wash & iron' : /repair/.test(sub) ? 'Mobile screen replacement' : 'Haircut',
      showFoodType: false, showKitchen: false, barcodeFirst: false, trackStockByDefault: false, isService: true,
      variants: { title: 'Options', hint: 'e.g. Short / Long hair, Regular / Express — each with its own price', placeholder: 'Long hair' },
      addOns: { title: 'Extras', hint: 'Optional extras like Hair wash, Head massage', placeholder: 'Hair wash' },
    }
  }
  return {
    namePlaceholder: /bakery/.test(sub) ? 'Black Forest Cake' : /tea|coffee/.test(sub) ? 'Masala Tea' : /juice/.test(sub) ? 'Fresh Lime Juice' : 'Chicken Burger',
    showFoodType: true, showKitchen: true, barcodeFirst: false, trackStockByDefault: false, isService: false,
    variants: { title: 'Sizes / portions', hint: 'e.g. Half / Full, Small / Medium / Large — each with its own price', placeholder: 'Medium' },
    addOns: { title: 'Add-ons', hint: 'Optional extras like Cheese, Egg', placeholder: 'Extra cheese' },
  }
}

// ---------- Starter categories (sign-up) ----------

type StarterCat = { name: string; emoji: string }
const C = (list: string): StarterCat[] => list.split('|').map((x) => { const [emoji, name] = x.split(':'); return { emoji, name } })

/** Categories suggested during sign-up for a business type. The owner can remove, rename or add more. */
export function defaultCategoriesFor(category: BusinessCategory, subType: string): StarterCat[] {
  const s = subType.toLowerCase()
  if (category === 'retail') {
    if (/hardware/.test(s)) return C('💡:Electricals|🚰:Plumbing|🎨:Paints|🔨:Tools|🔩:Fasteners|🧱:Building Material')
    if (/electronic/.test(s)) return C('📺:TV & Audio|📱:Mobile Accessories|🍳:Kitchen Appliances|🌀:Fans & Lights|🔌:Cables & Chargers')
    if (/fancy/.test(s)) return C('💄:Cosmetics|🎀:Hair Accessories|💍:Jewellery|🎁:Gifts|🧸:Toys')
    if (/stationery/.test(s)) return C('📒:Notebooks|🖊️:Pens & Pencils|🎨:Art Supplies|📎:Office Supplies|🎒:School Bags')
    return C('🌾:Rice & Atta|🫘:Dal & Pulses|🛢️:Oil & Ghee|🌶️:Masala & Spices|🍪:Snacks & Biscuits|☕:Tea & Coffee|🥛:Milk & Dairy|🧴:Personal Care|🧹:Household')
  }
  if (category === 'service') {
    if (/laundry/.test(s)) return C('👕:Wash & Iron|🧥:Dry Clean|♨️:Ironing|🛏️:Household Linen')
    if (/repair/.test(s)) return C('📱:Mobile|💻:Laptop & Computer|📺:TV & Appliances|🔧:General Repair')
    if (/spa/.test(s)) return C('💆:Massage|🧖:Facial|💅:Manicure & Pedicure|🛁:Body Care')
    if (/salon/.test(s)) return C('💇:Hair|🧔:Beard & Shave|🧖:Skin & Facial|💅:Nails|👰:Bridal')
    return C('⭐:General|🛠️:Services|📦:Packages')
  }
  if (category === 'restaurant') {
    if (/cafe/.test(s)) return C('☕:Coffee|🍵:Tea|🥪:Sandwiches|🍰:Desserts|🥤:Shakes')
    if (/cloud/.test(s)) return C('🍛:Biryani|🍱:Combos|🍗:Starters|🍜:Noodles & Rice|🥤:Beverages')
    if (/hotel/.test(s)) return C('🥞:Tiffin|🍛:Meals|🍗:Starters|🍚:Biryani & Rice|🫓:Parotta & Breads|🥤:Beverages')
    return C('🍗:Starters|🍛:Main Course|🍚:Biryani & Rice|🫓:Breads|🥤:Beverages|🍨:Desserts')
  }
  if (/bakery/.test(s)) return C('🎂:Cakes|🍞:Breads|🥐:Puffs & Snacks|🍬:Sweets|🍪:Cookies|🥤:Beverages')
  if (/tea|coffee/.test(s)) return C('🍵:Tea|☕:Coffee|🥟:Snacks|🧃:Juices')
  if (/juice/.test(s)) return C('🧃:Fresh Juices|🥤:Milkshakes|🍨:Ice Cream|🥗:Fruit Bowls')
  if (/sweet/.test(s)) return C('🍬:Sweets|🥨:Savouries|🍪:Snacks|🎁:Gift Boxes')
  if (/catering/.test(s)) return C('🥗:Veg Meals|🍗:Non-Veg Meals|🍢:Starters|🍨:Desserts')
  return C('🍔:Burgers|🍕:Pizza|🍟:Snacks|🥤:Beverages|🍨:Desserts')
}
