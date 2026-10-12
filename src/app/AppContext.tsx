import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, getChangeVersion, subscribe } from '@/data'
import type { Branch, Business, ModuleKey, Permission, Role, TermKey, User } from '@/core/types'
import { setCurrencySymbol } from '@/lib/format'
import { setLanguage, type Lang } from '@/i18n'
import type { FeatureKey } from '@/core/features'

interface Me {
  user: User
  business: Business
  role: Role
  /** Current branch, or a pseudo branch with id 'all' in the combined view. */
  branch: Branch
  /** Branches this user may switch between. */
  branches: Branch[]
  isAll: boolean
  permissions: Permission[] | 'all'
  /** Subscription set by the product admin. readOnly = expired: data can be viewed but not changed. */
  subscription: { state: 'active' | 'expiring' | 'expired' | 'deactivated'; daysLeft: number; endAt: string | null; startAt: string | null; readOnly: boolean; blocked: boolean }
  branchLimit: { max: number; used: number }
  /** Features the product admin has released to this customer. */
  features: Record<FeatureKey, boolean>
  /** A product admin is looking at this account (read-only support view). */
  support: { adminId: string; adminName: string; reason: string; startedAt: string } | null
}

interface AppCtx {
  me: Me | null
  loading: boolean
  refresh: () => Promise<void>
  /** Terminology: t('product') -> "Menu Item", t('product', true) -> "Menu Items" */
  t: (key: TermKey, plural?: boolean) => string
  can: (p: Permission) => boolean
  mod: (m: ModuleKey) => boolean
}

const Ctx = createContext<AppCtx>(null as unknown as AppCtx)

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const seq = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    const m = await api.auth.me()
    if (mine !== seq.current) return // a newer refresh started (e.g. switched account) — keep its result
    if (m) setCurrencySymbol(m.business.currencySymbol)
    if (m?.user.language) void setLanguage(m.user.language as Lang)
    setMe(m)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => subscribe(() => { refresh() }), [refresh])

  const value = useMemo<AppCtx>(() => ({
    me, loading, refresh,
    t: (key, plural) => {
      const term = me?.business.terminology[key]
      return term ? (plural ? term.plural : term.singular) : key
    },
    can: (p) => !!me && (me.permissions === 'all' || me.permissions.includes(p)),
    mod: (m) => !!me?.business.modules[m],
  }), [me, loading, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useApp = () => useContext(Ctx)

/**
 * Fetch data through the API and re-run automatically whenever the data store changes
 * (mock DB writes, or another tab). Mirrors what react-query + websockets would do later.
 */
export function useData<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(getChangeVersion())
  useEffect(() => subscribe(() => setVersion(getChangeVersion())), [])
  useEffect(() => {
    let alive = true
    fn().then((d) => { if (alive) { setData(d); setError(null) } }).catch((e) => alive && setError(e.message))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps])
  return { data, error, loading: data === undefined && !error }
}

/** Re-render periodically (for "time elapsed" displays). */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id) }, [intervalMs])
  return now
}
