import clsx from 'clsx'
import {
  AlertTriangle, BookOpen, Check, CheckCircle2, ChevronRight, Circle, Eye, EyeOff, FlaskConical, Info, Lock, MessageCircle, Pencil, Plug, Plus, RefreshCw, Send, Unplug, XCircle,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '@/app/AppContext'
import { Badge, Button, Card, Field, Input, Modal, Segmented, Select, useAction, useToast } from '@/components/ui'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone } from '@/core/phone'
import { daysText, REMINDER_FIELD_LABEL, REMINDER_FIELDS, REMINDER_SAMPLE, reminderTemplateErrors } from '@/core/reminders'
import { api } from '@/data'
import { fmtDateTime, useAdminCan } from './shared'

type Status = Awaited<ReturnType<typeof api.admin.waStatus>>
type Lang = 'en' | 'ta'
const STEPS = ['Connect account', 'Test', 'Reminder template'] as const

/** Admin → WhatsApp: Kadai Kalanjiyam's own WhatsApp Business number, used for renewal reminders to shop owners. */
export default function AdminWhatsApp() {
  const can = useAdminCan()
  // Read when the page opens and after a change. While Meta reviews the template: "Check now" (no timer).
  const [check, setCheck] = useState(0)
  const { data: wa } = useData(() => api.admin.waStatus(), [check])
  const [open, setOpen] = useState(false)
  if (!wa) return null
  const editable = can('pricing.manage')
  const connected = wa.step === 4
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">WhatsApp</h1>
        <p className="text-sm text-slate-500">Kadai Kalanjiyam’s own WhatsApp Business number. Renewal reminders go to shop owners from this number.</p>
      </div>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><MessageCircle className="h-6 w-6" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">WhatsApp Business (Meta Cloud API)</p>
            <p className="text-sm text-slate-500">{wa.config?.businessNumber ? formatPhone(wa.config.businessNumber) : 'Not connected'} · {wa.ready ? 'renewal reminders are going out' : 'renewal reminders are off until setup is done'}</p>
          </div>
          {!wa.ready && connected && <Button size="sm" variant="ghost" icon={RefreshCw} write={false} onClick={() => setCheck((n) => n + 1)}>Check now</Button>}
          {wa.ready ? <Badge tone="green" dot>Connected</Badge> : connected ? <Badge tone="amber">Waiting for Meta</Badge> : wa.config ? <Badge tone="amber">Setup incomplete · step {wa.step} of 3</Badge> : <Badge>Not set up</Badge>}
          {editable && !open && <Button variant={connected ? 'secondary' : 'primary'} write={false} onClick={() => setOpen(true)}>{connected ? 'Manage' : wa.config ? 'Continue setup' : 'Set up'}</Button>}
        </div>
        {!connected && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
            {STEPS.map((s, i) => <span key={s} className="inline-flex items-center gap-1">{wa.step > i + 1 ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Circle className="h-3.5 w-3.5" />}{s}</span>)}
          </div>
        )}
        {!editable && <p className="mt-3 flex items-center gap-1.5 border-t border-slate-100 pt-3 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" />Only a super admin can change this.</p>}
      </Card>
      {open && editable && (connected ? <Connected wa={wa} onClose={() => setOpen(false)} /> : <Wizard wa={wa} onClose={() => setOpen(false)} />)}
      {!open && connected && <TemplateCard wa={wa} editable={false} />}
      {!open && <RecentMessages wa={wa} />}
    </div>
  )
}

const DemoNote = () => (
  <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
    <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
    Demo mode: the connection check, Meta’s template approval and sending are simulated until the server is connected. No real WhatsApp messages are sent.
  </p>
)

