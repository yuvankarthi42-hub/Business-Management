// Public legal pages: /terms and /privacy. Plain language; based on how the product actually works
// (accounts created by us, subscription per branch, read-only after expiry, data export, WhatsApp via Meta).
import { ArrowLeft, Printer } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Logo } from '@/app/Layout'
import { BRAND, supportMailto } from '@/core/brand'

type Sec = { id: string; title: string; body: ReactNode }

const P = ({ children }: { children: ReactNode }) => <p className="mt-2 leading-relaxed text-slate-700">{children}</p>
const UL = ({ items }: { items: ReactNode[] }) => <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed text-slate-700">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
const N = BRAND.name

const Contact = () => (
  <UL items={[
    <>Email: <a className="font-medium text-brand-700 underline" href={supportMailto()}>{BRAND.supportEmail}</a></>,
    <>Phone / WhatsApp: <a className="font-medium text-brand-700 underline" href={`tel:${BRAND.supportPhone}`}>{BRAND.supportPhoneDisplay}</a></>,
  ]} />
)

const TERMS: Sec[] = [
  { id: 'about', title: '1. About these terms', body: <>
    <P>These Terms &amp; Conditions (“Terms”) apply to {N} (“{N}”, “we”, “us”) — the billing, stock, staff, GST and business management software — including the web app, the installable app and any related services.</P>
    <P>By signing in or using {N}, the business that holds the account (“you”, “the shop”) and every person who signs in for it agree to these Terms. If you don’t agree, please don’t use the service.</P>
  </> },
  { id: 'service', title: '2. The service', body: <>
    <P>{N} lets a business make bills, manage items and stock, customers, staff, purchases, expenses, GST reports and more, from a browser on a computer, tablet or phone. Features depend on your business type and the modules switched on for your account.</P>
    <UL items={[
      'Accounts are created by the ' + N + ' team. We give the owner a username / mobile number and password.',
      'The service needs an internet connection. Changes are not saved while you are offline.',
      'We improve the product regularly. Features may be added, changed or removed; we try not to remove something you rely on without notice.',
    ]} />
  </> },
  { id: 'accounts', title: '3. Your account and staff logins', body: <UL items={[
    'Keep passwords secret. The owner is responsible for everything done with the shop’s logins, including staff logins the owner creates.',
    'Give staff only the permissions they need (Settings → Staff & Roles). Remove access when someone leaves.',
    'Tell us at once if you think someone else has used your account.',
  ]} /> },
  { id: 'subscription', title: '4. Subscription, renewal and payment', body: <UL items={[
    'The subscription is charged per branch for the period agreed with you. Prices, taxes and the period are shown on your invoice or agreed in writing.',
    'Before the end date we remind you to renew. After the end date the account becomes read-only: you can view and download your data, but you can’t make bills or change data until you renew.',
    'Fees already paid are not refunded for the unused part of a period, except where required by law or agreed by us in writing.',
    'We may change prices for new periods with at least 30 days’ notice. The current period keeps its price.',
  ]} /> },
  { id: 'data', title: '5. Your data', body: <>
    <UL items={[
      'Your business data — bills, items, stock, customers, staff and reports — belongs to you. We use it only to run the service for you (see the Privacy Policy).',
      'You can download a full copy at any time (Settings → Audit & Data → Download your data).',
      'You are responsible for the data you enter and for having the right to enter it — for example, your customers’ phone numbers and their consent to receive messages.',
    ]} />
    <P><b>Bills and GST.</b> {N} gives you tools to make bills and GST reports. You remain responsible for your prices, tax rates, HSN codes, invoices and tax filings. The GST figures are a working aid — check them with your auditor before filing. {N} does not give tax, legal or financial advice.</P>
  </> },
  { id: 'use', title: '6. Acceptable use', body: <>
    <P>You agree not to:</P>
    <UL items={[
      'use the service for anything unlawful, including false bills or tax evasion;',
      'send spam or messages to people who haven’t agreed to receive them;',
      'try to access other businesses’ data, break security, overload the service or copy / resell the software;',
      'share your login with people outside your business.',
    ]} />
  </> },
  { id: 'third', title: '7. Other services we use', body: <P>{N} runs on trusted providers for hosting, databases and file storage. Optional features use other services: WhatsApp messages go through Meta (WhatsApp Business Platform) under Meta’s own terms and charges, and printing uses your own printer. We are not responsible for outages or changes of those services, but we will help you with any problem they cause in {N}.</P> },
  { id: 'availability', title: '8. Availability and support', body: <>
    <P>We work to keep {N} available and your data safe, with regular backups. There may be short breaks for maintenance or for reasons outside our control. We don’t promise that the service will never be interrupted or free of errors.</P>
    <P>Support is available by email, phone or WhatsApp, and from Help &amp; support inside the app.</P>
    <Contact />
  </> },
  { id: 'end', title: '9. Suspension and closing an account', body: <UL items={[
    'You can stop using ' + N + ' at any time by not renewing, or ask us to close the account.',
    'We may suspend an account that breaks these Terms, puts others at risk, or is not paid — we will tell you first unless the matter is urgent.',
    'After an account is closed or not renewed, we keep the data for 90 days so you can renew or download it, then delete it, except what we must keep by law.',
  ]} /> },
  { id: 'liability', title: '10. Limitation of liability', body: <P>To the extent allowed by law, {N} is provided “as is”. We are not liable for indirect losses such as lost profit, lost sales or lost data that could have been avoided by keeping your own export. Our total liability for any claim is limited to the fees you paid us for the three months before the claim.</P> },
  { id: 'changes', title: '11. Changes to these terms', body: <P>We may update these Terms. If a change is important, we will tell you in the app or by message before it applies. Using {N} after that means you accept the updated Terms.</P> },
  { id: 'law', title: '12. Governing law', body: <P>These Terms are governed by the laws of India. Disputes are subject to the courts of Tamil Nadu, India. We will always first try to solve a problem with you directly.</P> },
  { id: 'contact', title: '13. Contact', body: <Contact /> },
]

