import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Check, FileUp, PackagePlus, PartyPopper, Pencil, Plus, ScanLine, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp, useData } from '@/app/AppContext'
import { Logo } from '@/app/Layout'
import { Button, Checkbox, Field, Input, Toggle, VegMark, useAction, useToast } from '@/components/ui'
import type { Product } from '@/core/types'
import { ProductForm } from './Products'
import { ScanAddModal } from '@/features/supermarket/ScanAdd'
import { ProductImportModal } from '@/features/ProductImport'
import { CategoryLabel, Thumb } from '@/components/Thumb'
import { priceLabel } from '@/features/Catalog'
import { DEFAULT_TERMS, defaultCategoriesFor, modulesShownFor, modulesFor, ORDER_TYPE_LABEL, TEMPLATES, TERM_LABELS, templateFor } from '@/core/config'
import type { BusinessCategory, ModuleConfig, OrderType, TermKey, Terminology } from '@/core/types'
import { api } from '@/data'
import { uid } from '@/lib/format'

type StepKey = 'business' | 'type' | 'features' | 'terms' | 'tables' | 'categories' | 'items' | 'finish'
const EDITABLE_TERMS: TermKey[] = ['product', 'customer', 'order', 'invoice', 'employee']

interface Cat { key: string; id?: string; name: string; emoji: string }
interface Area { id: string; floor: string; count: string; seats: string }

const startCats = (c: BusinessCategory, sub: string): Cat[] => defaultCategoriesFor(c, sub).map((x) => ({ ...x, key: uid('c') }))