function Wizard({ wa, onClose }: { wa: Status; onClose: () => void }) {
  const [step, setStep] = useState(Math.min(3, wa.step))
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-1.5 text-xs">
        {STEPS.map((s, i) => {
          const n = i + 1, done = wa.step > n, here = step === n
          return (
            <span key={s} className="flex items-center gap-1.5">
              <button type="button" disabled={n > wa.step} onClick={() => setStep(n)}
                className={clsx('inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium', here ? 'bg-brand-50 text-brand-700' : done ? 'bg-emerald-50 text-emerald-700' : 'border border-slate-200 text-slate-500')}>
                {done && !here ? <Check className="h-3.5 w-3.5" /> : <span>{n}</span>}{s}
              </button>
              {i < STEPS.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
            </span>
          )
        })}
      </div>
      {step === 1 && <StepConnect wa={wa} onCancel={onClose} onNext={() => setStep(2)} />}
      {step === 2 && <StepTest wa={wa} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
      {step === 3 && (
        <div className="space-y-4">
          <div><h3 className="text-lg font-semibold">Renewal reminder template</h3><p className="text-sm text-slate-500">WhatsApp sends business-started messages only with a template Meta has approved. Use the sample or change it.</p></div>
          <TemplateCard wa={wa} editable onSubmitted={onClose} />
          <div className="flex justify-start"><Button variant="ghost" onClick={() => setStep(2)}>Back</Button></div>
        </div>
      )}
    </Card>
  )
}

function StepConnect({ wa, onCancel, onNext }: { wa: Status; onCancel: () => void; onNext: () => void }) {
  const run = useAction()
  const c = wa.config
  const [f, setF] = useState({ businessNumber: c?.businessNumber ?? '', wabaId: c?.wabaId ?? '', phoneNumberId: c?.phoneNumberId ?? '', token: '' })
  const [show, setShow] = useState(false)
  const [help, setHelp] = useState(false)
  return (
    <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.admin.waConnect(f), 'Account details saved')) onNext() }}>
      <div><h3 className="text-lg font-semibold">Connect Kadai Kalanjiyam’s WhatsApp Business account</h3><p className="text-sm text-slate-500">Copy these from the Meta account that owns the Kadai Kalanjiyam number.</p></div>
      <div className="rounded-xl border border-slate-200 p-4 text-sm">
        <p className="mb-2 font-semibold">You’ll need</p>
        <ul className="space-y-1.5 text-slate-600">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />A verified Meta Business account for Kadai Kalanjiyam (business.facebook.com)</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />A mobile number for Kadai Kalanjiyam added to the WhatsApp Business Platform (API)</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />A payment method in Meta — Meta charges Kadai Kalanjiyam per reminder (utility message)</li>
        </ul>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider"><Select defaultValue="meta_cloud"><option value="meta_cloud">Meta WhatsApp Cloud API</option></Select></Field>
        <Field required label="WhatsApp Business number"><PhoneInput value={f.businessNumber} onChange={(v) => setF({ ...f, businessNumber: v })} /></Field>
        <Field required label="WhatsApp Business Account ID"><Input value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="font-mono" placeholder="104857362910473" /></Field>
        <Field required label="Phone number ID"><Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="font-mono" placeholder="110293847561029" /></Field>
      </div>
      <Field label="Permanent access token" hint={c?.tokenLast4 ? `A token ending in ${c.tokenLast4} is saved. Leave empty to keep it.` : 'Stored encrypted on the server. It’s never shown again after saving.'}>
        <div className="relative">
          <Input type={show ? 'text' : 'password'} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} className="pr-10 font-mono" autoComplete="off" spellCheck={false} placeholder={c?.tokenLast4 ? `•••• ${c.tokenLast4}` : 'EAAG…'} />
          <button type="button" onClick={() => setShow(!show)} aria-label="Show token" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
        </div>
      </Field>
      <button type="button" onClick={() => setHelp(!help)} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600"><BookOpen className="h-4 w-4" />Where do I find these?</button>
      {help && (
        <ol className="list-decimal space-y-1 rounded-xl bg-slate-50 py-3 pl-8 pr-4 text-sm text-slate-600">
          <li>Open <b>business.facebook.com</b> → <b>WhatsApp Manager</b>. Add the number if it isn’t there.</li>
          <li><b>WhatsApp Business Account ID</b>: Business settings → Accounts → WhatsApp accounts.</li>
          <li><b>Phone number ID</b>: WhatsApp Manager → Phone numbers → the number → API setup.</li>
          <li><b>Access token</b>: Business settings → Users → System users → Generate token (permission: whatsapp_business_messaging).</li>
        </ol>
      )}
      <div className="flex justify-between gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Not now</Button><Button type="submit">Save and test</Button></div>
    </form>
  )
}

