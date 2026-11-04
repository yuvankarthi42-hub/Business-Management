// GST split in SQL with exactly the app's rounding (splitTax in src/core/gst.ts), so the database can add up CGST /
// SGST / IGST per line itself: tax = r2(t / 100); cgst = r2(tax / 2); sgst = r2(tax − cgst); igst = r2(tax), where
// r2(x) = Math.round((x + Number.EPSILON) × 100) / 100. SQLite numbers are IEEE doubles like JavaScript's, so the same
// steps give the same doubles; Math.round is done exactly (whole part, +1 when the fraction is ≥ 0.5). The test checks
// it against splitTax for every amount from ₹0 to ₹50,000.

const EPS = '(1.0 / 4503599627370496.0)' // Number.EPSILON = 2^-52, exactly
/** Math.round(x) for x ≥ 0, exact. */
const rnd = (x: string) => `(CAST(${x} AS INTEGER) + ((${x}) - CAST(${x} AS INTEGER) >= 0.5))`

/**
 * Wraps a row source that has `t` (GST in paise, ≥ 0) and adds, per row: `cg` / `sg` (CGST / SGST in paise, as
 * splitTax(t, false) gives them) and `igp` (IGST in paise, as splitTax(t, true)).
 */
export const withGstSplit = (src: string) => `(SELECT *, ${rnd(`((tax - cg / 100.0) + ${EPS}) * 100`)} AS sg FROM (
  SELECT *, ${rnd(`(tax / 2.0 + ${EPS}) * 100`)} AS cg, ${rnd(`(tax + ${EPS}) * 100`)} AS igp FROM (
    SELECT *, ${rnd(`(t / 100.0 + ${EPS}) * 100`)} / 100.0 AS tax FROM ${src})))`
