import { AlertCircle, Barcode, Check, PackagePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { useApp, useData } from '@/app/AppContext'
import { Button, Input, Modal, useAction } from '@/components/ui'
import type { Product } from '@/core/types'
import { api } from '@/data'
import { money } from '@/lib/format'
import { QuickAddForm } from './QuickAdd'

type Row = { code: string; status: 'added' | 'exists' | 'stocked'; product: Product; qty?: number }

/** Products → Scan to add: scan packet after packet. New codes open a short form; known ones offer "Add stock". */
export function ScanAddModal({ onClose, onEdit }: { onClose: () => void; onEdit: (p: Product) => void }) {
  const { mod } = useApp()
  const run = useAction()
  const { data: products = [] } = useData(() => api.products.list())
  const [code, setCode] = useState('')
  const [pending, setPending] = useState<string | null>(null) // new barcode being filled in
  const [rows, setRows] = useState<Row[]>([])
  const [stockQty, setStockQty] = useState<Record<string, string>>({})
  const ref = useRef<HTMLInputElement>(null)
  const refocus = () => setTimeout(() => ref.current?.focus(), 30)

  const scan = () => {
    const c = code.trim()
    setCode('')
    if (!c) return
    const p = products.find((x) => x.barcode === c)
    if (p) { setRows((r) => [{ code: c, status: 'exists', product: p }, ...r.filter((x) => x.code !== c)]); return }
    setPending(c)
  }
  const addStock = async (row: Row) => {
    const n = Number(stockQty[row.code])
    if (!(n > 0)) return
    if (await run(() => api.inventory.adjust(row.product.id, 'purchase', n, 'Stock in (scan)'), `${row.product.name} +${n}`)) {
      setRows((r) => r.map((x) => (x.code === row.code ? { ...x, status: 'stocked', qty: n } : x)))
      setStockQty(({ [row.code]: _, ...rest }) => rest)
      refocus()
    }
  }

  return (
    <Modal open onClose={onClose} size="lg" title="Scan to add products" subtitle="Keep scanning — one product after another. New barcodes ask for name and price.">
      <div className="space-y-4">
        {!pending ? (
          <form onSubmit={(e) => { e.preventDefault(); scan() }} className="relative">
            <Barcode className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-brand-600" />
            <input ref={ref} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan next product…"
              className="h-12 w-full rounded-xl border-2 border-brand-300 pl-11 font-mono text-base focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10" />
          </form>
        ) : (
          <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
            <p className="mb-3 text-sm font-semibold">New product</p>
            <QuickAddForm compact barcode={pending} onCancel={() => { setPending(null); refocus() }}
              onSaved={(p) => { setRows((r) => [{ code: pending, status: 'added', product: p }, ...r]); setPending(null); refocus() }} />
          </div>
        )}

        {rows.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.map((row) => (
              <li key={row.code} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                {row.status === 'exists' ? <AlertCircle className="h-4 w-4 text-amber-500" /> : <Check className="h-4 w-4 text-emerald-600" />}
                <span className="font-mono text-xs text-slate-500">{row.code}</span>
                <button onClick={() => onEdit(row.product)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">{row.product.name}</button>
                <span className="text-slate-500">{money(row.product.price)}</span>
                {row.status === 'added' && <span className="text-xs font-medium text-emerald-700">Added</span>}
                {row.status === 'stocked' && <span className="text-xs font-medium text-emerald-700">+{row.qty} stock added</span>}
                {row.status === 'exists' && mod('inventory') && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs text-amber-700">Already exists · {row.product.stock} in stock</span>
                    <Input value={stockQty[row.code] ?? ''} onChange={(e) => setStockQty({ ...stockQty, [row.code]: e.target.value.replace(/[^\d.]/g, '') })} placeholder="Qty" className="h-8 w-16 text-xs"
                      onKeyDown={(e) => { if (e.key === 'Enter') addStock(row) }} />
                    <Button size="sm" variant="soft" icon={PackagePlus} onClick={() => addStock(row)}>Add stock</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {!rows.length && !pending && <p className="text-center text-xs text-slate-400">Tip: a USB / Bluetooth barcode scanner types the code and presses Enter for you.</p>}
      </div>
    </Modal>
  )
}