function StepTest({ wa, onBack, onNext }: { wa: Status; onBack: () => void; onNext: () => void }) {
  const run = useAction()
  const v = wa.config?.verified
  const [testing, setTesting] = useState(false)
  return (
    <div className="space-y-4">
      <div><h3 className="text-lg font-semibold">Test the connection</h3><p className="text-sm text-slate-500">We check the details with Meta and can send a test message to any mobile.</p></div>
      {v ? <VerifiedCard v={v} /> : <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">Not tested yet</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={v ? 'secondary' : 'primary'} icon={Plug} write={false} onClick={() => run(() => api.admin.waTest(), 'Connection works')}>{v ? 'Test again' : 'Test connection'}</Button>
        {v && <Button variant="secondary" icon={Send} write={false} onClick={() => setTesting(true)}>Send test message</Button>}
      </div>
      <DemoNote />
      <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onBack}>Back</Button><Button onClick={onNext} disabled={!v}>Next: template</Button></div>
      {testing && <SendTestModal onClose={() => setTesting(false)} />}
    </div>
  )
}

const VerifiedCard = ({ v }: { v: NonNullable<NonNullable<Status['config']>['verified']> }) => (
  <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
    <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" />
    <div><p className="font-semibold">Connected as {v.name}</p><p className="text-sm text-slate-600">{formatPhone(v.number)} · Quality: {v.quality} · checked {fmtDateTime(v.at)}</p></div>
  </div>
)

function SendTestModal({ onClose }: { onClose: () => void }) {
  const run = useAction()
  const [to, setTo] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title="Send a test message"
      footer={<><Button variant="ghost" write={false} onClick={onClose}>Cancel</Button><Button icon={Send} write={false} disabled={!to} onClick={async () => { if (await run(() => api.admin.waSendTest(to), 'Test message sent')) onClose() }}>Send</Button></>}>
      <Field required label="Mobile number" hint="“Test message from Kadai Kalanjiyam. WhatsApp works.” goes to this number."><PhoneInput value={to} onChange={setTo} autoFocus /></Field>
    </Modal>
  )
}

const T_STATUS = { draft: { label: 'Draft', tone: 'slate' }, pending: { label: 'Pending with Meta', tone: 'amber' }, approved: { label: 'Approved', tone: 'green' }, rejected: { label: 'Rejected', tone: 'red' } } as const

