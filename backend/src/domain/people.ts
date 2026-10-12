// Users, roles and permissions ⇄ tables (users, user_branches, roles, role_permissions).
import type { Permission, Role, StaffPay, User } from '@/core/types'
import { DEFAULT_ROLES } from '@/core/config'
import type { Db, Row } from '../db/types'
import { code, E, fromBp, fromMinor, keyPart, nameOf, str, strOrNull, toBp, toMinor } from './util'

export function userFrom(u: Row, branchIds: string[]): User {
  const pay: StaffPay | undefined = u.pay_type != null
    ? { type: nameOf(E.PayType, u.pay_type) as StaffPay['type'], amount: fromMinor(u.pay_amount_minor), commissionPct: fromBp(u.commission_bp) }
    : undefined
  return {
    id: u.ROWID, businessId: str(u.business_id), branchId: str(u.default_branch_id) || branchIds[0] || '', name: str(u.name), phone: str(u.phone), email: str(u.email),
    password: '', // never leaves the server
    roleId: str(u.role_id), active: u.is_active !== false, ...(branchIds.length ? { branchIds } : {}),
    language: str(u.language) || 'en', ...(u.username ? { username: str(u.username) } : {}), lastLoginAt: strOrNull(u.last_login_at),
    ...(pay ? { pay } : {}),
    createdAt: u.CREATEDTIME, createdBy: '', updatedAt: u.MODIFIEDTIME, updatedBy: '',
  }
}
export const payColumns = (pay: StaffPay | null | undefined) => pay
  ? { pay_type: code(E.PayType, pay.type), pay_amount_minor: toMinor(pay.amount) ?? 0, commission_bp: toBp(pay.commissionPct ?? 0) }
  : { pay_type: null, pay_amount_minor: 0, commission_bp: 0 }

export function roleFrom(r: Row, perms: Row[]): Role {
  return {
    id: r.ROWID, businessId: str(r.business_id), name: str(r.name), system: r.system_key != null,
    permissions: r.is_all_access ? ['*'] : (perms.filter((p) => p.role_id === r.ROWID).map((p) => str(p.permission)) as Permission[]),
  }
}

export async function loadRoles(db: Db, businessId: string): Promise<Role[]> {
  const roles = await db.select('roles', { where: { business_id: businessId } })
  const perms = roles.length ? await db.select('role_permissions', { where: { role_id: { in: roles.map((r) => r.ROWID) } } }) : []
  return roles.map((r) => roleFrom(r, perms))
}

export async function loadUsers(db: Db, businessId: string): Promise<User[]> {
  const users = await db.select('users', { where: { business_id: businessId } })
  const ub = users.length ? await db.select('user_branches', { where: { user_id: { in: users.map((u) => u.ROWID) } } }) : []
  return users.map((u) => userFrom(u, ub.filter((x) => x.user_id === u.ROWID).map((x) => str(x.branch_id))))
}

/** The five built-in roles for a new business. Returns them with the Owner first. */
export async function seedRoles(db: Db, businessId: string): Promise<Role[]> {
  const rows = await db.insertMany('roles', DEFAULT_ROLES.map((r) => ({
    business_id: businessId, name: r.name, system_key: code(E.RoleKey, r.id), is_all_access: (r.permissions as string[]).includes('*'), uniq_key: `${businessId}:${keyPart(r.name)}`,
  })))
  const perms: { role_id: string; permission: string; uniq_key: string }[] = []
  rows.forEach((row, i) => { for (const p of DEFAULT_ROLES[i].permissions) if (p !== '*') perms.push({ role_id: row.ROWID, permission: p, uniq_key: `${row.ROWID}:${p}` }) })
  const permRows = perms.length ? await db.insertMany('role_permissions', perms) : []
  return rows.map((r) => roleFrom(r, permRows))
}

/** Branches a user may open: all for full-access roles, otherwise their own list (or their default branch). */
export function allowedBranches(user: User, role: Role | undefined, allBranchIds: string[]): string[] {
  if (role && (role.permissions as string[]).includes('*')) return allBranchIds
  const ids = user.branchIds?.length ? user.branchIds : [user.branchId]
  return ids.filter((id) => allBranchIds.includes(id))
}
export const permissionsOf = (role: Role | undefined): Set<Permission> | 'all' =>
  !role ? new Set() : (role.permissions as string[]).includes('*') ? 'all' : new Set(role.permissions as Permission[])

/** Replace a user's branch list (first one = default branch). */
export async function setUserBranches(db: Db, userId: string, branchIds: string[]) {
  const cur = await db.select('user_branches', { where: { user_id: userId } })
  const want = new Set(branchIds)
  const drop = cur.filter((r) => !want.has(str(r.branch_id))).map((r) => r.ROWID)
  if (drop.length) await db.deleteMany('user_branches', drop)
  const have = new Set(cur.map((r) => str(r.branch_id)))
  const add = branchIds.filter((b) => !have.has(b))
  if (add.length) await db.insertMany('user_branches', add.map((b) => ({ user_id: userId, branch_id: b, uniq_key: `${userId}:${b}` })))
}
