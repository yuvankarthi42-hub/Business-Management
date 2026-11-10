// Weighing scale per branch (Settings → Printer, scale and bill → Weighing scale). The settings are saved with the
// branch (every counter in it uses them); which physical scale a counter is paired with stays on that device.
// Shared by the app, the demo app and the server (which cleans what is saved). Off until a branch switches it on.

export type ScaleBrand = 'essae' | 'avery' | 'atlas' | 'phoenix' | 'omace' | 'orient' | 'other'

export interface BranchScale {
  enabled: boolean
  brand: ScaleBrand
  /** Port speed; must match the scale's own setting (most send 9600). */
  baudRate: number
  /** Add the item to the bill by itself once the weight is steady. */
  autoAdd: boolean
  /** Readings below this (grams) are treated as an empty pan. */
  minGrams: number
  /** Round the weight to this many grams (0 = as the scale reads). */
  roundGrams: 0 | 5 | 10
  updatedAt?: string
  updatedBy?: string
}

/** Scales common in Indian shops. Each sets the usual port speed; "Other" lets the shop pick it. */
export const SCALE_BRANDS: { key: ScaleBrand; label: string; baud: number }[] = [
  { key: 'essae', label: 'Essae', baud: 9600 },
  { key: 'avery', label: 'Avery', baud: 9600 },
  { key: 'atlas', label: 'Atlas', baud: 9600 },
  { key: 'phoenix', label: 'Phoenix', baud: 9600 },
  { key: 'omace', label: 'Omace', baud: 9600 },
  { key: 'orient', label: 'Orient', baud: 9600 },
  { key: 'other', label: 'Other', baud: 9600 },
]
export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 115200]

export const SCALE_DEFAULTS: BranchScale = { enabled: false, brand: 'other', baudRate: 9600, autoAdd: true, minGrams: 10, roundGrams: 0 }

/** A saved / sent scale setup made safe: known values only, anything else from the defaults. */
export function cleanScale(input: unknown, cur: BranchScale = SCALE_DEFAULTS): BranchScale {
  const x = (input && typeof input === 'object' ? input : {}) as Partial<BranchScale>
  return {
    enabled: x.enabled === undefined ? cur.enabled : !!x.enabled,
    brand: SCALE_BRANDS.some((b) => b.key === x.brand) ? (x.brand as ScaleBrand) : cur.brand,
    baudRate: BAUD_RATES.includes(Number(x.baudRate)) ? Number(x.baudRate) : cur.baudRate,
    autoAdd: x.autoAdd === undefined ? cur.autoAdd : !!x.autoAdd,
    minGrams: x.minGrams === undefined ? cur.minGrams : Math.min(1000, Math.max(0, Math.round(Number(x.minGrams) || 0))),
    roundGrams: ([0, 5, 10] as const).includes(Number(x.roundGrams) as 0) ? (Number(x.roundGrams) as 0 | 5 | 10) : cur.roundGrams,
  }
}

/** One reading from the scale: kilograms, and whether the scale says it is steady (null = it doesn't say). */
export interface ScaleReading { kg: number; stable: boolean | null }

/**
 * Reads one line the scale sent. Scales send text like "ST,GS,+  0.500kg", "  0.500 kg", "US,NT,-0.020 kg",
 * "W:  500 g" or just "0.500": the last number on the line is the weight, the unit after it (g / kg / lb) says
 * how to read it (none = kg), ST / US say steady / moving. Anything without a number → null.
 */
export function parseScaleLine(raw: string): ScaleReading | null {
  const line = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  if (!line) return null
  const nums = [...line.matchAll(/([+-]?)\s*(\d+(?:\.\d+)?)\s*(kg|g|lb)?/gi)]
  const m = nums[nums.length - 1]
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  const n = sign * Number(m[2])
  const unit = (m[3] ?? 'kg').toLowerCase()
  const kg = unit === 'g' ? n / 1000 : unit === 'lb' ? n * 0.45359237 : n
  if (!Number.isFinite(kg) || Math.abs(kg) > 5000) return null
  const stable = /\bST\b/i.test(line) ? true : /\b(US|MOTION)\b/i.test(line) ? false : null
  return { kg: Math.round(kg * 1000) / 1000, stable }
}

/** The weight to bill: rounded as the branch asks; under the minimum (an empty pan) → 0. */
export function billWeight(kg: number, s: Pick<BranchScale, 'minGrams' | 'roundGrams'>): number {
  const g = kg * 1000
  if (g < Math.max(1, s.minGrams)) return 0
  const r = s.roundGrams ? Math.round(g / s.roundGrams) * s.roundGrams : Math.round(g)
  return r / 1000
}