export default function Onboarding() {
  const { me, refresh } = useApp()
  const nav = useNavigate()
  const run = useAction()
  const [key, setKey] = useState<StepKey>('business')
  const [name, setName] = useState(me?.business.name ?? '')
  // Start from what is already saved (the user may reload half-way through the setup).
  const saved = me?.business
  const [category, setCategory] = useState<BusinessCategory>(saved?.category ?? 'food')
  const [subType, setSubType] = useState(saved?.subType ?? 'Fast Food')
  const [modules, setModules] = useState<ModuleConfig>(saved?.modules ?? modulesFor('food'))
  const [orderTypes, setOrderTypes] = useState<OrderType[]>(saved?.billing.orderTypes ?? templateFor('food').orderTypes)
  const [terms, setTerms] = useState<Terminology>(saved?.terminology ?? { ...DEFAULT_TERMS, ...templateFor('food').terms })
  const [cats, setCats] = useState<Cat[]>(() => startCats(saved?.category ?? 'food', saved?.subType ?? 'Fast Food'))
  const [areas, setAreas] = useState<Area[]>([{ id: uid('a'), floor: 'Ground Floor', count: '', seats: '4' }])
  const [saving, setSaving] = useState(false)
  const { data: products = [] } = useData(() => api.products.list())

  // Categories saved earlier win over suggestions; a new business type brings fresh suggestions.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      api.categories.list().then((list) => { if (list.length) setCats(list.map((c) => ({ key: c.id, id: c.id, name: c.name, emoji: c.emoji }))) })
      return
    }
    setCats(startCats(category, subType))
  }, [category, subType])

  const pickCategory = (c: BusinessCategory) => {
    const tpl = templateFor(c)
    setCategory(c); setSubType(tpl.subTypes[0]); setModules(modulesFor(c)); setOrderTypes(tpl.orderTypes)
    setTerms({ ...DEFAULT_TERMS, ...tpl.terms })
  }

  const steps: { key: StepKey; label: string }[] = [
    { key: 'business', label: 'Business' }, { key: 'type', label: 'Type' }, { key: 'features', label: 'Features' }, { key: 'terms', label: 'Terminology' },
    ...(modules.tables ? [{ key: 'tables' as const, label: terms.table.plural }] : []),
    { key: 'categories', label: terms.category.plural }, { key: 'items', label: terms.product.plural }, { key: 'finish', label: 'Finish' },
  ]
  const idx = Math.max(0, steps.findIndex((s) => s.key === key))
  const move = (d: number) => setKey(steps[Math.min(steps.length - 1, Math.max(0, idx + d))].key)
  const validCats = cats.filter((c) => c.name.trim())

  // Leaving Categories: save the setup so the real item form (with these categories) can be used.
  const go = async (d: number) => {
    if (d > 0 && key === 'categories') {
      setSaving(true)
      let ids: (string | null)[] = []
      const ok = await run(async () => {
        ids = (await api.business.saveSetup({
          name: name.trim(), category, subType, modules, terminology: terms, orderTypes, categories: validCats,
          tables: modules.tables ? areas.map((a) => ({ floor: a.floor, count: Number(a.count) || 0, seats: Number(a.seats) || 4 })) : [],
        })).categoryIds
      })
      setSaving(false)
      if (!ok) return
      setCats(validCats.map((c, i) => ({ ...c, id: ids[i] ?? c.id })))
      await refresh()
    }
    // Back from items: pick up categories created from inside the item form, so a re-save keeps them.
    if (d < 0 && key === 'items') {
      const list = await api.categories.list()
      setCats(list.map((c) => ({ key: c.id, id: c.id, name: c.name, emoji: c.emoji })))
    }
    move(d)
  }

  const tableCount = areas.reduce((a, x) => a + (Math.floor(Number(x.count)) || 0), 0)
  const canNext = key === 'business' ? name.trim().length > 1
    : key === 'categories' ? validCats.length > 0
      : key === 'tables' ? areas.every((a) => a.floor.trim() && Number(a.count) >= 1) && tableCount <= 200
        : true

  const finish = async (goTo: string) => {
    const ok = await run(() => api.business.finishOnboarding())
    if (ok) { await refresh(); nav(goTo, { replace: true }) }
  }

  const tpl = templateFor(category)
  const isFood = category === 'food' || category === 'restaurant'

  return (
    <div className="min-h-[100dvh] bg-slate-50">
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-5"><Logo light={false} /><span className="text-xs text-slate-500">Step {idx + 1} of {steps.length}</span></header>
      <div className={clsx('mx-auto px-4 py-8', key === 'items' ? 'max-w-5xl' : 'max-w-3xl')}>
        {/* Stepper */}
        <ol className="mb-8 flex items-center">
          {steps.map((s, i) => (
            <li key={s.key} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center gap-1.5">
                <span className={clsx('flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition',
                  i < idx ? 'bg-brand-600 text-white' : i === idx ? 'bg-brand-600 text-white ring-4 ring-brand-100' : 'bg-white text-slate-400 ring-1 ring-slate-200')}>
                  {i < idx ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className={clsx('hidden text-[11px] font-medium sm:block', i <= idx ? 'text-brand-700' : 'text-slate-400')}>{s.label}</span>
              </div>
              {i < steps.length - 1 && <div className={clsx('mx-2 h-0.5 flex-1 rounded sm:mb-5', i < idx ? 'bg-brand-600' : 'bg-slate-200')} />}
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          {key === 'business' && (
            <>
              <h2 className="text-xl font-semibold">What’s your business called?</h2>
              <p className="mt-1 text-sm text-slate-500">This appears on your bills and dashboard. You can change it later.</p>
              <Field label="Business name" className="mt-6"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sri Murugan Bakery" className="h-12 text-base" /></Field>
            </>
          )}

          {key === 'type' && (
            <>
              <h2 className="text-xl font-semibold">What type of business do you run?</h2>
              <p className="mt-1 text-sm text-slate-500">Choose a type to get started. You can always change features later.</p>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {TEMPLATES.map((t) => (
                  <button key={t.category} onClick={() => pickCategory(t.category)}
                    className={clsx('relative flex flex-col items-center rounded-xl border-2 p-4 text-center transition',
                      category === t.category ? 'border-brand-600 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300')}>
                    {category === t.category && <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><Check className="h-3 w-3" /></span>}
                    <span className="text-3xl">{t.emoji}</span>
                    <span className="mt-2 text-sm font-semibold">{t.name}</span>
                    <span className="mt-1 text-[11px] leading-snug text-slate-500">{t.examples}</span>
                  </button>
                ))}
              </div>
              <p className="mb-2 mt-6 text-xs font-medium text-slate-600">More specifically…</p>
              <div className="flex flex-wrap gap-2">
                {tpl.subTypes.map((s) => (
                  <button key={s} onClick={() => setSubType(s)} className={clsx('rounded-full border px-3 py-1.5 text-sm transition', subType === s ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 hover:border-slate-300')}>{s}</button>
                ))}
              </div>
            </>
          )}

          {key === 'features' && (
            <>
              <h2 className="text-xl font-semibold">Pick the features you need</h2>
              <p className="mt-1 text-sm text-slate-500">We’ve switched on what a {subType.toLowerCase()} usually needs. Turn on more any time from Settings.</p>
              <div className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {modulesShownFor({ category, subType }).map((m) => (
                  <div key={m.key} className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{m.name} {m.core && <span className="ml-1 text-[11px] text-slate-400">Always on</span>}{m.comingSoon && <span className="ml-1 rounded bg-amber-50 px-1.5 text-[11px] font-medium text-amber-700">Coming soon</span>}</p>
                      <p className="text-xs text-slate-500">{m.description}</p>
                    </div>
                    <Toggle checked={modules[m.key]} disabled={m.core || m.comingSoon} onChange={(v) => setModules({ ...modules, [m.key]: v })} label={m.name} />
                  </div>
                ))}
              </div>
              {isFood && (
                <div className="mt-5">
                  <p className="mb-2 text-xs font-medium text-slate-600">Order types you serve</p>
                  <div className="flex flex-wrap gap-4">
                    {(['counter', 'dine_in', 'takeaway', 'delivery'] as OrderType[]).map((o) => (
                      <Checkbox key={o} checked={orderTypes.includes(o)} label={ORDER_TYPE_LABEL[o]}
                        onChange={(v) => setOrderTypes(v ? [...orderTypes, o] : orderTypes.filter((x) => x !== o).length ? orderTypes.filter((x) => x !== o) : orderTypes)} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {key === 'terms' && (
            <>
              <h2 className="text-xl font-semibold">Use your own words</h2>
              <p className="mt-1 text-sm text-slate-500">Rename things to match how your team talks. These names appear across the whole app.</p>
              <div className="mt-6 space-y-3">
                <div className="hidden grid-cols-[120px_1fr_1fr] gap-3 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 sm:grid"><span>Default</span><span>Singular</span><span>Plural</span></div>
                {EDITABLE_TERMS.map((k) => (
                  <div key={k} className="grid grid-cols-2 items-center gap-3 sm:grid-cols-[120px_1fr_1fr]">
                    <span className="col-span-2 text-sm font-medium text-slate-700 sm:col-span-1">{TERM_LABELS[k]}</span>
                    <Input value={terms[k].singular} onChange={(e) => setTerms({ ...terms, [k]: { ...terms[k], singular: e.target.value } })} />
                    <Input value={terms[k].plural} onChange={(e) => setTerms({ ...terms, [k]: { ...terms[k], plural: e.target.value } })} />
                  </div>
                ))}
              </div>
            </>
          )}

          {key === 'tables' && <TablesStep areas={areas} setAreas={setAreas} total={tableCount} label={terms.table} />}
          {key === 'categories' && <CategoriesStep cats={cats} setCats={setCats} subType={subType} label={terms.category} />}
          {key === 'items' && <ItemsStep products={products} retail={category === 'retail'} label={terms.product} />}

          {key === 'finish' && (
            <div className="py-6 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><PartyPopper className="h-8 w-8" /></div>
              <h2 className="mt-4 text-xl font-semibold">{name} is ready!</h2>
              <div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-2 text-sm">
                <span className="rounded-full bg-slate-100 px-3 py-1">{validCats.length} {terms.category.plural.toLowerCase()}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1">{products.length} {terms.product.plural.toLowerCase()}</span>
                {modules.tables && <span className="rounded-full bg-slate-100 px-3 py-1">{tableCount} {terms.table.plural.toLowerCase()}</span>}
              </div>
              <p className="mx-auto mt-3 max-w-md text-sm text-slate-500">Create your first {terms.invoice.singular.toLowerCase()} now, or look around the dashboard first.</p>
              <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                <Button size="lg" onClick={() => finish('/billing')}>Create first {terms.invoice.singular.toLowerCase()}</Button>
                <Button size="lg" variant="secondary" onClick={() => finish('/dashboard')}>Go to dashboard</Button>
              </div>
            </div>
          )}

          {key !== 'finish' && (
            <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
              <Button variant="ghost" icon={ArrowLeft} onClick={() => go(-1)} disabled={idx === 0}>Back</Button>
              <div className="flex gap-2">
                {['features', 'terms'].includes(key) && <Button variant="ghost" onClick={() => go(1)}>Skip</Button>}
                {key === 'items' && !products.length && <Button variant="ghost" onClick={() => go(1)}>Skip</Button>}
                <Button onClick={() => go(1)} disabled={!canNext || saving}>{saving ? 'Saving…' : 'Next'} <ArrowRight className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- Tables ----------

function TablesStep({ areas, setAreas, total, label }: { areas: Area[]; setAreas: (a: Area[]) => void; total: number; label: { singular: string; plural: string } }) {
  const set = (id: string, patch: Partial<Area>) => setAreas(areas.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  let n = 0
  const preview = areas.map((a) => { const c = Math.min(200, Math.floor(Number(a.count)) || 0); const from = n + 1; n += c; return { a, from, c } })
  return (
    <>
      <h2 className="text-xl font-semibold">How many {label.plural.toLowerCase()} do you have?</h2>
      <p className="mt-1 text-sm text-slate-500">Enter the number of {label.plural.toLowerCase()} in each floor or area. They are numbered T1, T2… You can rename, add or remove them later in Settings → Tables.</p>
      <div className="mt-6 space-y-3">
        <div className="hidden grid-cols-[1fr_140px_140px_36px] gap-3 px-1 text-xs font-medium text-slate-600 sm:grid"><span>Floor / area</span><span>No. of {label.plural.toLowerCase()}</span><span>Seats each</span><span /></div>
        {areas.map((a, i) => (
          <div key={a.id} className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_140px_140px_36px] sm:border-0 sm:p-0">
            <Input aria-label="Floor / area" className="col-span-2 sm:col-span-1" value={a.floor} onChange={(e) => set(a.id, { floor: e.target.value })} placeholder="e.g. Ground Floor, AC Hall" />
            <Input aria-label={`No. of ${label.plural.toLowerCase()}`} autoFocus={i === 0} type="number" inputMode="numeric" min={1} value={a.count} onChange={(e) => set(a.id, { count: e.target.value })} placeholder="e.g. 10" />
            <Input aria-label="Seats each" type="number" inputMode="numeric" min={1} value={a.seats} onChange={(e) => set(a.id, { seats: e.target.value })} />
            {areas.length > 1
              ? <button type="button" aria-label="Remove area" onClick={() => setAreas(areas.filter((x) => x.id !== a.id))} className="col-span-2 flex items-center justify-center text-slate-400 hover:text-red-600 sm:col-span-1"><Trash2 className="h-4 w-4" /></button>
              : <span className="hidden sm:block" />}
          </div>
        ))}
        <Button size="sm" variant="soft" icon={Plus} onClick={() => setAreas([...areas, { id: uid('a'), floor: '', count: '', seats: '4' }])}>Add another area</Button>
      </div>
      {total > 0 && (
        <div className="mt-6 rounded-xl bg-slate-50 p-4">
          <p className="mb-3 text-sm font-medium">{total} {(total === 1 ? label.singular : label.plural).toLowerCase()} will be created</p>
          <div className="space-y-2.5">
            {preview.filter((p) => p.c > 0).map(({ a, from, c }) => (
              <div key={a.id}>
                <p className="mb-1 text-xs text-slate-500">{a.floor || 'Main'} · {a.seats || 4} seats each</p>
                <div className="flex flex-wrap gap-1.5" data-no-i18n>
                  {Array.from({ length: Math.min(c, 30) }, (_, i) => <span key={i} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold">T{from + i}</span>)}
                  {c > 30 && <span className="px-1 py-1 text-xs text-slate-500">… T{from + c - 1}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {total > 200 && <p className="mt-2 text-sm text-red-600">Up to 200 tables can be added here — add more later in Settings → Tables.</p>}
    </>
  )
}

// ---------- Categories ----------

function CategoriesStep({ cats, setCats, subType, label }: { cats: Cat[]; setCats: (c: Cat[]) => void; subType: string; label: { singular: string; plural: string } }) {
  const [draft, setDraft] = useState('')
  const toast = useToast()
  const add = () => {
    const n = draft.trim()
    if (!n) return
    if (cats.some((c) => c.name.trim().toLowerCase() === n.toLowerCase())) { toast(`${n} is already in the list`, 'error'); return }
    setCats([...cats, { key: uid('c'), name: n, emoji: '⭐' }]); setDraft('')
  }
  return (
    <>
      <h2 className="text-xl font-semibold">Create your {label.plural.toLowerCase()}</h2>
      <p className="mt-1 text-sm text-slate-500">We’ve suggested {label.plural.toLowerCase()} for a {subType.toLowerCase()}. Remove what you don’t sell, rename any, or add your own.</p>
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {cats.map((c) => (
          <div key={c.key} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-1.5 pl-2">
            <input aria-label="Icon" value={c.emoji} maxLength={4} onChange={(e) => setCats(cats.map((x) => (x.key === c.key ? { ...x, emoji: e.target.value } : x)))}
              className="h-9 w-10 rounded-lg border-0 bg-slate-50 p-0 text-center text-lg focus:ring-2 focus:ring-brand-500/30" />
            <input aria-label={`${label.singular} name`} value={c.name} onChange={(e) => setCats(cats.map((x) => (x.key === c.key ? { ...x, name: e.target.value } : x)))}
              className={clsx('h-9 min-w-0 flex-1 rounded-lg border-0 px-2 text-sm font-medium focus:bg-slate-50 focus:ring-0', !c.name.trim() && 'bg-red-50')} placeholder={`${label.singular} name`} />
            <button type="button" aria-label={`Remove ${c.name}`} onClick={() => setCats(cats.filter((x) => x.key !== c.key))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`New ${label.singular.toLowerCase()} name`} className="flex-1" />
        <Button type="submit" variant="secondary" icon={Plus} disabled={!draft.trim()}>Add</Button>
      </form>
      <p className="mt-3 text-xs text-slate-500">{cats.filter((c) => c.name.trim()).length} {label.plural.toLowerCase()} · at least one is needed. Photos can be added later.</p>
    </>
  )
}

// ---------- Items ----------

/** Same Add item form as the Products page — every field (photo, sizes, add-ons, tax, stock, barcode…). */
function ItemsStep({ products, retail, label }: { products: Product[]; retail: boolean; label: { singular: string; plural: string } }) {
  const [editing, setEditing] = useState<Partial<Product> | null>(null)
  const [scan, setScan] = useState(false)
  const [importing, setImporting] = useState(false)
  const { data: categories = [] } = useData(() => api.categories.list())
  const catOf = (id: string | null) => categories.find((c) => c.id === id)
  return (
    <>
      <h2 className="text-xl font-semibold">Add your {label.plural.toLowerCase()}</h2>
      <p className="mt-1 text-sm text-slate-500">Each one is saved as soon as you add it. You can add more, or edit them, any time later in {label.plural}.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {retail && <Button icon={ScanLine} onClick={() => setScan(true)}>Scan to add</Button>}
        <Button variant={retail ? 'secondary' : 'primary'} icon={retail ? Pencil : Plus} onClick={() => setEditing({})}>{retail ? 'Add manually' : `Add ${label.singular.toLowerCase()}`}</Button>
        <Button variant="secondary" icon={FileUp} write onClick={() => setImporting(true)}>Import from CSV</Button>
      </div>

      {products.length ? (
        <ul className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {products.map((p) => {
            const c = catOf(p.categoryId)
            return (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <Thumb item={p} className="h-10 w-10 shrink-0 rounded-lg bg-slate-50 text-lg" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">{!retail && p.kind !== 'service' && <VegMark veg={p.isVeg} />}{p.name}</p>
                  <p className="truncate text-xs text-slate-500">{c ? <CategoryLabel c={c} /> : 'No category'}{p.barcode && <> · <span className="font-mono">{p.barcode}</span></>}{p.trackStock && <> · stock {p.stock}</>}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular">{priceLabel(p)}</span>
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`} title="Edit" />
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="mt-5 flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center">
          <PackagePlus className="h-7 w-7 text-slate-300" />
          <p className="text-sm text-slate-500">No {label.plural.toLowerCase()} yet. {retail ? 'Scan a packet or add one manually.' : `Add your first ${label.singular.toLowerCase()} — or skip and add them later.`}</p>
        </div>
      )}
      {products.length > 0 && <p className={clsx('mt-2 text-right text-sm text-slate-500')}>{products.length} {(products.length === 1 ? label.singular : label.plural).toLowerCase()} added</p>}

      {editing && <ProductForm initial={editing} onClose={() => setEditing(null)} />}
      {importing && <ProductImportModal onClose={() => setImporting(false)} />}
      {scan && <ScanAddModal onClose={() => setScan(false)} onEdit={(p) => { setScan(false); setEditing(p) }} />}
    </>
  )
}
