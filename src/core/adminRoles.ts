// What each product-admin role may do. Checked by the API (and used by the UI to hide actions).
import type { AdminRole } from './types'

export type AdminPermission =
  | 'customers.view' | 'customers.create' | 'customers.edit' | 'customers.password' | 'customers.renew' | 'customers.branches'
  | 'customers.status' | 'customers.delete' | 'customers.support' | 'reports.view' | 'team.manage' | 'pricing.manage' | 'features.manage'

const ALL: AdminPermission[] = ['customers.view', 'customers.create', 'customers.edit', 'customers.password', 'customers.renew', 'customers.branches',
  'customers.status', 'customers.delete', 'customers.support', 'reports.view', 'team.manage', 'pricing.manage', 'features.manage']

export const ADMIN_ROLES: Record<AdminRole, { name: string; description: string; permissions: AdminPermission[] }> = {
  super: { name: 'Super admin', description: 'Everything, including deleting customers, the admin team and pricing', permissions: ALL },
  manager: { name: 'Manager', description: 'Create and manage customers and feature releases — no delete, team or pricing', permissions: ALL.filter((p) => !['customers.delete', 'team.manage', 'pricing.manage'].includes(p)) },
  support: { name: 'Support', description: 'View customers, renew / extend, and open a read-only support view', permissions: ['customers.view', 'customers.renew', 'customers.support', 'reports.view'] },
}
export const adminCan = (role: AdminRole | undefined, p: AdminPermission) => !!role && ADMIN_ROLES[role].permissions.includes(p)
