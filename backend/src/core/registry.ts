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
  /** At least one of these customer permissions (checked before the handler runs). */
  anyPerm?: Permission[]
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
  /**
   * What the arguments must be (checked before the handler runs): a wrong one is a 400 "Check the request",
   * never a crash. Arguments past the list aren't checked. See ArgKind.
   */
  args?: ArgKind[]
  /**
   * Saved once per request id (K-7): the same request sent again gets the first one's answer instead of saving
   * twice (request_log, written in the handler's own transaction). Customer writes with tx 'auto' only.
   */
  once?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (c: Ctx, ...args: any[]) => Promise<unknown>
}

/**
 * 'object' (a plain object), 'list', 'text', 'number', or 'any' (the handler checks it itself, e.g. an id).
 * A trailing '?' = may be left out: then null counts as left out (the app's `undefined` arrives as null), so the
 * handler's own default applies.
 */
export type ArgKind = 'object' | 'object?' | 'list' | 'list?' | 'text' | 'text?' | 'number?' | 'any'

/** The arguments as the handler gets them (null → undefined where it may be left out), or null if one is wrong. */
export function checkArgs(kinds: ArgKind[] | undefined, args: unknown[]): unknown[] | null {
  if (!kinds) return args
  const out = [...args]
  for (const [i, kind] of kinds.entries()) {
    const v = out[i]
    const optional = kind.endsWith('?')
    if (optional && (v === undefined || v === null)) { if (i < out.length) out[i] = undefined; continue }
    const k = optional ? kind.slice(0, -1) : kind
    const ok = k === 'any' ? true
      : k === 'object' ? typeof v === 'object' && v !== null && !Array.isArray(v)
        : k === 'list' ? Array.isArray(v)
          : k === 'text' ? typeof v === 'string'
            : k === 'number' ? typeof v === 'number' && Number.isFinite(v)
              : false
    if (!ok) return null
  }
  return out
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
/** These customer writes are saved once per request id (src/modules/args.ts). Same start-up check as setArgs. */
export function setOnce(names: string[]) {
  for (const name of names) {
    const h = handlers.get(name)
    if (!h || !h.write || h.access !== 'user' || (h.tx ?? 'auto') !== 'auto') throw new Error(`setOnce: ${name} is not a customer write in one transaction`)
    h.once = true
  }
}
/** What these handlers' arguments must be (src/modules/args.ts). A name that isn't a handler stops the server at start. */
export function setArgs(specs: Record<string, ArgKind[]>) {
  for (const [name, args] of Object.entries(specs)) {
    const h = handlers.get(name)
    if (!h) throw new Error(`setArgs: no handler ${name}`)
    h.args = args
  }
}
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
