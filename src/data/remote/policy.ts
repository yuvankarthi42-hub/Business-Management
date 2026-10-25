// Which actions are reads (cached) and what each write changes. When a new feature is added:
//  • a new read  → add it to READS with its tags (otherwise it is simply not cached — still correct);
//  • a new write → add the tags it changes to WRITES (otherwise its namespace's reads are refreshed).
const S = 1000, M = 60 * S

/** How long a cached read is trusted. Short for things other counters change all day. */
const LIVE = 15 * S, SHORT = M, NORMAL = 5 * M, LONG = 10 * M

const READS: Record<string, { tags: string[]; ttl: number }> = {
  'auth.me': { tags: ['me'], ttl: NORMAL },
  'branches.list': { tags: ['branches'], ttl: NORMAL },
  'roles.list': { tags: ['roles'], ttl: NORMAL },
  'users.list': { tags: ['users'], ttl: NORMAL },
  'categories.list': { tags: ['catalog'], ttl: LONG },
  'products.list': { tags: ['catalog'], ttl: LONG }, // stock in it is patched after every bill (effects)
  'specials.list': { tags: ['specials'], ttl: NORMAL },
  'customers.list': { tags: ['customers'], ttl: NORMAL },
  'customers.one': { tags: ['customers'], ttl: NORMAL },
  'customers.history': { tags: ['customers', 'orders'], ttl: SHORT },
  'orders.list': { tags: ['orders'], ttl: SHORT },
  'orders.running': { tags: ['orders'], ttl: LIVE },
  'orders.get': { tags: ['orders'], ttl: SHORT },
  'orders.board': { tags: ['orders'], ttl: LIVE },
  'payments.list': { tags: ['payments'], ttl: SHORT },
  'kitchen.list': { tags: ['kitchen', 'orders'], ttl: 10 * S },
  'tables.list': { tags: ['tables'], ttl: SHORT },
  'expenses.list': { tags: ['expenses'], ttl: NORMAL },
  'inventory.movements': { tags: ['stock'], ttl: SHORT },
  'inventory.batches': { tags: ['stock'], ttl: SHORT },
  'reports.summary': { tags: ['reports'], ttl: SHORT },
  'reports.topProducts': { tags: ['reports'], ttl: LONG },
  'reports.byBranch': { tags: ['reports'], ttl: SHORT },
  'reports.receivables': { tags: ['reports', 'customers'], ttl: SHORT },
  'reports.gst': { tags: ['reports', 'purchases'], ttl: SHORT },
  'customers.points': { tags: ['customers', 'points'], ttl: SHORT },
  'suppliers.list': { tags: ['suppliers', 'purchases'], ttl: NORMAL },
  'suppliers.ledger': { tags: ['suppliers', 'purchases'], ttl: SHORT },
  'purchases.list': { tags: ['purchases'], ttl: SHORT },
  'purchases.get': { tags: ['purchases'], ttl: SHORT },
  'audit.list': { tags: ['audit'], ttl: SHORT },
  'returns.forOrder': { tags: ['returns', 'orders'], ttl: SHORT },
  'returns.list': { tags: ['returns'], ttl: SHORT },
  'returns.creditNote': { tags: ['returns'], ttl: 10 * S },
  'staff.list': { tags: ['staff', 'users'], ttl: NORMAL },
  'staff.day': { tags: ['staff'], ttl: SHORT },
  'staff.month': { tags: ['staff'], ttl: SHORT },
  'support.mine': { tags: ['support'], ttl: SHORT },
  'campaigns.today': { tags: ['campaigns'], ttl: SHORT },
  'qr.pending': { tags: ['orders', 'qr'], ttl: 10 * S },
  'qr.recent': { tags: ['orders', 'qr'], ttl: LIVE },
  'whatsapp.status': { tags: ['whatsapp'], ttl: 5 * S },
  'whatsapp.messages': { tags: ['whatsapp'], ttl: LIVE },
  'public.menu': { tags: ['public'], ttl: SHORT },
  'public.order': { tags: ['public'], ttl: 5 * S }, // not cached in the browser (see api.ts UNCACHED)
  'public.pushKey': { tags: [], ttl: LONG },
  'public.live': { tags: [], ttl: LONG },
  'public.specials': { tags: ['public'], ttl: SHORT },
  // product admin
  'admin.me': { tags: ['adminMe'], ttl: NORMAL },
  'admin.customers': { tags: ['admin'], ttl: SHORT },
  'admin.customer': { tags: ['admin'], ttl: SHORT },
  'admin.renewals': { tags: ['admin'], ttl: SHORT },
  'admin.waStatus': { tags: ['admin'], ttl: 5 * S },
  'admin.tickets': { tags: ['admin', 'adminTickets'], ttl: LIVE },
  'admin.ticket': { tags: ['admin', 'adminTickets'], ttl: 10 * S },
  'admin.features': { tags: ['admin'], ttl: NORMAL },
  'admin.team': { tags: ['admin'], ttl: NORMAL },
  'admin.usage': { tags: ['admin'], ttl: SHORT },
  'admin.settings': { tags: ['admin'], ttl: NORMAL },
  'admin.audit': { tags: ['admin'], ttl: SHORT },
}

