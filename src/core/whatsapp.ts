// WhatsApp Business templates: fields, Meta's rules and rendering. Pure functions (server reuses them).

export type WaTemplateKind = 'offer' | 'bill'
export type WaLang = 'en' | 'ta'

export const WA_FIELDS = {
  customer_name: { label: 'Customer name', sample: 'Revathi' },
  shop_name: { label: 'Shop name', sample: 'FreshMart Supermarket' },
  offer_details: { label: 'Offer details', sample: 'Sunflower Oil 1 L ₹145 (MRP ₹170)' },
  bill_no: { label: 'Bill no', sample: 'FM-10391' },
  amount: { label: 'Amount', sample: '₹1,284.00' },
  date: { label: 'Date', sample: '09 Oct 2026' },
} as const
export type WaField = keyof typeof WA_FIELDS

export const WA_KIND: Record<WaTemplateKind, { title: string; category: 'MARKETING' | 'UTILITY'; fields: WaField[]; required: WaField[]; attach: string; name: string }> = {
  offer: { title: 'Today’s offer', category: 'MARKETING', fields: ['customer_name', 'shop_name', 'offer_details'], required: ['offer_details'], attach: 'Attach today’s offer poster as the image', name: 'daily_offer' },
  bill: { title: 'Bill / receipt', category: 'UTILITY', fields: ['customer_name', 'shop_name', 'bill_no', 'amount', 'date'], required: ['bill_no'], attach: 'Attach bill as PDF', name: 'bill_receipt' },
}

/** Ready-made offer sample we give every customer (they can edit it before submitting). */
export const OFFER_SAMPLE: Record<WaLang, string> = {
  en: 'Hi {{customer_name}}! Special offer today at {{shop_name}}: {{offer_details}}. Visit us today!',
  ta: 'வணக்கம் {{customer_name}}! இன்று {{shop_name}}-இல் சிறப்பு சலுகை: {{offer_details}}. இன்றே வாங்குங்கள்!',
}
/** Starting point for the bill editor. */
export const BILL_STARTER: Record<WaLang, string> = {
  en: 'Dear {{customer_name}}, thank you for shopping at {{shop_name}}. Your bill {{bill_no}} for {{amount}} on {{date}} is attached.',
  ta: 'அன்புள்ள {{customer_name}}, {{shop_name}}-இல் வாங்கியதற்கு நன்றி. {{date}} அன்று உங்கள் பில் {{bill_no}} தொகை {{amount}} இணைக்கப்பட்டுள்ளது.',
}

const VAR = /\{\{(\w+)\}\}/g
export const fieldsIn = (body: string) => [...body.matchAll(VAR)].map((m) => m[1])

export interface Check { ok: boolean; level: 'error' | 'warn'; text: string }
/** Meta's template rules, checked while typing. Errors block submitting; warnings don't. */
export function checkTemplate(kind: WaTemplateKind, body: string): Check[] {
  const t = body.trim()
  const used = fieldsIn(t)
  const allowed = WA_KIND[kind].fields as string[]
  const checks: Check[] = [
    { ok: t.length >= 10 && t.length <= 1024, level: 'error', text: 'Between 10 and 1,024 characters' },
    { ok: !/^\{\{\w+\}\}/.test(t) && !/\{\{\w+\}\}[.!?]?$/.test(t), level: 'error', text: 'Doesn’t start or end with a field' },
    { ok: !/\}\}\s*\{\{/.test(t), level: 'error', text: 'No two fields side by side' },
    { ok: used.every((f) => allowed.includes(f)), level: 'error', text: 'Only the fields shown above' },
    { ok: WA_KIND[kind].required.every((f) => used.includes(f)), level: 'error', text: `Includes ${WA_KIND[kind].required.map((f) => WA_FIELDS[f].label).join(', ')}` },
  ]
  if (kind === 'bill') checks.push({ ok: !/\b(offer|discount|sale|free|cashback|% off)\b/i.test(t), level: 'warn', text: 'No words like offer or discount — Meta may charge it as marketing' })
  return checks
}
export const templateErrors = (kind: WaTemplateKind, body: string) => checkTemplate(kind, body).filter((c) => !c.ok && c.level === 'error').map((c) => c.text)

