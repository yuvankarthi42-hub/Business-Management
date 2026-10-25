import clsx from 'clsx'
import { receiptsMoving, shownStatus } from '@/core/waReceipts'
import { recheckWhatsApp } from './useWhatsApp'
import {
  AlertTriangle, BookOpen, Check, CheckCircle2, ChevronRight, Circle, Eye, EyeOff, FileText, FlaskConical, Image as ImageIcon, Info,
  Lock, MessageCircle, Pencil, Plug, Plus, Send, Unplug, XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Badge, Button, Card, Field, Input, Modal, Segmented, Select, Toggle, useAction, useToast } from '@/components/ui'
import { PhoneInput } from '@/components/PhoneInput'
import { formatPhone } from '@/core/phone'
import type { WaMessage, WaTemplate } from '@/core/types'
import {
  BILL_STARTER, checkTemplate, OFFER_SAMPLE, renderTemplate, sampleValues, waCopyFor, WA_FIELDS, WA_KIND, type WaField, type WaLang, type WaTemplateKind,
} from '@/core/whatsapp'
import { api } from '@/data'
import { fmtTime } from '@/lib/format'
import { useWhatsApp, type WaStatus } from './useWhatsApp'

const STEPS = ['Enable', 'Connect account', 'Test', 'Templates'] as const

