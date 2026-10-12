import { KeyRound, Pencil, Plus, Power, UserCog, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { useData } from '@/app/AppContext'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Table, Td, Th, useAction } from '@/components/ui'
import { ADMIN_ROLES } from '@/core/adminRoles'
import type { AdminRole } from '@/core/types'
import { api } from '@/data'
import { fmtDateTime, randomPassword, useAdmin } from './shared'

type Member = Awaited<ReturnType<typeof api.admin.team>>[number]
const ROLE_TONE: Record<AdminRole, 'violet' | 'blue' | 'slate'> = { super: 'violet', manager: 'blue', support: 'slate' }

/** Product admin team: who can manage customers, and how much. */
export default function AdminTeam() {
  const me = useAdmin()
  const run = useAction()
  const { data: team = [], error } = useData(() => api.admin.team())
  const [edit, setEdit] = useState<Partial<Member> | null>(null)
  if (error) return <EmptyState icon={UserCog} title="Only super admins can manage the team" />
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Admin team</h1>
          <p className="text-sm text-slate-500">People who manage BillPoodum customers. Each role decides what they can do.</p>
        </div>
        <Button icon={Plus} onClick={() => setEdit({ role: 'support' })}>Add admin</Button>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-3">
        {(Object.keys(ADMIN_ROLES) as AdminRole[]).map((r) => (
          <div key={r} className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
            <div className="flex items-center justify-between"><Badge tone={ROLE_TONE[r]}>{ADMIN_ROLES[r].name}</Badge><span className="text-xs text-slate-500">{team.filter((m) => m.role === r && m.active).length} active</span></div>
            <p className="mt-2 text-sm text-slate-600">{ADMIN_ROLES[r].description}</p>
          </div>
        ))}
      </div>

      <Card>
        <Table>
          <thead><tr><Th>Name</Th><Th>Username</Th><Th>Role</Th><Th>Status</Th><Th>Last login</Th><Th /></tr></thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.id}>
                <Td className="font-medium">{m.name}{m.id === me.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</Td>
                <Td className="font-mono text-sm">{m.username}</Td>
                <Td><Badge tone={ROLE_TONE[m.role]}>{ADMIN_ROLES[m.role].name}</Badge></Td>
                <Td>{m.active ? <Badge tone="green" dot>Active</Badge> : <Badge dot>Deactivated</Badge>}</Td>
                <Td className="text-sm text-slate-600">{m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : 'Never'}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEdit(m)}>Edit</Button>
                  {m.id !== me.id && <Button size="sm" variant="ghost" icon={Power} className={m.active ? '!text-amber-700' : '!text-emerald-700'}
                    onClick={() => run(() => api.admin.setAdminActive(m.id, !m.active), m.active ? `${m.name} deactivated` : `${m.name} activated`)}>{m.active ? 'Deactivate' : 'Activate'}</Button>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {edit && <AdminModal initial={edit} self={edit.id === me.id} onClose={() => setEdit(null)} />}
    </div>
  )
}

function AdminModal({ initial, self, onClose }: { initial: Partial<Member>; self: boolean; onClose: () => void }) {
  const run = useAction()
  const isNew = !initial.id
  const [f, setF] = useState({ name: initial.name ?? '', username: initial.username ?? '', role: (initial.role ?? 'support') as AdminRole, password: isNew ? randomPassword() : '' })
  const [resetPw, setResetPw] = useState(isNew)
  const [done, setDone] = useState<string | null>(null)
  if (done) {
    return (
      <Modal open onClose={onClose} size="sm" title={isNew ? 'Admin added' : 'Password reset'} subtitle="Share these sign-in details privately. The password is shown only now.">
        <dl className="grid grid-cols-[90px_1fr] gap-y-1.5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm" data-no-i18n>
          <dt className="text-slate-500">Sign in at</dt><dd className="font-medium">{location.origin}/admin/login</dd>
          <dt className="text-slate-500">Username</dt><dd className="font-mono font-semibold">{f.username}</dd>
          <dt className="text-slate-500">Password</dt><dd className="font-mono font-semibold">{done}</dd>
        </dl>
        <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add admin' : `Edit ${initial.name}`}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault()
        const ok = await run(() => api.admin.saveAdmin({ id: initial.id, name: f.name, username: f.username, role: f.role, password: resetPw ? f.password : undefined }), isNew ? 'Admin added' : 'Saved')
        if (ok) { if (resetPw) setDone(f.password); else onClose() }
      }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input autoFocus required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Arun" /></Field>
          <Field label="Username"><Input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') })} className="font-mono" autoCapitalize="none" spellCheck={false} /></Field>
        </div>
        <Field label="Role">
          <div className="space-y-2">
            {(Object.keys(ADMIN_ROLES) as AdminRole[]).map((r) => (
              <label key={r} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${f.role === r ? 'border-brand-500 bg-brand-50/40' : 'border-slate-200'} ${self ? 'cursor-not-allowed opacity-60' : ''}`}>
                <input type="radio" name="role" className="mt-0.5" checked={f.role === r} disabled={self} onChange={() => setF({ ...f, role: r })} />
                <span><span className="block text-sm font-semibold">{ADMIN_ROLES[r].name}</span><span className="block text-xs text-slate-500">{ADMIN_ROLES[r].description}</span></span>
              </label>
            ))}
            {self && <p className="text-xs text-slate-500">You can’t change your own role.</p>}
          </div>
        </Field>
        {!isNew && !resetPw && <Button type="button" variant="secondary" size="sm" icon={KeyRound} write={false} onClick={() => { setResetPw(true); setF({ ...f, password: randomPassword() }) }}>Reset password</Button>}
        {resetPw && (
          <Field label={isNew ? 'Password' : 'New password'} hint="At least 6 characters">
            <div className="flex gap-1.5">
              <Input required minLength={6} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="font-mono" autoComplete="new-password" />
              <Button type="button" variant="secondary" icon={Wand2} onClick={() => setF({ ...f, password: randomPassword() })} aria-label="New password" title="Generate" />
            </div>
          </Field>
        )}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">{isNew ? 'Add admin' : 'Save'}</Button></div>
      </form>
    </Modal>
  )
}
