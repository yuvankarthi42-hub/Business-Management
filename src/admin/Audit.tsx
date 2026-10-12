import { History } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '@/app/AppContext'
import { Badge, Card, Chips, EmptyState, SearchInput, Table, Td, Th } from '@/components/ui'
import { api } from '@/data'
import { fmtDateTime } from './shared'

const LABEL: Record<string, string> = { feature: 'Feature release', support_start: 'Support view', support_end: 'Support ended', admin_create: 'Admin added', admin_update: 'Admin changed', create: 'Account created', update: 'Details updated', password: 'Password reset', renew: 'Validity changed', branch_limit: 'Branch limit', activate: 'Activated', deactivate: 'Deactivated', delete: 'Deleted', settings: 'Pricing', login: 'Login' }
const TONE: Record<string, 'blue' | 'green' | 'amber' | 'red' | 'slate' | 'violet'> = { support_start: 'violet', admin_create: 'blue', create: 'blue', renew: 'green', activate: 'green', branch_limit: 'violet', deactivate: 'amber', delete: 'red' }

/** Every important product-admin action, newest first. */
export default function AdminAudit() {
  const { data: rows = [] } = useData(() => api.admin.audit(500))
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all')
  const list = useMemo(() => rows.filter((r) => (kind === 'all' || r.action === kind) && (!q || `${r.businessName} ${r.detail} ${r.adminName}`.toLowerCase().includes(q.toLowerCase()))), [rows, q, kind])
  return (
    <div>
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="mb-5 text-sm text-slate-500">Account creation, validity changes, branch limits, deactivation and deletion — kept even after a customer is deleted.</p>
      <Card>
        <div className="space-y-3 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer or detail" className="max-w-md" />
          <Chips value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, ...['create', 'renew', 'branch_limit', 'password', 'deactivate', 'activate', 'delete', 'update', 'support_start', 'admin_create', 'admin_update', 'feature', 'settings'].map((k) => ({ value: k, label: LABEL[k] }))]} />
        </div>
        {!list.length ? <EmptyState icon={History} title="No admin actions yet" /> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Action</Th><Th>Customer</Th><Th>Detail</Th><Th>By</Th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-sm text-slate-600">{fmtDateTime(r.at)}</Td>
                  <Td><Badge tone={TONE[r.action] ?? 'slate'}>{LABEL[r.action] ?? r.action}</Badge></Td>
                  <Td className="text-sm font-medium">{r.businessId && r.action !== 'delete' ? <Link to={`/admin/customers/${r.businessId}`} className="text-brand-700 hover:underline">{r.businessName || 'Customer'}</Link> : r.businessName || '—'}</Td>
                  <Td className="text-sm text-slate-700">{r.detail}</Td>
                  <Td className="whitespace-nowrap text-sm text-slate-500">{r.adminName}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