/** Fill the fields (WhatsApp parameters can't contain new lines, so they're flattened). */
export function renderTemplate(body: string, values: Partial<Record<WaField, string>>) {
  return body.replace(VAR, (_, k: WaField) => (values[k] ?? WA_FIELDS[k]?.sample ?? '').replace(/\s*\n+\s*/g, ' · ').trim())
}
export const sampleValues = () => Object.fromEntries(Object.entries(WA_FIELDS).map(([k, v]) => [k, v.sample])) as Record<WaField, string>

// ---------- Wording per business type ----------

export interface WaCopy {
  intro: string
  bills: string
  offers: string
  status: string
  /** Example "offer details" for previews and placeholders. */
  offerSample: string
  billSample: string
}

/** WhatsApp screens talk the shop's language: dishes for a restaurant, wires and switches for a hardware shop. */
export function waCopyFor(b: { category: string; subType: string }): WaCopy {
  const s = b.subType.toLowerCase()
  if (b.category === 'retail' && /hardware|electric/.test(s)) return {
    intro: 'GST bills and new-stock offers go straight from your WhatsApp Business number to contractors, electricians and walk-in customers.',
    bills: 'GST bill PDF to the contractor or customer right after billing — easy for their accounts',
    offers: 'New stock, price drops and festival offers to contractors and electricians in one click',
    status: 'See who received and read it — no more “I didn’t get the bill”',
    offerSample: 'Havells 1.5 sq mm wire 90 m ₹1,850 (MRP ₹2,100), Anchor 6A switch ₹28',
    billSample: '₹12,450.00',
  }
  if (b.category === 'retail' && /electronic/.test(s)) return {
    intro: 'Bills with warranty details and new-arrival offers go straight from your WhatsApp Business number.',
    bills: 'Bill PDF right after billing — customers keep it for warranty claims',
    offers: 'New arrivals, exchange and festival offers to your customers in one click',
    status: 'See sent, delivered and read for every message',
    offerSample: 'LED TV 43 inch ₹26,990 (MRP ₹32,000), free wall mount',
    billSample: '₹26,990.00',
  }
  if (b.category === 'retail' && /super|grocery|maligai/.test(s)) return {
    intro: 'Bills and weekly offers go straight from your WhatsApp Business number — no opening WhatsApp for each customer.',
    bills: 'Bill PDF right after billing — no paper bill needed',
    offers: 'Weekly offers and price drops to your regular customers in one click',
    status: 'See sent, delivered and read for every message',
    offerSample: 'Sunflower Oil 1 L ₹145 (MRP ₹170), Toor Dal 1 kg ₹140',
    billSample: '₹1,284.00',
  }
  if (b.category === 'retail') return {
    intro: 'Bills and new-arrival offers go straight from your WhatsApp Business number.',
    bills: 'Bill PDF to the customer right after billing',
    offers: 'New arrivals and festival offers to your customers in one click',
    status: 'See sent, delivered and read for every message',
    offerSample: 'New school bags from ₹499, notebooks 6 for ₹180',
    billSample: '₹1,250.00',
  }
  if (b.category === 'service') return {
    intro: 'Bills and offers go straight from your WhatsApp Business number to your clients.',
    bills: 'Bill to the client right after the service',
    offers: 'Festival and combo offers to your regular clients in one click',
    status: 'See sent, delivered and read for every message',
    offerSample: 'Haircut + beard trim ₹199 (was ₹250), facial ₹499',
    billSample: '₹449.00',
  }
  return {
    intro: 'Bills and today’s specials go straight from your WhatsApp Business number — no opening WhatsApp for each customer.',
    bills: 'Bill to the customer right after payment',
    offers: 'Today’s specials to all your regular customers in one click',
    status: 'See sent, delivered and read for every message',
    offerSample: /bakery|sweet/.test(s) ? 'Black Forest cake ½ kg ₹450 (was ₹520), veg puff ₹20' : 'Chicken Biryani ₹180 (was ₹220), Paneer Butter Masala ₹160',
    billSample: '₹640.00',
  }
}
