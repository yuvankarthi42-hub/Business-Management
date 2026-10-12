// Phone numbers: one rule for every screen and API.
// Stored as E.164 — "+" + country code + national number, digits only (e.g. "+919876543210").
// Pure functions so the same validation can run on the server.

export interface Country {
  iso: string // ISO 3166-1 alpha-2
  name: string
  dial: string // country calling code, digits only
  flag: string
  len: [number, number] // allowed national number length (min, max)
  example: string // national format example
}

export const COUNTRIES: Country[] = [
  { iso: 'IN', name: 'India', dial: '91', flag: '🇮🇳', len: [10, 10], example: '98765 43210' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '971', flag: '🇦🇪', len: [9, 9], example: '50 123 4567' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966', flag: '🇸🇦', len: [9, 9], example: '50 123 4567' },
  { iso: 'QA', name: 'Qatar', dial: '974', flag: '🇶🇦', len: [8, 8], example: '3312 3456' },
  { iso: 'KW', name: 'Kuwait', dial: '965', flag: '🇰🇼', len: [8, 8], example: '500 12345' },
  { iso: 'OM', name: 'Oman', dial: '968', flag: '🇴🇲', len: [8, 8], example: '9212 3456' },
  { iso: 'BH', name: 'Bahrain', dial: '973', flag: '🇧🇭', len: [8, 8], example: '3600 1234' },
  { iso: 'SG', name: 'Singapore', dial: '65', flag: '🇸🇬', len: [8, 8], example: '8123 4567' },
  { iso: 'MY', name: 'Malaysia', dial: '60', flag: '🇲🇾', len: [9, 10], example: '12 345 6789' },
  { iso: 'LK', name: 'Sri Lanka', dial: '94', flag: '🇱🇰', len: [9, 9], example: '71 234 5678' },
  { iso: 'NP', name: 'Nepal', dial: '977', flag: '🇳🇵', len: [10, 10], example: '984 1234567' },
  { iso: 'BD', name: 'Bangladesh', dial: '880', flag: '🇧🇩', len: [10, 10], example: '1812 345678' },
  { iso: 'US', name: 'United States / Canada', dial: '1', flag: '🇺🇸', len: [10, 10], example: '201 555 0123' },
  { iso: 'GB', name: 'United Kingdom', dial: '44', flag: '🇬🇧', len: [10, 10], example: '7400 123456' },
  { iso: 'AU', name: 'Australia', dial: '61', flag: '🇦🇺', len: [9, 9], example: '412 345 678' },
]

export const DEFAULT_COUNTRY = 'IN'
export const countryByIso = (iso?: string | null) => COUNTRIES.find((c) => c.iso === iso) ?? COUNTRIES[0]
const digits = (s: string) => s.replace(/\D/g, '')

/** Split an E.164 number into its country and national part (longest matching code wins). */
export function splitPhone(e164: string): { country: Country | null; national: string } {
  const d = digits(e164)
  const match = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find((c) => d.startsWith(c.dial))
  return match ? { country: match, national: d.slice(match.dial.length) } : { country: null, national: d }
}

/**
 * Turn user input into E.164. Accepts "+971 50 123 4567", "00971…", "098765 43210" or a bare
 * national number (uses the default country). Returns null for empty input; throws on invalid.
 */
export function normalizePhone(input: string | null | undefined, defaultIso: string = DEFAULT_COUNTRY): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  let d = digits(raw)
  if (!d) return null
  let e164: string
  if (raw.startsWith('+')) e164 = `+${d}`
  else if (d.startsWith('00')) e164 = `+${d.slice(2)}`
  else {
    const c = countryByIso(defaultIso)
    if (d.length > c.len[1] && d.startsWith(c.dial)) d = d.slice(c.dial.length) // typed with the code but no "+"
    if (d.length === c.len[1] + 1 && d.startsWith('0')) d = d.slice(1) // trunk prefix, e.g. 09876543210
    e164 = `+${c.dial}${d}`
  }
  const err = phoneError(e164)
  if (err) throw new Error(err)
  return e164
}

/** Validation message for an E.164 number, or null when it's valid. */
export function phoneError(e164: string): string | null {
  if (!/^\+\d{7,15}$/.test(e164)) return 'Enter a valid mobile number with country code'
  const { country, national } = splitPhone(e164)
  if (!country) return null // country not in our list: accept any 7–15 digit international number
  const [min, max] = country.len
  if (national.length < min || national.length > max) {
    return `${country.name} numbers have ${min === max ? min : `${min}–${max}`} digits after +${country.dial}`
  }
  return null
}

export const isValidPhone = (e164?: string | null) => !!e164 && !phoneError(e164)

/** "+919876543210" → "+91 98765 43210" (readable, still unambiguous). */
export function formatPhone(e164?: string | null) {
  if (!e164) return ''
  if (!e164.startsWith('+')) return e164 // not normalised yet — show as entered
  const { country, national } = splitPhone(e164)
  if (!country) return e164
  const n = national
  const grouped = country.iso === 'IN' || country.iso === 'NP' || country.iso === 'BD'
    ? `${n.slice(0, 5)} ${n.slice(5)}`
    : n.length <= 8 ? `${n.slice(0, 4)} ${n.slice(4)}` : `${n.slice(0, n.length - 7)} ${n.slice(-7, -4)} ${n.slice(-4)}`
  return `+${country.dial} ${grouped.trim()}`
}

/** Digits only, for wa.me links ("+919876543210" → "919876543210"). */
export const waNumber = (e164?: string | null) => (e164 ? digits(e164) : '')

/** True when a search term (any format) matches a stored number. */
export const phoneMatches = (e164: string | null | undefined, term: string) => {
  const t = digits(term)
  return !!t && !!e164 && digits(e164).includes(t)
}