/** Settings → Integrations. Only shown when the product admin has released WhatsApp to this customer. */
export function IntegrationsSettings() {
  const wa = useWhatsApp(true)
  const [open, setOpen] = useState(false)
  if (!wa) return null
  const connected = wa.state === 'connected'
  return (
    <div className="space-y-4">
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">Integrations</h2>
        <p className="mb-5 text-sm text-slate-500">Connect other services to Kadai Kalanjiyam.</p>
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><MessageCircle className="h-6 w-6" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">WhatsApp Business</p>
              <p className="text-sm text-slate-500">Send bills and offers directly from your own WhatsApp Business number</p>
            </div>
            {connected ? <Badge tone="green" dot>Connected</Badge> : wa.state === 'incomplete' ? <Badge tone="amber">Setup incomplete · step {wa.step} of 4</Badge> : <Badge>Not set up</Badge>}
            {!open && <Button variant={connected ? 'secondary' : 'primary'} write={false} onClick={() => setOpen(true)}>{connected ? 'Manage' : wa.state === 'incomplete' ? 'Continue setup' : 'Set up'}</Button>}
          </div>
          {!connected && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
              {STEPS.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-1">
                  {wa.step > i + 1 ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <Circle className="h-3.5 w-3.5" />}{s}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>
      {open && (connected ? <Connected wa={wa} onClose={() => setOpen(false)} /> : <Wizard wa={wa} onClose={() => setOpen(false)} />)}
    </div>
  )
}

const DemoNote = () => (
  <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
    <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
    Demo mode: connection checks, Meta’s template approval and delivery are simulated until the server is connected. No real WhatsApp messages are sent.
  </p>
)

// ---------- Setup wizard ----------

function Wizard({ wa, onClose }: { wa: WaStatus; onClose: () => void }) {
  // Opens where the setup stopped; after that the user moves with Next / Back.
  const [step, setStep] = useState(Math.min(4, wa.step))
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
      {step === 1 && <StepEnable onNext={() => setStep(2)} onClose={onClose} />}
      {step === 2 && <StepConnect wa={wa} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
      {step === 3 && <StepTest wa={wa} onBack={() => setStep(2)} onNext={() => setStep(4)} />}
      {step === 4 && <StepTemplates wa={wa} onBack={() => setStep(3)} onDone={onClose} />}
    </Card>
  )
}

function StepEnable({ onNext, onClose }: { onNext: () => void; onClose: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const copy = waCopyFor(me!.business)
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Send bills and offers on WhatsApp</h3>
        <p className="text-sm text-slate-500">{copy.intro}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Benefit icon={FileText} title="Bills">{copy.bills}</Benefit>
        <Benefit icon={Send} title="Offers">{copy.offers}</Benefit>
        <Benefit icon={CheckCircle2} title="Delivery status">{copy.status}</Benefit>
      </div>
      <div className="rounded-xl border border-slate-200 p-4 text-sm">
        <p className="mb-2 font-semibold">You’ll need</p>
        <ul className="space-y-1.5 text-slate-600">
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />A Meta Business account (business.facebook.com), ideally verified</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Your mobile number added to the WhatsApp Business Platform (API)</li>
          <li className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />A payment method in Meta — Meta charges you per message. Kadai Kalanjiyam doesn’t charge for WhatsApp.</li>
        </ul>
        <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />A number moved to the API usually can’t be used in the normal WhatsApp app at the same time. Meta’s newer “coexistence” option may allow both — check in your Meta account when you add the number.</p>
      </div>
      <DemoNote />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Not now</Button>
        <Button onClick={async () => { if (await run(() => api.whatsapp.enable(), 'WhatsApp turned on')) onNext() }}>Turn on WhatsApp</Button>
      </div>
    </div>
  )
}
const Benefit = ({ icon: I, title, children }: { icon: typeof Send; title: string; children: ReactNode }) => (
  <div className="rounded-xl bg-slate-50 p-3"><I className="mb-1.5 h-5 w-5 text-emerald-600" /><p className="text-sm font-semibold">{title}</p><p className="text-xs text-slate-500">{children}</p></div>
)

function StepConnect({ wa, onBack, onNext }: { wa: WaStatus; onBack: () => void; onNext: () => void }) {
  const run = useAction()
  const { me } = useApp()
  const c = wa.config
  const [f, setF] = useState({ businessNumber: c?.businessNumber || me?.business.phone || '', wabaId: c?.wabaId ?? '', phoneNumberId: c?.phoneNumberId ?? '', token: '' })
  const [show, setShow] = useState(false)
  const [help, setHelp] = useState(false)
  return (
    <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.whatsapp.connect(f), 'Account details saved')) onNext() }}>
      <div><h3 className="text-lg font-semibold">Connect your WhatsApp Business account</h3><p className="text-sm text-slate-500">Copy these from your Meta account.</p></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select defaultValue="meta_cloud">
            <option value="meta_cloud">Meta WhatsApp Cloud API</option>
            <option disabled>Interakt, WATI, Gupshup — coming soon</option>
          </Select>
        </Field>
        <Field required label="WhatsApp Business number"><PhoneInput value={f.businessNumber} onChange={(v) => setF({ ...f, businessNumber: v })} defaultCountry={me?.business.defaultCountry} /></Field>
        <Field required label="WhatsApp Business Account ID"><Input value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="font-mono" placeholder="104857362910473" /></Field>
        <Field required label="Phone number ID"><Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" className="font-mono" placeholder="110293847561029" /></Field>
      </div>
      <Field label="Permanent access token" hint={c?.tokenLast4 ? `A token ending in ${c.tokenLast4} is saved. Leave empty to keep it.` : 'Stored encrypted on the server. It’s never shown again after saving.'}>
        <div className="relative">
          <Input type={show ? 'text' : 'password'} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} className="pr-10 font-mono" autoComplete="off" spellCheck={false} placeholder={c?.tokenLast4 ? `•••• ${c.tokenLast4}` : 'EAAG…'} />
          <button type="button" onClick={() => setShow(!show)} aria-label="Show token" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
        </div>
      </Field>
      <p className="flex items-center gap-1.5 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" />Only you (the owner) can see this page.</p>
      <button type="button" onClick={() => setHelp(!help)} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600"><BookOpen className="h-4 w-4" />Where do I find these?</button>
      {help && (
        <ol className="list-decimal space-y-1 rounded-xl bg-slate-50 py-3 pl-8 pr-4 text-sm text-slate-600">
          <li>Open <b>business.facebook.com</b> → <b>WhatsApp Manager</b>. Add your number if it isn’t there.</li>
          <li><b>WhatsApp Business Account ID</b>: Business settings → Accounts → WhatsApp accounts.</li>
          <li><b>Phone number ID</b>: WhatsApp Manager → Phone numbers → the number → API setup.</li>
          <li><b>Access token</b>: Business settings → Users → System users → Generate token (permission: whatsapp_business_messaging).</li>
        </ol>
      )}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
        <Button type="submit">Save and test</Button>
      </div>
    </form>
  )
}

