// Support contacts and links to the legal pages — small, so the landing and login pages can use them.
import { Mail, MessageCircle, Phone } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BRAND, supportMailto, supportWhatsAppLink } from '@/core/brand'

/** "Terms · Privacy" links (login, landing, settings, support). */
export function LegalLinks({ className = '' }: { className?: string }) {
  return <span className={className}><Link to="/terms" className="hover:underline">Terms &amp; Conditions</Link><span aria-hidden="true"> · </span><Link to="/privacy" className="hover:underline">Privacy Policy</Link></span>
}

/** Support email, phone and WhatsApp. */
export function SupportContacts({ dark = false, compact = false }: { dark?: boolean; compact?: boolean }) {
  const a = dark ? 'text-white/70 hover:text-white' : 'text-slate-600 hover:text-brand-700'
  return (
    <span className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 ${compact ? 'text-xs' : 'text-sm'}`}>
      <a href={`tel:${BRAND.supportPhone}`} className={`inline-flex items-center gap-1.5 ${a}`}><Phone className="h-3.5 w-3.5" />{BRAND.supportPhoneDisplay}</a>
      <a href={supportWhatsAppLink()} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 ${a}`}><MessageCircle className="h-3.5 w-3.5" />WhatsApp</a>
      <a href={supportMailto()} className={`inline-flex items-center gap-1.5 ${a}`}><Mail className="h-3.5 w-3.5" />{BRAND.supportEmail}</a>
    </span>
  )
}