/** The renewal reminder template: edit, check against Meta's rules, preview, submit for approval. */
function TemplateCard({ wa, editable, onSubmitted }: { wa: Status; editable: boolean; onSubmitted?: () => void }) {
  const run = useAction()
  const t = wa.config?.template ?? null
  const [lang, setLang] = useState<Lang>(t?.language ?? 'en')
  const [body, setBody] = useState(wa.template)
  const [editing, setEditing] = useState(editable && (!t || t.status === 'draft' || t.status === 'rejected'))
  const ref = useRef<HTMLTextAreaElement>(null)
  const errs = reminderTemplateErrors(body.trim())
  const checks = [
    { ok: !errs.includes('too short') && !errs.includes('keep it under 600 characters'), text: `${body.length} / 600 characters` },
    { ok: !errs.some((e) => e.startsWith('unknown field')), text: 'Only the fields listed above' },
    { ok: !errs.includes('can’t start or end with a field'), text: 'Doesn’t start or end with a field (Meta rule)' },
    { ok: !errs.includes('two fields can’t be side by side'), text: 'No two fields side by side (Meta rule)' },
    { ok: !errs.includes('include the end date or days left'), text: 'Mentions the end date or days left' },
  ]
  const status = t?.status
  const switchLang = (l: Lang) => { if (body.trim() === REMINDER_SAMPLE[lang]) setBody(REMINDER_SAMPLE[l]); setLang(l) }
  const insert = (f: string) => {
    const el = ref.current, tok = `{${f}}`
    if (!el) { setBody((b) => `${b} ${tok}`); return }
    const a = el.selectionStart, z = el.selectionEnd
    setBody(body.slice(0, a) + tok + body.slice(z))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length) })
  }
  const save = (submit: boolean) => run(async () => { await api.admin.waSaveTemplate({ language: lang, body }, submit); if (submit) { setEditing(false); onSubmitted?.() } }, submit ? 'Sent to Meta for approval' : 'Draft saved')
  const preview = body.replaceAll('{owner}', 'Lakshmi').replaceAll('{business}', 'FreshMart Supermarket').replaceAll('{date}', new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }))
    .replaceAll('{days}', daysText(3, body)).replaceAll('{amount}', '₹998').replaceAll('{support}', '+91 90000 12345')

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0 flex-1"><p className="font-semibold">Renewal reminder</p><p className="text-xs text-slate-500">Utility message · sent every day from {wa.daysBefore} days before a plan ends</p></div>
        {status ? <Badge tone={T_STATUS[status].tone}>{T_STATUS[status].label}</Badge> : <Badge>Not submitted</Badge>}
        {editable && !editing && <Button size="sm" variant="secondary" icon={Pencil} write={false} onClick={() => setEditing(true)}>Edit</Button>}
      </div>
      {status === 'rejected' && t?.reason && <p className="mx-4 mt-3 flex gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />Meta: {t.reason}</p>}
      {status === 'pending' && !editing && <p className="mx-4 mt-3 flex gap-1.5 text-xs text-amber-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />Meta usually reviews in a few minutes, sometimes up to 48 hours. Reminders start once it’s approved. This page updates by itself.</p>}
      {editing && status === 'approved' && <p className="mx-4 mt-3 flex gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />A changed template goes back to Meta for approval. Reminders pause until it’s approved again.</p>}
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-3">
          {editing ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented size="sm" value={lang} onChange={switchLang} options={[{ value: 'en', label: 'English' }, { value: 'ta', label: 'தமிழ்' }]} />
                <button type="button" onClick={() => setBody(REMINDER_SAMPLE[lang])} className="text-xs text-brand-600 hover:underline">Back to sample</button>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">Insert</p>
                <div className="flex flex-wrap gap-1.5">
                  {REMINDER_FIELDS.map((f) => <button key={f} type="button" onClick={() => insert(f)} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"><Plus className="h-3 w-3" />{REMINDER_FIELD_LABEL[f]}</button>)}
                </div>
              </div>
              <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} rows={5} aria-label="Message"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-relaxed shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/10" />
              <ul className="space-y-0.5 text-xs">
                {checks.map((c) => <li key={c.text} className={clsx('flex items-start gap-1.5', c.ok ? 'text-emerald-700' : 'text-red-600')}>{c.ok ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />}{c.text}</li>)}
              </ul>
            </>
          ) : <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed" data-no-i18n><Highlighted body={body} /></div>}
        </div>
        <div className="rounded-xl bg-[#e5ddd5] p-3" data-no-i18n>
          <p className="mb-2 text-[11px] font-medium text-slate-600">Preview</p>
          <p className="ml-auto max-w-[260px] whitespace-pre-wrap break-words rounded-lg rounded-tr-none bg-[#dcf8c6] px-3 py-2 text-[12.5px] leading-snug text-slate-800 shadow-sm">{preview}</p>
        </div>
      </div>
      {editing && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3">
          {status && <Button variant="ghost" write={false} onClick={() => { setEditing(false); setBody(wa.template); setLang(t!.language) }}>Cancel</Button>}
          <Button variant="secondary" write={false} onClick={() => save(false)}>Save draft</Button>
          <Button icon={Send} write={false} disabled={errs.length > 0} onClick={() => save(true)}>Submit to Meta</Button>
        </div>
      )}
    </Card>
  )
}

function Highlighted({ body }: { body: string }) {
  return <>{body.split(/(\{\w+\})/).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/)
    const label = m ? REMINDER_FIELD_LABEL[m[1] as keyof typeof REMINDER_FIELD_LABEL] : null
    return label ? <span key={i} className="rounded bg-brand-50 px-1 text-xs font-medium text-brand-700">{label}</span> : <span key={i}>{part}</span>
  })}</>
}

