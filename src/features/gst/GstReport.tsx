// Reports → GST: one month's GSTR-1 tables and GSTR-3B summary, with an Excel download for the auditor.
import clsx from 'clsx'
import { AlertTriangle, ChevronLeft, ChevronRight, FileSpreadsheet } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Card, CardHeader, Skeleton, Table, Td, Th, useToast } from '@/components/ui'
import { gstSheets, stateLabel, type GstReport as Report } from '@/core/gst'
import { api } from '@/data'
import { fmtDate, money } from '@/lib/format'
import { buildXlsx } from '@/lib/exportFiles'

const thisMonth = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 7)
const shift = (m: string, by: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return d.toISOString().slice(0, 7) }
const label = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
const m2 = (n: number) => money(n, { decimals: true })

export function GstReportView() {
  const { me } = useApp()
  const toast = useToast()
  const [month, setMonth] = useState(thisMonth())
  const { data: r } = useData(() => api.reports.gst(month), [month])
  const [busy, setBusy] = useState(false)
  const download = async () => {
    if (!r) return
    setBusy(true)
    try {
      const blob = await buildXlsx({ tables: gstSheets(r) } as unknown as Parameters<typeof buildXlsx>[0])
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `GST-${month}-${(me?.business.gstin || me?.business.name || 'shop').replace(/[^A-Za-z0-9]+/g, '-')}.xlsx`
      a.click()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
          <button type="button" aria-label="Previous month" className="rounded p-1.5 hover:bg-slate-100" onClick={() => setMonth(shift(month, -1))}><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-[9rem] text-center text-sm font-medium">{label(month)}</span>
          <button type="button" aria-label="Next month" disabled={month >= thisMonth()} className="rounded p-1.5 hover:bg-slate-100 disabled:opacity-30" onClick={() => setMonth(shift(month, 1))}><ChevronRight className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center gap-2">
          {me?.business.gstin && <span className="text-xs text-slate-500">GSTIN <span className="font-mono">{me.business.gstin}</span>{r?.shopState ? ` · ${stateLabel(r.shopState)}` : ''}</span>}
          <Button variant="secondary" icon={FileSpreadsheet} disabled={!r || busy} onClick={download}>{busy ? 'Preparing…' : 'Download Excel for GST filing'}</Button>
        </div>
      </div>
      {!r ? <Skeleton className="h-96" /> : <Body r={r} />}
      <p className="text-xs text-slate-500">These figures are worked out from your bills, returns and purchase bills. Check them with your auditor before filing — set-off rules and late adjustments are done on the GST portal.</p>
    </div>
  )
}

function Body({ r }: { r: Report }) {
  const s = r.summary
  return (
    <>
      {!!r.warnings.length && (
        <div className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {r.warnings.map((w) => <p key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}</p>)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile k="Taxable sales (after returns)" v={money(s.net.taxable)} />
        <Tile k="Output GST" v={money(s.outputTax)} sub={`IGST ${m2(s.net.igst)} · CGST ${m2(s.net.cgst)} · SGST ${m2(s.net.sgst)}`} />
        <Tile k="Input GST (purchases)" v={money(s.inputTax)} sub={`${r.purchases.length} purchase bill${r.purchases.length === 1 ? '' : 's'}`} />
        <Tile k={s.payableTotal > 0 ? 'GST to pay' : 'Credit carried forward'} v={money(s.payableTotal > 0 ? s.payableTotal : s.carryForward)} tone={s.payableTotal > 0 ? 'red' : 'green'} />
      </div>

      <Section title="B2B — bills to business customers (GSTIN)" count={new Set(r.b2b.map((x) => x.invoiceNumber)).size}>
        {r.b2b.length ? (
          <Table>
            <thead><tr><Th>Bill</Th><Th>Customer</Th><Th className="hidden md:table-cell">Place of supply</Th><Th className="text-right">Rate</Th><Th className="text-right">Taxable</Th><Th className="text-right">GST</Th></tr></thead>
            <tbody>{r.b2b.map((x, k) => (
              <tr key={k}><Td><p className="font-medium">{x.invoiceNumber}</p><p className="text-xs text-slate-500">{fmtDate(x.date)}</p></Td><Td><p>{x.customer}</p><p className="font-mono text-[11px] text-slate-500">{x.gstin}</p></Td><Td className="hidden text-slate-500 md:table-cell">{stateLabel(x.placeOfSupply)}</Td><Td className="text-right tabular">{x.rate}%</Td><Td className="text-right tabular">{m2(x.taxable)}</Td><Td className="text-right tabular">{x.igst ? <>{m2(x.igst)} <span className="text-[10px] text-violet-600">IGST</span></> : m2(x.cgst + x.sgst)}</Td></tr>
            ))}</tbody>
          </Table>
        ) : <Empty>No bills to customers with a GSTIN this month.</Empty>}
      </Section>

      {!!r.b2cl.length && (
        <Section title="B2C large — other-state walk-in bills above ₹1 lakh" count={r.b2cl.length}>
          <Table>
            <thead><tr><Th>Bill</Th><Th>Place of supply</Th><Th className="text-right">Rate</Th><Th className="text-right">Taxable</Th><Th className="text-right">IGST</Th></tr></thead>
            <tbody>{r.b2cl.map((x, k) => <tr key={k}><Td>{x.invoiceNumber}</Td><Td>{stateLabel(x.placeOfSupply)}</Td><Td className="text-right">{x.rate}%</Td><Td className="text-right tabular">{m2(x.taxable)}</Td><Td className="text-right tabular">{m2(x.igst)}</Td></tr>)}</tbody>
          </Table>
        </Section>
      )}

      <Section title="B2C small — walk-in sales by rate (after walk-in returns)" count={r.b2cs.length}>
        {r.b2cs.length ? (
          <Table>
            <thead><tr><Th>Place of supply</Th><Th className="text-right">Rate</Th><Th className="text-right">Taxable</Th><Th className="text-right">CGST</Th><Th className="text-right">SGST</Th><Th className="text-right">IGST</Th></tr></thead>
            <tbody>{r.b2cs.map((x, k) => <tr key={k}><Td>{stateLabel(x.placeOfSupply) || '—'}</Td><Td className="text-right">{x.rate}%</Td><Td className="text-right tabular">{m2(x.taxable)}</Td><Td className="text-right tabular">{m2(x.cgst)}</Td><Td className="text-right tabular">{m2(x.sgst)}</Td><Td className="text-right tabular">{m2(x.igst)}</Td></tr>)}</tbody>
          </Table>
        ) : <Empty>No walk-in sales this month.</Empty>}
      </Section>

      <Section title="Credit notes — returns" count={r.cdn.length}>
        {r.cdn.length ? (
          <Table>
            <thead><tr><Th>Credit note</Th><Th>Against bill</Th><Th className="hidden md:table-cell">Customer</Th><Th className="text-right">Taxable</Th><Th className="text-right">GST</Th></tr></thead>
            <tbody>{r.cdn.map((x, k) => <tr key={k}><Td><p className="font-medium">{x.number}</p><p className="text-xs text-slate-500">{fmtDate(x.date)}{x.registered ? ' · B2B' : ''}</p></Td><Td>{x.invoiceNumber}</Td><Td className="hidden md:table-cell">{x.customer || 'Walk-in'}</Td><Td className="text-right tabular">{m2(x.taxable)}</Td><Td className="text-right tabular">{m2(x.igst + x.cgst + x.sgst)}</Td></tr>)}</tbody>
          </Table>
        ) : <Empty>No returns this month.</Empty>}
      </Section>

      <Section title="HSN summary (after returns)" count={r.hsn.length}>
        {r.hsn.length ? (
          <Table>
            <thead><tr><Th>HSN / SAC</Th><Th className="hidden md:table-cell">Item</Th><Th className="text-right">Qty</Th><Th className="text-right">Rate</Th><Th className="text-right">Taxable</Th><Th className="text-right">GST</Th></tr></thead>
            <tbody>{r.hsn.map((x, k) => <tr key={k}><Td className={clsx('font-mono', !x.hsn && 'text-amber-700')}>{x.hsn || 'missing'}</Td><Td className="hidden truncate md:table-cell">{x.name}</Td><Td className="text-right tabular">{x.qty} {x.uqc}</Td><Td className="text-right">{x.rate}%</Td><Td className="text-right tabular">{m2(x.taxable)}</Td><Td className="text-right tabular">{m2(x.igst + x.cgst + x.sgst)}</Td></tr>)}</tbody>
          </Table>
        ) : <Empty>No sales this month.</Empty>}
      </Section>

      <Section title="GSTR-3B summary">
        <div className="divide-y divide-slate-100 text-sm">
          <Line k="3.1(a) Outward taxable supplies" taxable={s.net.taxable} h={s.net} />
          <Line k="4(A) Input tax credit — purchase bills" taxable={s.input.taxable} h={s.input} />
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 font-semibold"><span>Tax to pay (before set-off rules)</span><span className="tabular">IGST {m2(s.payable.igst)} · CGST {m2(s.payable.cgst)} · SGST {m2(s.payable.sgst)}</span></div>
        </div>
      </Section>
      <p className="text-xs text-slate-500">Documents: bills {r.docs.from || '—'} to {r.docs.to || '—'} ({r.docs.count}) · {r.docs.creditNotes} credit note{r.docs.creditNotes === 1 ? '' : 's'}</p>
    </>
  )
}

const Tile = ({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: 'red' | 'green' }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">{k}</p><p className={clsx('mt-1 text-xl font-semibold tabular', tone === 'red' && 'text-red-600', tone === 'green' && 'text-emerald-700')}>{v}</p>{sub && <p className="mt-0.5 text-[11px] text-slate-400">{sub}</p>}</div>
)
const Section = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <Card><CardHeader title={<span>{title}{count !== undefined && <span className="ml-2 text-xs font-normal text-slate-400">{count}</span>}</span>} />{children}</Card>
)
const Empty = ({ children }: { children: ReactNode }) => <p className="px-4 py-6 text-center text-sm text-slate-400">{children}</p>
const Line = ({ k, taxable, h }: { k: string; taxable: number; h: { igst: number; cgst: number; sgst: number } }) => (
  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"><span>{k}</span><span className="tabular text-slate-600">Taxable {m2(taxable)} · IGST {m2(h.igst)} · CGST {m2(h.cgst)} · SGST {m2(h.sgst)}</span></div>
)
