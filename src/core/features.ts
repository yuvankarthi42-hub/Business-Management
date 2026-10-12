// Feature flags: the product admin releases new features to no one, some customers, or everyone.
export const FEATURES = {
  whatsapp: {
    name: 'WhatsApp integration',
    description: 'Connect a WhatsApp Business number to send bills and offers directly. Adds Settings → Integrations.',
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