function Connected({ wa, onClose }: { wa: Status; onClose: () => void }) {
  const run = useAction()
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [testing, setTesting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const c = wa.config!
  if (edit) return <Wizard wa={{ ...wa, step: 1 }} onClose={() => setEdit(false)} />
  return (
    <div className="space-y-4">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {c.verified && <VerifiedCard v={c.verified} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Send} write={false} onClick={() => setTesting(true)}>Send test message</Button>
            <Button variant="secondary" icon={Pencil} write={false} onClick={() => setEdit(true)}>Edit connection</Button>
            <Button variant="ghost" icon={Unplug} write={false} onClick={() => setConfirm(true)} className="!text-red-600">Disconnect</Button>
          </div>
        </div>
        <div className="mt-4"><DemoNote /></div>
      </Card>
      <TemplateCard wa={wa} editable />
      <div className="flex justify-end"><Button variant="ghost" write={false} onClick={onClose}>Close</Button></div>
      {testing && <SendTestModal onClose={() => setTesting(false)} />}
      <Modal open={confirm} onClose={() => setConfirm(false)} size="sm" title="Disconnect WhatsApp?" subtitle="Renewal reminders stop until you connect again. The Meta account isn’t changed."
        footer={<><Button variant="ghost" write={false} onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" icon={Unplug} write={false} onClick={async () => { if (await run(() => api.admin.waDisconnect(), 'WhatsApp disconnected')) { setConfirm(false); onClose(); toast('You can connect again any time', 'info') } }}>Disconnect</Button></>}>
        <span />
      </Modal>
    </div>
  )
}

function RecentMessages({ wa }: { wa: Status }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="font-semibold">Recent reminders</h2>
        <span className="text-xs text-slate-500">{wa.sent7} sent in 7 days · <Link to="/admin/renewals" className="font-medium text-brand-700 hover:underline">Renewals</Link></span>
      </div>
      {!wa.log.length ? <p className="px-5 py-8 text-center text-sm text-slate-500">No reminders sent yet.</p> : (
        <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
          {wa.log.map((l) => (
            <li key={l.id} className="flex items-start gap-3 px-5 py-2.5">
              <Badge tone={l.trigger === 'auto' ? 'blue' : 'violet'}>{l.trigger === 'auto' ? 'Automatic' : 'Manual'}</Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{l.businessName} <span className="font-normal text-slate-500">· {l.to ? formatPhone(l.to) : 'no number'} · {l.daysLeft} day{l.daysLeft === 1 ? '' : 's'} left</span></p>
                <p className="truncate text-xs text-slate-500">{l.error ?? l.message}</p>
              </div>
              <span className="shrink-0 text-right text-xs"><span className={clsx('font-medium', l.status === 'sent' ? 'text-emerald-700' : 'text-red-600')}>{l.status === 'sent' ? '✓ Sent' : 'Failed'}</span><span className="block text-slate-400">{fmtDateTime(l.createdAt)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
