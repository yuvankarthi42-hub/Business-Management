/** EAN-13 check digit for a 12-digit prefix. */
export function ean13(prefix12: string) {
  const sum = prefix12.split('').map(Number).reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0)
  return prefix12 + ((10 - (sum % 10)) % 10)
}

/**
 * Next in-store barcode (EAN-13 starting "20", the range reserved for a shop's own items),
 * one more than the highest one already used.
 */
export function nextInStoreBarcode(existing: string[]) {
  const used = existing.filter((c) => /^20\d{11}$/.test(c)).map((c) => Number(c.slice(2, 12)))
  const next = (used.length ? Math.max(...used) : 0) + 1
  return ean13(`20${String(next).padStart(10, '0')}`)
}

/** Looks like a scanned code rather than a typed name. */
export const looksLikeBarcode = (s: string) => /^\d{6,14}$/.test(s.trim())
