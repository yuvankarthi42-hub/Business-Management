// Limits every bill, payment, price and quantity must keep (checked by the server; the demo app uses the same rules).

/** Lines on one bill. */
export const MAX_BILL_ITEMS = 500
/** Any money amount: a real number from 0 to ₹1 crore. */
export const MAX_AMOUNT = 1_00_00_000
/** Units sold in parts (weight, volume, length, time). Everything else (pc, box, pack, dozen, set, pair, plate…) is whole. */
export const DECIMAL_UNITS = ['kg', 'g', 'ltr', 'ml', 'mtr', 'ft', 'hr']
export const allowsDecimalQty = (unit: string | null | undefined) => DECIMAL_UNITS.includes(String(unit ?? '').trim().toLowerCase())

/** Why this isn't a valid amount (null = fine). `positive`: 0 is not allowed (a payment, an expense). */
export function amountError(v: unknown, opts: { positive?: boolean } = {}): string | null {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || Array.isArray(v) || (typeof v === 'object')) return 'Enter an amount'
  const n = Number(v)
  if (!Number.isFinite(n)) return 'Enter a valid amount'
  if (n < 0) return 'The amount can’t be negative'
  if (opts.positive && !(n > 0)) return 'Enter an amount more than 0'
  if (n > MAX_AMOUNT) return 'The amount is too large (₹1 crore at most)'
  return null
}

/** Why this isn't a valid quantity for the unit (null = fine): more than 0, whole unless the unit is sold in parts. */
export function qtyError(qty: unknown, unit: string | null | undefined): string | null {
  const n = Number(qty)
  if (typeof qty === 'boolean' || !Number.isFinite(n) || !(n > 0) || n > 100_000) return 'Check the quantity'
  if (!allowsDecimalQty(unit) && !Number.isInteger(n)) return `Whole numbers only for ${String(unit || 'pc')}`
  return null
}

/** Text from a request: text as it is, a number as its digits, nothing as ''; anything else (an object, a list) → null. */
export function asText(v: unknown): string | null {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  return null
}

/** Why this isn't a valid name (null = fine): something typed, at most `max` characters. `what`: "the item name"… */
export function nameError(v: unknown, what: string, max = 150): string | null {
  const s = asText(v)
  if (s === null) return `Check ${what}`
  if (!s.trim()) return `Enter ${what}`
  if (s.trim().length > max) return `${what[0].toUpperCase()}${what.slice(1)} can be at most ${max} characters`
  return null
}
