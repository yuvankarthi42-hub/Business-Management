import type { PaymentMethod } from '@/core/types'

// Categorical palette, validated for CVD separation and contrast (light surface).
// Fixed order — colour follows the payment method, never its rank.
export const METHOD_COLOR: Record<PaymentMethod, string> = {
  cash: '#1f55eb', upi: '#0d9488', card: '#d97706', bank: '#9333ea', credit: '#e11d48',
  credit_note: '#64748b', // neutral: not new money, an earlier return being used
}
export const SERIES = { current: '#1f55eb', previous: '#cbd5e1', expense: '#d97706' }
export const AXIS = { tick: { fontSize: 11, fill: '#64748b' }, grid: '#eef2f6' }
