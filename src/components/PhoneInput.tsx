import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { COUNTRIES, countryByIso, phoneError, splitPhone, type Country } from '@/core/phone'

/**
 * Mobile number with country code. `value` / `onChange` use E.164 ("+919876543210", or "" when empty).
 * The country defaults to the business's country; typing a number starting with "+" picks the country.
 */
export function PhoneInput({ value, onChange, defaultCountry = 'IN', required, autoFocus, placeholder, className, size = 'md', id }: {
  value: string; onChange: (e164: string) => void; defaultCountry?: string; required?: boolean; autoFocus?: boolean
  placeholder?: string; className?: string; size?: 'sm' | 'md'; id?: string
}) {
  const fromValue = () => {
    const { country, national } = value ? splitPhone(value) : { country: null, national: '' }
    return { country: country ?? countryByIso(defaultCountry), national }
  }
  const [country, setCountry] = useState<Country>(() => fromValue().country)
  const [national, setNational] = useState(() => fromValue().national)
  const [touched, setTouched] = useState(false)

  // Follow outside changes (form reset, editing another record).
  useEffect(() => {
    const cur = national ? `+${country.dial}${national}` : ''
    if (value !== cur) { const v = fromValue(); setCountry(v.country); setNational(v.national) }
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (c: Country, n: string) => onChange(n ? `+${c.dial}${n}` : '')
  const onType = (raw: string) => {
    if (raw.trim().startsWith('+')) { // pasted an international number
      const { country: c, national: n } = splitPhone(raw)
      if (c) { setCountry(c); setNational(n.slice(0, 15)); emit(c, n.slice(0, 15)); return }
    }
    let n = raw.replace(/\D/g, '')
    if (n.length > country.len[1] && n.startsWith('0')) n = n.slice(1)
    n = n.slice(0, 15)
    setNational(n); emit(country, n)
  }
  const err = touched && national ? phoneError(`+${country.dial}${national}`) : null
  const h = size === 'sm' ? 'h-9 text-sm' : 'h-10 text-sm'

  return (
    <div className={className}>
      <div className={clsx('flex overflow-hidden rounded-lg border bg-white shadow-sm transition focus-within:ring-4',
        err ? 'border-red-400 focus-within:ring-red-500/10' : 'border-slate-200 focus-within:border-brand-500 focus-within:ring-brand-500/10')}>
        <select
          aria-label="Country code" value={country.iso}
          onChange={(e) => { const c = countryByIso(e.target.value); setCountry(c); emit(c, national) }}
          className={clsx('shrink-0 border-0 border-r border-slate-200 bg-slate-50 py-0 pl-2.5 pr-7 font-medium text-slate-700 focus:ring-0', h)}
        >
          {COUNTRIES.map((c) => <option key={c.iso} value={c.iso}>{c.flag} +{c.dial}</option>)}
        </select>
        <input
          id={id} type="tel" inputMode="tel" autoComplete="tel-national" autoFocus={autoFocus} required={required}
          value={national} onChange={(e) => onType(e.target.value)} onBlur={() => setTouched(true)}
          placeholder={placeholder ?? country.example}
          className={clsx('min-w-0 flex-1 border-0 bg-transparent px-3 tabular placeholder:text-slate-400 focus:outline-none focus:ring-0', h)}
        />
      </div>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  )
}
