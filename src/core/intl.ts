// Intl date formatters are slow to create (tens of microseconds each) but fast to use, and reports format one date
// per bill. Each locale + options pair is created once and reused — the output is exactly the same.
const cache = new Map<string, Intl.DateTimeFormat>()

export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let f = cache.get(key)
  if (!f) { f = new Intl.DateTimeFormat(locale, options); cache.set(key, f) }
  return f
}
