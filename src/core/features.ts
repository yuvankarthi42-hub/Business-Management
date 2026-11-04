// Feature flags: the product admin releases new features to no one, some customers, or everyone.
import type { ModuleKey } from './types'

export const FEATURES = {
  whatsapp: {
    name: 'WhatsApp integration',
    description: 'Connect a WhatsApp Business number to send bills and offers directly. Adds Settings → Integrations.',
  },
  qrOrders: {
    name: 'QR Orders',
    description: 'Customers scan a QR code to see the menu, order and track it. Adds the QR Ordering module and the QR Orders screen.',
  },
  specials: {
    name: 'Daily Specials & offers display',
    description: 'Today’s specials and offer prices in billing, on the QR menu and on the TV display. Adds the Daily Specials module.',
  },
  gstReport: {
    name: 'GST report',
    description: 'GST returns (B2B / B2C / HSN summary) in Reports.',
  },
  singleDevice: {
    name: 'Single device (no background sync)',
    description: 'For shops that bill on one device only: screens stop checking every 30–60 s for other devices’ changes (fewer server calls). Not while QR ordering is on — QR orders still arrive.',
  },
} as const

export type FeatureKey = keyof typeof FEATURES
export interface FeatureFlag {
  mode: 'off' | 'selected' | 'all'
  /** Customers who get it when mode = 'selected'. */
  businessIds: string[]
}
export type FeatureFlags = Partial<Record<FeatureKey, FeatureFlag>>
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[]

export function featureOn(flags: FeatureFlags | undefined, key: FeatureKey, businessId: string) {
  const f = flags?.[key]
  return !!f && (f.mode === 'all' || (f.mode === 'selected' && f.businessIds.includes(businessId)))
}
export const featuresFor = (flags: FeatureFlags | undefined, businessId: string) =>
  Object.fromEntries(FEATURE_KEYS.map((k) => [k, featureOn(flags, k, businessId)])) as Record<FeatureKey, boolean>

/** Modules that exist for a customer only while their feature is released to them. */
export const FEATURE_MODULE: Partial<Record<FeatureKey, ModuleKey>> = { qrOrders: 'qrOrdering', specials: 'specials' }
const MODULE_FEATURE = Object.fromEntries(Object.entries(FEATURE_MODULE).map(([f, m]) => [m, f])) as Partial<Record<ModuleKey, FeatureKey>>
/** Can this customer see / turn on this module (its feature, if it has one, is released to them)? */
export const moduleReleased = (m: ModuleKey, features: Partial<Record<FeatureKey, boolean>> | undefined) => { const f = MODULE_FEATURE[m]; return !f || !!features?.[f] }

/**
 * The shop's modules as the customer gets them: a module whose feature isn't released to them counts as off
 * (screens, server guards and the QR menu all read this). The shop's own on / off choice is kept underneath.
 */
export function withFeatures<M extends Partial<Record<ModuleKey, boolean>>>(modules: M, features: Partial<Record<FeatureKey, boolean>> | undefined): M {
  let out = modules
  for (const [f, m] of Object.entries(FEATURE_MODULE) as [FeatureKey, ModuleKey][]) {
    if (!features?.[f] && out[m]) out = { ...out, [m]: false }
  }
  return out
}

/**
 * Actions that belong to a released feature. While it is off for the customer the server never runs them (and the
 * demo app neither): lists answer empty without touching the database, the rest are refused. Public actions take
 * the shop's id as their first argument. Screens don't call these while the feature is off.
 * The QR menu and TV board (public.menu / public.specials) are not listed: they answer "not available" by
 * themselves, because they read the shop's modules with the features applied.
 */
export const FEATURE_ACTIONS: Record<string, { feature: FeatureKey; empty?: [] }> = {
  'qr.pending': { feature: 'qrOrders', empty: [] },
  'qr.recent': { feature: 'qrOrders', empty: [] },
  'qr.accept': { feature: 'qrOrders' },
  'qr.reject': { feature: 'qrOrders' },
  'public.placeOrder': { feature: 'qrOrders' },
  'public.order': { feature: 'qrOrders' },
  'public.track': { feature: 'qrOrders' },
  'public.subscribePush': { feature: 'qrOrders' },
  'specials.list': { feature: 'specials', empty: [] },
  'specials.save': { feature: 'specials' },
  'reports.gst': { feature: 'gstReport' },
}

/** For an action while its feature is off for this customer: `{ empty }` to answer with, or `{ error }`. Null = run it. */
export function featureOffAction(action: string, features: Partial<Record<FeatureKey, boolean>> | undefined): { empty: [] } | { error: string } | null {
  const r = FEATURE_ACTIONS[action]
  if (!r || features?.[r.feature]) return null
  return r.empty ? { empty: [] } : { error: `${FEATURES[r.feature].name} isn’t available for your account yet` }
}
