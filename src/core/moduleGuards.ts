// Writes that belong to one module: refused (by the server and the demo app) while that module is off, so a
// switched-off module never gets new database entries — even if someone calls the action directly.
// Screens already hide these actions when the module is off; this makes the server enforce it too.
//
// Not listed on purpose (they keep working whatever the module switches say):
//  • core billing: orders.save / checkout / settle / cancel, payments, returns, products, customers.save
//    (the billing screen's customer picker), business / users / roles / branches settings;
//  • work on entries that already exist from when the module was on: qr.accept / qr.reject (pending QR
//    orders), customers.adjustPoints (correcting a balance) — placing a QR order is refused by the server already;
//  • automatic entries that keep the books right: stock moved by a bill, a supplier payment's expense row,
//    the customer created for a QR order.
import type { ModuleKey } from './types'

export const WRITE_MODULE: Record<string, ModuleKey> = {
  // Kitchen (KOT)
  'kitchen.setStatus': 'kitchen',
  'orders.sendToKitchen': 'kitchen',
  // Tables
  'tables.save': 'tables',
  'tables.remove': 'tables',
  'tables.unmerge': 'tables',
  'orders.transferTable': 'tables',
  'orders.mergeTables': 'tables',
  // Inventory: stock, batches, purchases, suppliers
  'inventory.adjust': 'inventory',
  'inventory.writeOffBatch': 'inventory',
  'purchases.create': 'inventory',
  'purchases.void': 'inventory',
  'suppliers.save': 'inventory',
  'suppliers.pay': 'inventory',
  'suppliers.voidPayment': 'inventory',
  // Expenses
  'expenses.save': 'expenses',
  'expenses.void': 'expenses',
  // Employees (attendance, pay, advances, salary)
  'staff.mark': 'employees',
  'staff.markAll': 'employees',
  'staff.setPay': 'employees',
  'staff.giveAdvance': 'employees',
  'staff.paySalary': 'employees',
  // Today's specials
  'specials.save': 'specials',
  // Customer orders (packing / delivery stages)
  'orders.setFulfilment': 'customerOrders',
  // Customers (collecting dues from the Customers screen)
  'customers.collectDue': 'customers',
}

/**
 * Reads that belong to one module. While it is off the server answers them without touching the database:
 * lists come back empty (`[]`, so an older screen still shows "nothing here"); the rest are refused.
 * Screens don't ask for these while the module is off; this is the server-side guarantee.
 * Not listed (they serve billing too): products / customers / orders.running / orders.list / reports.summary,
 * reports.topProducts (billing quick picks), reports.byBranch (dashboard).
 */
export const READ_MODULE: Record<string, { module: ModuleKey; empty?: [] }> = {
  'kitchen.list': { module: 'kitchen', empty: [] },
  'tables.list': { module: 'tables', empty: [] },
  'specials.list': { module: 'specials', empty: [] },
  'qr.pending': { module: 'qrOrdering', empty: [] },
  'qr.recent': { module: 'qrOrdering', empty: [] },
  'inventory.movements': { module: 'inventory', empty: [] },
  'inventory.batches': { module: 'inventory', empty: [] },
  'purchases.list': { module: 'inventory', empty: [] },
  'purchases.get': { module: 'inventory' },
  'suppliers.list': { module: 'inventory', empty: [] },
  'suppliers.ledger': { module: 'inventory' },
  'expenses.list': { module: 'expenses', empty: [] },
  'staff.list': { module: 'employees', empty: [] },
  'staff.day': { module: 'employees', empty: [] },
  'staff.month': { module: 'employees' },
  'payments.list': { module: 'payments', empty: [] },
  'orders.board': { module: 'customerOrders', empty: [] },
  'reports.gst': { module: 'reports' },
  'reports.receivables': { module: 'reports', empty: [] },
}

/** For a module-owned read while its module is off: `{ empty }` to answer with, or `{ error }`. Null = run it. */
export function moduleOffRead(action: string, modules: Partial<Record<ModuleKey, boolean>> | undefined): { empty: [] } | { error: string } | null {
  const r = READ_MODULE[action]
  if (!r || modules?.[r.module]) return null
  return r.empty ? { empty: [] } : { error: offMessage(r.module) }
}

const LABEL: Partial<Record<ModuleKey, string>> = {
  kitchen: 'Kitchen (KOT)', tables: 'Tables', inventory: 'Inventory', expenses: 'Expenses', employees: 'Staff',
  specials: 'Today’s specials', customerOrders: 'Customer orders', customers: 'Customers',
  qrOrdering: 'QR ordering', payments: 'Payments', reports: 'Reports',
}

/** The message when an action's module is off, or null when it may run. */
export function moduleOffError(action: string, modules: Partial<Record<ModuleKey, boolean>> | undefined): string | null {
  const m = WRITE_MODULE[action]
  if (!m || modules?.[m]) return null
  return offMessage(m)
}

const offMessage = (m: ModuleKey) => `${LABEL[m] ?? m} is turned off. Turn it on in Settings → Modules to use this.`
