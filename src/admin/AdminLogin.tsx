import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Logo } from '@/app/Layout'
import { Button, Field, Input } from '@/components/ui'
import { api, BACKEND } from '@/data'

/** Product admin sign-in — separate from customer logins. */
export default function AdminLogin() {
  const nav = useNavigate()
  const [u, setU] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-slate-900 px-4 py-10" data-no-i18n>
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-pop">
        <div className="mb-6 flex items-center justify-between"><Logo light={false} /><span className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white"><ShieldCheck className="h-3.5 w-3.5" />Admin</span></div>
        <h1 className="text-xl font-semibold">Product admin</h1>
        <p className="mt-1 text-sm text-slate-500">Manage customers, subscriptions and branch limits.</p>
        <form className="mt-6 space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError('')
          try { await api.admin.login(u, pw); nav('/admin', { replace: true }) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
        }}>
          <Field label="Admin username"><Input value={u} onChange={(e) => setU(e.target.value)} required autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
          <Field label="Password">
            <div className="relative">
              <Input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="current-password" className="pr-10" />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Toggle password">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            </div>
          </Field>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <Button type="submit" block size="lg" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</Button>
        </form>
        <p className="mt-5 text-center text-xs text-slate-400">{BACKEND === 'mock' && <>Demo admin is listed in <code>DEMO_ACCOUNTS.md</code> · </>}<Link to="/login" className="hover:underline">Shop sign-in</Link></p>
      </div>
    </div>
  )
}