const PRIVACY: Sec[] = [
  { id: 'who', title: '1. Who we are', body: <>
    <P>This Privacy Policy explains how {N} (“we”, “us”) collects and uses personal data, in line with India’s Digital Personal Data Protection Act, 2023 and other applicable laws.</P>
    <UL items={[
      <>For <b>shop owners and staff</b> who use {N}, we decide how their account data is used.</>,
      <>For <b>a shop’s own customers and staff records</b> (names, phone numbers, bills), the shop decides why the data is collected; we process it on the shop’s behalf only to run the service.</>,
    ]} />
  </> },
  { id: 'collect', title: '2. What we collect', body: <UL items={[
    <><b>Account details:</b> business name, type, address, GSTIN, owner and staff names, mobile numbers, email, usernames, passwords (stored only as a secure hash), roles and branches.</>,
    <><b>Business data you enter:</b> items, prices, stock, bills, payments, returns, purchases, suppliers, expenses, staff attendance and salary, loyalty points, and your customers’ names, phone numbers and addresses.</>,
    <><b>Support data:</b> messages and screenshots you send to us.</>,
    <><b>Technical data:</b> sign-in times, device and browser type, and error logs, used to keep the service secure and working.</>,
  ]} /> },
  { id: 'use', title: '3. How we use it', body: <UL items={[
    'to provide the service — billing, reports, backups, sign-in and security;',
    'to send service messages, such as renewal reminders and important updates;',
    'to answer support requests and fix problems;',
    'to meet legal duties, such as tax records or lawful requests from authorities.',
  ]} /> },
  { id: 'not', title: '4. What we never do', body: <UL items={[
    'We do not sell personal data.',
    'We do not use your customers’ data for our own marketing or contact them ourselves.',
    'We do not show advertising in the app.',
  ]} /> },
  { id: 'shops', title: '5. If you are a shop: your customers’ data', body: <>
    <P>You are responsible for telling your customers why you save their details and for getting their consent where the law needs it — for example before sending offers on WhatsApp. {N} helps: each customer can be marked “Doesn’t want offers”, and you can edit or delete customer details at any time.</P>
  </> },
  { id: 'share', title: '6. Who we share it with', body: <>
    <P>Only with service providers that help us run {N}, under confidentiality and security obligations:</P>
    <UL items={[
      'hosting, database and file-storage providers (where the app and your data are kept);',
      'Meta (WhatsApp Business Platform) — only when you switch on WhatsApp, and only the message and phone number being sent;',
      'authorities, when the law requires it.',
    ]} />
  </> },
  { id: 'security', title: '7. How we protect it', body: <UL items={[
    'Data travels over encrypted connections (HTTPS).',
    'Passwords are stored as one-way hashes; access tokens and secrets are encrypted.',
    'Each shop’s data is kept separate from other shops’, and access inside a shop follows the roles you set.',
    'Data is backed up regularly. Only authorised ' + N + ' staff can open an account, for support, and those visits are recorded in the audit log.',
  ]} /> },
  { id: 'keep', title: '8. How long we keep it', body: <P>For as long as your account is active. After an account is closed or not renewed, we keep the data for 90 days so it can be restored or downloaded, then delete it — except records we must keep by law (for example, invoices for our own subscription).</P> },
  { id: 'rights', title: '9. Your rights', body: <>
    <P>You can ask us to:</P>
    <UL items={['show what personal data we hold about you;', 'correct or update it;', 'delete it, where the law allows;', 'withdraw consent for optional uses;', 'nominate someone to act for you if you are unable to.']} />
    <P>Shop owners can also download all their data from the app. Your customers can contact the shop directly, or us, and we will help the shop respond.</P>
  </> },
  { id: 'device', title: '10. Data on your device', body: <P>The app stores a few things in your browser — your sign-in, language, chosen branch and printer settings — so it works quickly. We don’t use advertising or tracking cookies.</P> },
  { id: 'children', title: '11. Children', body: <P>{N} is a business tool and is not meant for children under 18.</P> },
  { id: 'grievance', title: '12. Questions and complaints', body: <>
    <P>For any privacy question, request or complaint, contact our grievance team. We will reply as soon as possible and within the time the law requires.</P>
    <Contact />
  </> },
  { id: 'changes', title: '13. Changes to this policy', body: <P>We may update this policy. If a change is important, we will tell you in the app before it applies.</P> },
]

