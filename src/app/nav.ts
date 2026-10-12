import {
  Flame, PackageOpen, QrCode, BarChart3, Boxes, ChefHat, CreditCard, LayoutDashboard, NotebookPen, ReceiptText, Settings, ShoppingBag, Tag, Users,
  UserCheck, UtensilsCrossed, Wallet, type LucideIcon,
} from 'lucide-react'
import type { ModuleKey, Permission, TermKey } from '@/core/types'

export interface NavItem {
  to: string
  icon: LucideIcon
  label: string | { term: TermKey }
  module?: ModuleKey
  perm?: Permission | Permission[]
  mobileTab?: boolean // shows in mobile bottom bar
  /** Only for this kind of business (checked in useNavItems). */
  only?: 'retailPos'
}

// Order matters: the first accessible entry becomes the user's home page.
export const NAV: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', perm: 'dashboard.view', mobileTab: true },
  { to: '/billing', icon: ReceiptText, label: 'Billing', module: 'billing', perm: 'billing.create', mobileTab: true },
  { to: '/customer-orders', icon: PackageOpen, label: 'Customer Orders', module: 'customerOrders', perm: 'orders.view', only: 'retailPos', mobileTab: true },
  { to: '/tables', icon: UtensilsCrossed, label: { term: 'table' }, module: 'tables', perm: 'tables.manage', mobileTab: true },
  { to: '/m/order', icon: NotebookPen, label: 'Take Order', module: 'mobileOrders', perm: 'tables.manage' },
  { to: '/qr-orders', icon: QrCode, label: 'QR Orders', module: 'qrOrdering', perm: 'tables.manage' },
  { to: '/kitchen', icon: ChefHat, label: 'Kitchen (KOT)', module: 'kitchen', perm: 'kitchen.view', mobileTab: true },
  { to: '/orders', icon: ShoppingBag, label: { term: 'order' }, module: 'orders', perm: 'orders.view', mobileTab: true },
  { to: '/products', icon: Tag, label: { term: 'product' }, module: 'products', perm: 'products.manage' },
  { to: '/specials', icon: Flame, label: 'Daily Specials', module: 'specials', perm: 'products.manage' },
  { to: '/inventory', icon: Boxes, label: 'Inventory', module: 'inventory', perm: 'inventory.manage' },
  { to: '/customers', icon: Users, label: { term: 'customer' }, module: 'customers', perm: 'customers.manage' },
  { to: '/payments', icon: CreditCard, label: { term: 'payment' }, module: 'payments', perm: 'payments.view' },
  { to: '/expenses', icon: Wallet, label: { term: 'expense' }, module: 'expenses', perm: 'expenses.manage' },
  { to: '/staff', icon: UserCheck, label: 'Staff', module: 'employees', perm: 'users.manage' },
  { to: '/reports', icon: BarChart3, label: 'Reports', module: 'reports', perm: 'reports.view' },
  { to: '/settings', icon: Settings, label: 'Settings', perm: ['settings.manage', 'users.manage'] },
]

export function allowed(item: NavItem, can: (p: Permission) => boolean, mod: (m: ModuleKey) => boolean) {
  if (item.module && !mod(item.module)) return false
  if (!item.perm) return true
  return Array.isArray(item.perm) ? item.perm.some(can) : can(item.perm)
}