// A bill changes orders, kitchen and payments. Reports are not dropped after every bill (they read many
// rows): they refresh within a minute (SHORT). Customers only when the bill is for a customer (see below).
const ORDER_CHANGE = ['orders', 'kitchen', 'payments', 'qr', 'returns']
const TABLE_CHANGE = [...ORDER_CHANGE, 'tables']
const WRITES: Record<string, string[]> = {
  'auth.setLanguage': ['me'],
  'business.update': ['me', 'reports', 'public'],
  'business.setLogo': ['me', 'public'],
  'public.subscribePush': [],
  'business.saveSetup': ['me', 'catalog', 'tables'],
  'business.finishOnboarding': ['me'],
  'branches.save': ['me', 'branches'],
  'branches.savePrinter': ['me', 'branches'],
  'roles.save': ['roles', 'me', 'users'],
  'roles.remove': ['roles', 'me'],
  'users.save': ['users', 'me', 'staff'],
  'categories.save': ['catalog', 'public'],
  'categories.remove': ['catalog', 'public'],
  'products.save': ['catalog', 'public', 'stock'],
  'products.importMany': ['catalog', 'public', 'stock'],
  'products.assignBarcodes': ['catalog'],
  'products.saveDesign': ['catalog', 'public', 'stock'],
  'products.setDiscount': ['catalog', 'public'],
  'media.store': [],
  'specials.save': ['specials', 'public'],
  'customers.save': ['customers'],
  'customers.collectDue': ['customers', 'orders', 'payments', 'reports'],
  'customers.adjustPoints': ['customers', 'points'],
  'suppliers.save': ['suppliers'], 'suppliers.pay': ['suppliers', 'purchases'], 'suppliers.voidPayment': ['suppliers', 'purchases'],
  'purchases.create': ['purchases', 'suppliers', 'stock', 'catalog', 'reports'], 'purchases.void': ['purchases', 'suppliers', 'stock', 'reports'],
  'orders.save': ORDER_CHANGE, 'orders.setFulfilment': ORDER_CHANGE, 'orders.sendToKitchen': ORDER_CHANGE, 'orders.checkout': ORDER_CHANGE,
  'orders.settle': TABLE_CHANGE, 'orders.cancel': [...TABLE_CHANGE, 'stock', 'customers', 'points', 'reports'], 'orders.transferTable': TABLE_CHANGE, 'orders.mergeTables': TABLE_CHANGE,
  'kitchen.setStatus': ['kitchen'],
  'tables.save': ['tables', 'public'], 'tables.remove': ['tables', 'public'], 'tables.unmerge': ['tables'],
  'expenses.save': ['expenses', 'reports'], 'expenses.void': ['expenses', 'reports'],
  'inventory.adjust': ['stock', 'expenses', 'reports'], 'inventory.writeOffBatch': ['stock', 'reports'],
  'returns.create': [...ORDER_CHANGE, 'stock', 'customers', 'points', 'reports'],
  'staff.mark': ['staff'], 'staff.markAll': ['staff'], 'staff.setPay': ['staff', 'users', 'me'], 'staff.giveAdvance': ['staff', 'expenses', 'reports'], 'staff.paySalary': ['staff', 'expenses', 'reports'],
  'support.create': ['support'], 'support.reply': ['support'], 'support.markRead': ['support'], 'support.resolve': ['support'], 'support.storeScreenshot': [],
  'campaigns.create': ['campaigns'], 'campaigns.update': ['campaigns'], 'campaigns.markSent': ['campaigns'],
  'qr.accept': TABLE_CHANGE, 'qr.reject': ORDER_CHANGE,
  'public.placeOrder': ['public'],
}

export function readPolicy(name: string) { return READS[name] ?? null }
/** Bills for a customer change their dues / totals; walk-in bills don't. */
const forCustomer = (name: string, args: unknown[]) =>
  (name === 'orders.checkout' || name === 'orders.save') ? !!(args[0] as { customerId?: string | null } | undefined)?.customerId
    : name === 'orders.settle' ? true : false

export function invalidatesFor(name: string, args: unknown[] = []): string[] {
  if (WRITES[name]) return forCustomer(name, args) ? [...WRITES[name], 'customers', 'points'] : WRITES[name]
  const ns = name.split('.')[0]
  if (ns === 'admin') return name.startsWith('admin.save') || name.startsWith('admin.setAdmin') ? ['admin', 'adminMe'] : ['admin', 'adminTickets']
  if (ns === 'whatsapp') return ['whatsapp', 'campaigns']
  // Unknown write: refresh everything of its namespace (safe default).
  return [...new Set([ns, ...Object.entries(READS).filter(([k]) => k.startsWith(`${ns}.`)).flatMap(([, v]) => v.tags)])]
}
export const isRead = (name: string) => name in READS
