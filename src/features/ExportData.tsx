import { FileArchive, FileSpreadsheet } from 'lucide-react'
import { useState } from 'react'
import { Button, useToast } from '@/components/ui'
import type { ExportBundle } from '@/data'
import { downloadExport } from '@/lib/exportFiles'

const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Download everything a business has: Excel (a sheet per table) or ZIP (CSV files + product photos). */
export function ExportButtons({ load, size: btn = 'md' }: { load: () => Promise<ExportBundle>; size?: 'sm' | 'md' }) {
  const toast = useToast()
  const [busy, setBusy] = useState<'xlsx' | 'zip' | null>(null)
  const go = async (f: 'xlsx' | 'zip') => {
    setBusy(f)
    try {
      const bundle = await load()
      const bytes = await downloadExport(bundle, f)
      toast(`Downloaded ${bundle.tables.length} tables · ${bundle.tables.reduce((a, t) => a + t.rows.length, 0).toLocaleString('en-IN')} rows${f === 'zip' ? ` · ${bundle.images.length} photos` : ''} · ${size(bytes)}`)
    } catch (e) { toast((e as Error).message || 'Export failed', 'error') } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size={btn} variant="secondary" icon={FileSpreadsheet} write={false} disabled={!!busy} onClick={() => go('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : 'Excel (.xlsx)'}</Button>
      <Button size={btn} variant="secondary" icon={FileArchive} write={false} disabled={!!busy} onClick={() => go('zip')}>{busy === 'zip' ? 'Preparing…' : 'ZIP (CSV + photos)'}</Button>
    </div>
  )
}