function StepTest({ wa, onBack, onNext }: { wa: WaStatus; onBack: () => void; onNext: () => void }) {
  const run = useAction()
  const v = wa.config?.verified
  return (
    <div className="space-y-4">
      <div><h3 className="text-lg font-semibold">Test the connection</h3><p className="text-sm text-slate-500">We check the details with Meta and can send a test message to your mobile.</p></div>
      {v ? <VerifiedCard v={v} /> : <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">Not tested yet</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={v ? 'secondary' : 'primary'} icon={Plug} write={false} onClick={() => run(() => api.whatsapp.test(), 'Connection works')}>{v ? 'Test again' : 'Test connection'}</Button>
        {v && <Button variant="secondary" icon={Send} onClick={() => run(() => api.whatsapp.sendTest(), 'Test message sent to your mobile')}>Send test message</Button>}
      </div>
      <DemoNote />
      <div className="flex justify-between gap-2"><Button variant="ghost" onClick={onBack}>Back</Button><Button onClick={onNext} disabled={!v}>Next: templates</Button></div>
    </div>
  )
}
const VerifiedCard = ({ v }: { v: NonNullable<NonNullable<WaStatus['config']>['verified']> }) => (
  <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
    <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" />
    <div><p className="font-semibold">Connected as {v.name}</p><p className="text-sm text-slate-600">{formatPhone(v.number)} · Quality: {v.quality} · checked {fmtTime(v.at)}</p></div>
  </div>
)

function StepTemplates({ wa, onBack, onDone }: { wa: WaStatus; onBack: () => void; onDone: () => void }) {
  const run = useAction()
  const t = wa.config?.templates ?? {}
  const submitted = Object.values(t).some((x) => x && x.status !== 'draft')
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Message templates</h3>
        <p className="text-sm text-slate-500">WhatsApp only allows business messages that Meta has approved. Use our offer sample, and write your own bill message.</p>
      </div>
      <TemplateCard kind="offer" template={t.offer} />
      <TemplateCard kind="bill" template={t.bill} />
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button onClick={async () => { if (await run(() => api.whatsapp.finishSetup(), 'WhatsApp is set up')) onDone() }} disabled={!submitted}>Finish setup</Button>
      </div>
    </div>
  )
}

// ---------- Template card + editor ----------

const STATUS: Record<WaTemplate['status'], { label: string; tone: 'slate' | 'amber' | 'green' | 'red' }> = {
  draft: { label: 'Draft', tone: 'slate' }, pending: { label: 'Pending with Meta', tone: 'amber' }, approved: { label: 'Approved', tone: 'green' }, rejected: { label: 'Rejected', tone: 'red' },
}

