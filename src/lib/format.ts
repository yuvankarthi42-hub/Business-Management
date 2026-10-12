export const uid = (prefix = '') =>
  prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })

let symbol = '₹'
export const setCurrencySymbol = (s: string) => { symbol = s }

/** ₹25,300 — whole rupees shown without decimals. */
export const money = (n: number, opts: { decimals?: boolean } = {}) => {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const fmt = opts.decimals || abs % 1 !== 0 ? inr2 : inr
  return `${sign}${symbol}${fmt.format(abs)}`
}

export const num = (n: number) => inr.format(n)

// ---------- Dates ----------

export const startOfDay = (d: Date | string = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
export const endOfDay = (d: Date | string = new Date()) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const sameDay = (a: Date | string, b: Date | string) => startOfDay(a).getTime() === startOfDay(b).getTime()
export const toDateInput = (d: Date | string) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
export const fmtTime = (d: Date | string) =>
  new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
export const fmtDateTime = (d: Date | string) => `${fmtDate(d)}, ${fmtTime(d)}`

export const timeAgo = (d: Date | string, now = Date.now()) => {
  const mins = Math.floor((now - new Date(d).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ${mins % 60}m ago`
  return fmtDate(d)
}

export const minutesSince = (d: Date | string, now = Date.now()) => Math.floor((now - new Date(d).getTime()) / 60000)

export const pctChange = (cur: number, prev: number) => (prev === 0 ? (cur > 0 ? 100 : 0) : ((cur - prev) / prev) * 100)

export type RangeKey = 'today' | 'yesterday' | 'week' | 'month' | 'custom'
export function rangeFor(key: RangeKey, custom?: { from: string; to: string }): { from: Date; to: Date } {
  const today = startOfDay()
  switch (key) {
    case 'today': return { from: today, to: endOfDay() }
    case 'yesterday': return { from: addDays(today, -1), to: endOfDay(addDays(today, -1)) }
    case 'week': {
      const day = (today.getDay() + 6) % 7 // Monday start
      return { from: addDays(today, -day), to: endOfDay() }
    }
    case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: endOfDay() }
    case 'custom': return { from: startOfDay(custom!.from), to: endOfDay(custom!.to) }
  }
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const below100 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)
const below1000 = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', below100(n % 100)].filter(Boolean).join(' ')

/** 147.5 -> "Rupees One Hundred Forty Seven and Fifty Paise Only" (Indian lakh / crore grouping). */
export function amountInWords(amount: number, currency = 'Rupees') {
  const rupees = Math.floor(Math.abs(amount))
  const paise = Math.round((Math.abs(amount) - rupees) * 100)
  const parts: string[] = []
  let n = rupees
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const thousand = Math.floor(n / 1000); n %= 1000
  if (crore) parts.push(`${below1000(crore)} Crore`)
  if (lakh) parts.push(`${below100(lakh)} Lakh`)
  if (thousand) parts.push(`${below100(thousand)} Thousand`)
  if (n) parts.push(below1000(n))
  const words = parts.join(' ') || 'Zero'
  return `${currency} ${words}${paise ? ` and ${below100(paise)} Paise` : ''} Only`
}
