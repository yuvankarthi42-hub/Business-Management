// Every API action is one handler: `products.save`, `orders.checkout`, `admin.renew`…
// The name matches the app's `api.products.save()` call, so the screens don't change.
//
// Adding a feature = add a file under src/modules that calls define('myFeature', { … }) and import it in
// src/modules/index.ts. Nothing else needs to change.
import type { Permission } from '@/core/types'
import type { AdminPermission } from '@/core/adminRoles'
import type { Ctx } from './context'

export type Access = 'public' | 'user' | 'admin'

export interface Handler {
  access: Access
  /** Changes data. Customer writes are refused in support view, on expired (read-only) and on deactivated accounts. */
  write?: boolean
  /** Still allowed when the subscription has expired (e.g. raising a support ticket, changing language). */
  readOnlyOk?: boolean
  /** Customer permission checked before the handler runs. */
  perm?: Permission
  /** Product-admin permission checked before the handler runs. */
  adminPerm?: AdminPermission
  /**
   * Transactions for writes (customer writes: the shop's database; admin writes: the platform database).
   *  'auto'   (default for customer and admin writes) — the whole handler is one transaction.
   *  'manual' — the handler reads first and calls c.tx() around its writes (keeps the lock short: billing).
   *  'none'   (default for public writes) — no transaction; for handlers that call other services
   *           (file uploads, WhatsApp, creating databases) — those keep their own undo steps.
   */
  tx?: 'auto' | 'manual' | 'none'
  /** Not in the change feed: changes nothing the shop's other devices show (sign-in, uploads, own language). */
  quiet?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (c: Ctx, ...args: any[]) => Promise<unknown>
}

const handlers = new Map<string, Handler>()

export function define(namespace: string, defs: Record<string, Handler>) {
  for (const [name, h] of Object.entries(defs)) {
    const key = `${namespace}.${name}`
    if (handlers.has(key)) throw new Error(`Handler ${key} is defined twice`)
    handlers.set(key, h)
  }
}
export const handler = (name: string) => handlers.get(name)
export const handlerNames = () => [...handlers.keys()].sort()

/* Short helpers so module files read like a list of actions. */
type Run = Handler['run']
type Opts = Omit<Handler, 'access' | 'run' | 'write'>
export const userRead = (run: Run, o: Opts = {}): Handler => ({ access: 'user', ...o, run })
export const userWrite = (run: Run, o: Opts = {}): Handler => ({ access: 'user', write: true, ...o, run })
export const adminRead = (adminPerm: AdminPermission | undefined, run: Run): Handler => ({ access: 'admin', adminPerm, run })
export const adminWrite = (adminPerm: AdminPermission | undefined, run: Run, o: Pick<Handler, 'tx'> = {}): Handler => ({ access: 'admin', write: true, adminPerm, ...o, run })
export const publicRead = (run: Run): Handler => ({ access: 'public', run })
export const publicWrite = (run: Run): Handler => ({ access: 'public', write: true, run })