function TemplateCard({ kind, template }: { kind: WaTemplateKind; template?: WaTemplate }) {
  const run = useAction()
  const k = WA_KIND[kind]
  const [lang, setLang] = useState<WaLang>(template?.language ?? 'ta')
  const starter = kind === 'offer' ? OFFER_SAMPLE : BILL_STARTER
  const [body, setBody] = useState(template?.body ?? starter[lang])
  const [attach, setAttach] = useState(template?.attach ?? true)
  // Offer starts as a read-only sample; bill opens straight in the editor.
  const [editing, setEditing] = useState(kind === 'bill' && (!template || template.status === 'draft' || template.status === 'rejected'))
  const ref = useRef<HTMLTextAreaElement>(null)
  const checks = checkTemplate(kind, body)
  const blocked = checks.some((c) => !c.ok && c.level === 'error')
  const status = template?.status

  const switchLang = (l: WaLang) => { if (body.trim() === starter[lang]) setBody(starter[l]); setLang(l) }
  const insert = (f: WaField) => {
    const el = ref.current
    const tok = `{{${f}}}`
    if (!el) { setBody((b) => `${b} ${tok}`); return }
    const a = el.selectionStart, z = el.selectionEnd
    const next = body.slice(0, a) + tok + body.slice(z)
    setBody(next)
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tok.length, a + tok.length) })
  }
  const save = (submit: boolean) => run(async () => { await api.whatsapp.saveTemplate(kind, { language: lang, body, attach }, submit); if (submit) setEditing(false) }, submit ? 'Sent to Meta for approval' : 'Draft saved')

  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
        {kind === 'offer' ? <ImageIcon className="h-5 w-5 text-slate-400" /> : <FileText className="h-5 w-5 text-slate-400" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{k.title}</p>
          <p className="text-xs text-slate-500">{kind === 'offer' ? 'Ready-made sample · marketing message' : 'Write your own · utility message'}</p>
        </div>
        {status ? <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge> : <Badge>Not submitted</Badge>}
        {!editing && status && <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
      </div>
      {status === 'rejected' && template?.reason && <p className="mx-4 mt-3 flex gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />Meta: {template.reason}</p>}
      {status === 'pending' && !editing && <p className="mx-4 mt-3 flex gap-1.5 text-xs text-amber-700"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />Meta usually reviews in a few minutes, sometimes up to 48 hours.<button type="button" onClick={recheckWhatsApp} className="ml-1 font-semibold underline">Check now</button></p>}

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-3">
          {editing ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented size="sm" value={lang} onChange={switchLang} options={[{ value: 'ta', label: 'தமிழ்' }, { value: 'en', label: 'English' }]} />
                <button type="button" onClick={() => setBody(starter[lang])} className="text-xs text-brand-600 hover:underline">{kind === 'offer' ? 'Back to sample' : 'Start again'}</button>
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-600">Insert</p>
                <div className="flex flex-wrap gap-1.5">
                  {k.fields.map((f) => <button key={f} type="button" onClick={() => insert(f)} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"><Plus className="h-3 w-3" />{WA_FIELDS[f].label}</button>)}
                </div>
              </div>
              <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} rows={4} aria-label="Message"
                className="w-full rounded-lg border-slate-200 text-sm leading-relaxed shadow-sm focus:border-brand-500 focus:ring-brand-500/10" />
              <div className="flex items-center gap-2 text-sm"><Toggle checked={attach} onChange={setAttach} label={k.attach} /><span>{k.attach}</span></div>
              <ul className="space-y-0.5 text-xs">
                {checks.map((c) => (
                  <li key={c.text} className={clsx('flex items-start gap-1.5', c.ok ? 'text-emerald-700' : c.level === 'error' ? 'text-red-600' : 'text-amber-700')}>
                    {c.ok ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" /> : c.level === 'error' ? <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />}{c.text}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed"><Highlighted body={body} /></div>
          )}
        </div>
        <Preview kind={kind} body={body} attach={attach} />
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3">
        {editing ? <>
          {status && <Button variant="ghost" write={false} onClick={() => { setEditing(false); setBody(template!.body); setLang(template!.language); setAttach(template!.attach) }}>Cancel</Button>}
          <Button variant="secondary" onClick={() => save(false)}>Save draft</Button>
          <Button icon={Send} disabled={blocked} onClick={() => save(true)}>Submit to Meta</Button>
        </> : !status ? <>
          <Button variant="secondary" icon={Pencil} write={false} onClick={() => setEditing(true)}>Edit text</Button>
          <Button icon={Send} disabled={blocked} onClick={() => save(true)}>Use this sample</Button>
        </> : null}
      </div>
    </div>
  )
}

/** Fields shown as chips inside the text. */
function Highlighted({ body }: { body: string }) {
  return <>{body.split(/(\{\{\w+\}\})/).map((part, i) => {
    const m = part.match(/^\{\{(\w+)\}\}$/)
    return m ? <span key={i} className="rounded bg-brand-50 px-1 text-xs font-medium text-brand-700">{WA_FIELDS[m[1] as WaField]?.label ?? m[1]}</span> : <span key={i}>{part}</span>
  })}</>
}

function Preview({ kind, body, attach }: { kind: WaTemplateKind; body: string; attach: boolean }) {
  const { me } = useApp()
  const b = me!.business
  const copy = waCopyFor(b)
  // Preview with this shop's own name and a believable offer / amount for its type of business.
  const values = { ...sampleValues(), shop_name: b.name, offer_details: copy.offerSample, amount: copy.billSample, bill_no: `${b.billing.invoicePrefix ?? ''}${b.billing.nextInvoiceNumber ?? 1001}` }
  return (
    <div className="rounded-xl bg-[#e5ddd5] p-3" data-no-i18n>
      <p className="mb-2 text-[11px] font-medium text-slate-600">Preview</p>
      <div className="ml-auto max-w-[240px] overflow-hidden rounded-lg rounded-tr-none bg-[#dcf8c6] shadow-sm">
        {attach && (kind === 'offer'
          ? <div className="flex h-20 items-center justify-center bg-amber-100 text-xs font-medium text-amber-800"><ImageIcon className="mr-1 h-4 w-4" />Offer poster</div>
          : <div className="m-1.5 flex items-center gap-2 rounded bg-white/80 px-2 py-1.5 text-xs"><FileText className="h-5 w-5 text-red-500" /><span className="flex-1">{values.bill_no}.pdf</span><span className="text-slate-500">PDF</span></div>)}
        <p className="whitespace-pre-wrap break-words px-2.5 py-2 text-[12.5px] leading-snug text-slate-800">{renderTemplate(body, values)}</p>
        <p className="px-2.5 pb-1.5 text-right text-[10px] text-slate-500">{fmtTime(new Date())}</p>
      </div>
    </div>
  )
}

// ---------- Connected: manage + message log ----------

function Connected({ wa, onClose }: { wa: WaStatus; onClose: () => void }) {
  const run = useAction()
  const toast = useToast()
  const c = wa.config!
  const [edit, setEdit] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const { data: messages = [] } = useData(() => api.whatsapp.messages(100), [wa])
  if (edit) return <Wizard wa={{ ...wa, step: 2 }} onClose={() => setEdit(false)} />
  return (
    <div className="space-y-4">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {c.verified && <VerifiedCard v={c.verified} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Send} onClick={() => run(() => api.whatsapp.sendTest(), 'Test message sent to your mobile')}>Send test message</Button>
            <Button variant="secondary" icon={Pencil} write={false} onClick={() => setEdit(true)}>Edit connection</Button>
            <Button variant="ghost" icon={Unplug} write onClick={() => setConfirm(true)} className="!text-red-600">Disconnect</Button>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Send bill automatically after payment</p>
            <p className="text-xs text-slate-500">{wa.ready.bill ? 'Customers with a mobile number get their bill on WhatsApp the moment you collect payment.' : 'Available once the bill template is approved.'}</p>
          </div>
          <Toggle checked={c.autoSendBill && wa.ready.bill} disabled={!wa.ready.bill} onChange={(v) => run(() => api.whatsapp.setAutoSendBill(v), v ? 'Bills will be sent automatically' : 'Auto-send off')} label="Auto-send bill" />
        </div>
        <div className="mt-4"><DemoNote /></div>
      </Card>

      <Card className="space-y-4 p-5 sm:p-6">
        <h3 className="font-semibold">Message templates</h3>
        <TemplateCard kind="offer" template={c.templates.offer} />
        <TemplateCard kind="bill" template={c.templates.bill} />
      </Card>

      <Card>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3"><h3 className="font-semibold">Messages</h3><span className="text-xs text-slate-500">Last {messages.length}</span></div>
        {messages.length ? (
          <ul className="divide-y divide-slate-100">
            {messages.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-5 py-2.5">
                <Badge tone={m.kind === 'offer' ? 'violet' : m.kind === 'bill' ? 'blue' : 'slate'}>{m.kind === 'offer' ? 'Offer' : m.kind === 'bill' ? 'Bill' : 'Test'}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{m.customerName || formatPhone(m.to)} <span className="font-normal text-slate-500">· {formatPhone(m.to)}</span></p>
                  <p className="truncate text-xs text-slate-500">{m.attachment && <span className="mr-1">📎 {m.attachment} ·</span>}{m.body}</p>
                </div>
                <span className="shrink-0 text-right text-xs">
                  <MsgStatusOf m={m} />
                  <span className="block text-slate-400">{fmtTime(m.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 py-8 text-center text-sm text-slate-500">No messages yet.</p>}
      </Card>
      <div className="flex justify-end"><Button variant="ghost" write={false} onClick={onClose}>Close</Button></div>

      <Modal open={confirm} onClose={() => setConfirm(false)} size="sm" title="Disconnect WhatsApp?" subtitle="WhatsApp buttons disappear and saved templates are removed here. Your Meta account isn’t changed."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" icon={Unplug} write onClick={async () => { if (await run(() => api.whatsapp.disconnect(), 'WhatsApp disconnected')) { setConfirm(false); onClose(); toast('You can connect again any time', 'info') } }}>Disconnect</Button></>}>
        <span />
      </Modal>
    </div>
  )
}

/** A message's tick, moved on the screen while its simulated receipt changes (no server calls). */
export function MsgStatusOf({ m }: { m: WaMessage }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!receiptsMoving([m], now)) return
    const id = setTimeout(() => setNow(Date.now()), 1000)
    return () => clearTimeout(id)
  }, [m, now])
  return <MsgStatus s={shownStatus(m, now)} />
}

export function MsgStatus({ s }: { s: 'sent' | 'delivered' | 'read' | 'failed' }) {
  return <span className={clsx('font-medium', s === 'read' ? 'text-sky-600' : s === 'delivered' ? 'text-emerald-700' : s === 'failed' ? 'text-red-600' : 'text-slate-500')}>{s === 'read' ? '✓✓ Read' : s === 'delivered' ? '✓✓ Delivered' : s === 'failed' ? 'Failed' : '✓ Sent'}</span>
}
