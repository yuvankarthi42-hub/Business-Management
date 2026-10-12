// Renewal reminder message: sent from BillPoodum's WhatsApp number as a Meta-approved template.

/** The reminder text, checked against Meta's template rules. */
export const REMINDER_FIELDS = ['owner', 'business', 'date', 'days', 'amount', 'support'] as const
export function reminderTemplateErrors(body: string) {
  const errs: string[] = []
  if (body.length < 20) errs.push('too short')
  if (body.length > 600) errs.push('keep it under 600 characters')
  const unknown = [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((f) => !(REMINDER_FIELDS as readonly string[]).includes(f))
  if (unknown.length) errs.push(`unknown field {${unknown[0]}}`)
  if (/^\s*\{\w+\}/.test(body) || /\{\w+\}[\s.!]*$/.test(body)) errs.push('can’t start or end with a field')
  if (/\}\s*\{/.test(body)) errs.push('two fields can’t be side by side')
  if (!body.includes('{date}') && !body.includes('{days}')) errs.push('include the end date or days left')
  return errs
}

export const REMINDER_FIELD_LABEL: Record<(typeof REMINDER_FIELDS)[number], string> = {
  owner: 'Owner name', business: 'Business name', date: 'End date', days: 'Days left', amount: 'Monthly amount', support: 'Support number',
}

export const REMINDER_SAMPLE = {
  en: 'Hi {owner}, your BillPoodum plan for {business} ends on {date} — {days} left. Renew now ({amount} / month) to keep billing without a break. Call or WhatsApp us on {support}. — Team BillPoodum',
  ta: 'வணக்கம் {owner}, {business}-க்கான உங்கள் BillPoodum திட்டம் {date} அன்று முடிகிறது — இன்னும் {days} மட்டுமே. தடையின்றி பில் போட இப்போதே புதுப்பிக்கவும் (மாதம் {amount}). அழைக்க / WhatsApp: {support}. — BillPoodum குழு',
} as const

/** "3 days" — or "3 நாள்" when the template is written in Tamil. */
export const daysText = (n: number, body: string) => (/[஀-௿]/.test(body) ? `${n} நாள்` : n === 1 ? '1 day' : `${n} days`)