function LegalPage({ title, intro, sections }: { title: string; intro: string; sections: Sec[] }) {
  const nav = useNavigate()
  useEffect(() => { document.title = `${title} · ${N}`; window.scrollTo(0, 0) }, [title])
  return (
    <div className="min-h-[100dvh] bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5">
          <Logo light={false} />
          <div className="flex items-center gap-2 text-sm">
            <button type="button" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/login'))} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100"><ArrowLeft className="h-4 w-4" />Back</button>
            <button type="button" onClick={() => window.print()} className="hidden items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-600 hover:bg-slate-100 sm:inline-flex"><Printer className="h-4 w-4" />Print</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-10" data-no-i18n>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {BRAND.legalUpdated}</p>
        <p className="mt-4 leading-relaxed text-slate-700">{intro}</p>
        <nav className="mt-6 rounded-xl border border-slate-200 bg-white p-4 text-sm print:hidden" aria-label="Contents">
          <p className="mb-2 font-semibold text-slate-800">Contents</p>
          <ol className="grid gap-1 sm:grid-cols-2">
            {sections.map((s) => <li key={s.id}><a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' }) }} className="text-brand-700 hover:underline">{s.title}</a></li>)}
          </ol>
        </nav>
        <div className="mt-8 space-y-8">
          {sections.map((s) => <section key={s.id} id={s.id} className="scroll-mt-24"><h2 className="text-lg font-semibold text-slate-900">{s.title}</h2>{s.body}</section>)}
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-6 text-sm text-slate-500 print:hidden">
          <span>© {new Date().getFullYear()} {N}</span>
          <span className="flex gap-4"><Link to="/terms" className="hover:text-slate-800">Terms &amp; Conditions</Link><Link to="/privacy" className="hover:text-slate-800">Privacy Policy</Link></span>
        </div>
      </main>
    </div>
  )
}

export function TermsPage() {
  return <LegalPage title="Terms & Conditions" intro={`Please read these terms before using ${N}. They explain what we provide, what we expect from you, and how subscriptions, data and support work.`} sections={TERMS} />
}
export function PrivacyPage() {
  return <LegalPage title="Privacy Policy" intro={`Your business data is yours. This policy explains what ${N} collects, why, how we protect it and the choices you have.`} sections={PRIVACY} />
}
