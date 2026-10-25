// Product name and support contacts — one place, used by the app, the landing page, legal pages and the backend.
export const BRAND = {
  name: 'Kadai Kalanjiyam',
  nameTa: 'கடை களஞ்சியம்',
  tagline: 'Billing, stock, GST — ellam ore idathil',
  supportEmail: 'KadaiKalanjiyam@gmail.com',
  /** E.164 and how it is shown. */
  supportPhone: '+917013905970',
  supportPhoneDisplay: '+91 70139 05970',
  /** wa.me number (country code, no +). */
  supportWhatsApp: '917013905970',
  /** Terms & Privacy: effective date shown on the pages. */
  legalUpdated: '22 October 2026',
} as const

export const supportMailto = (subject = `${BRAND.name} support`) => `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(subject)}`
export const supportWhatsAppLink = (text = `Hi, I need help with ${BRAND.name}.`) => `https://wa.me/${BRAND.supportWhatsApp}?text=${encodeURIComponent(text)}`

/** The Kadai Kalanjiyam logo — a shop front (same as public/icon.svg), inline so it works offline. */
export const BRAND_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f55eb"/><path d="M12 24l4-10h32l4 10z" fill="#ffb020"/><path d="M12 24c0 3 2.7 5 5 5s5-2 5-5c0 3 2.7 5 5 5s5-2 5-5c0 3 2.7 5 5 5s5-2 5-5c0 3 2.7 5 5 5s5-2 5-5" fill="#ffb020"/><path d="M22 14l-2 10M32 14v10M42 14l2 10" stroke="#fff" stroke-width="2"/><rect x="16" y="31" width="32" height="20" rx="2" fill="#fff"/><rect x="27" y="37" width="10" height="14" rx="1.5" fill="#1f55eb"/></svg>'
export const BRAND_LOGO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(BRAND_LOGO_SVG)}`

/** The shop's own logo, or the Kadai Kalanjiyam logo when none is uploaded. */
export const shopLogo = (b: { logoUrl?: string | null } | null | undefined) => b?.logoUrl || BRAND_LOGO
