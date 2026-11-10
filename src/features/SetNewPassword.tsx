// Shown instead of the app after Kadai Kalanjiyam support reset the owner's password: the owner sets their own new
// password before anything else (the server refuses every other action until then).
import { KeyRound, LogOut } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useApp } from '@/app/AppContext'
import { Button, Card, Field, Input, useToast } from '@/components/ui'
import { api } from '@/data'

export function SetNewPassword() {
  const { me, refresh } = useApp()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (!current) return setErr('Enter the password support gave you')
    if (next.length < 8) return setErr('Password must be at least 8 characters')
    if (next !== again) return setErr('The two new passwords are not the same')
    if (next === current) return setErr('Choose a password different from the one support gave you')
    setBusy(true)
    try {
      await api.auth.changePassword(current, next)
      toast('Password changed')
      await refresh()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Could not change the password')
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700"><KeyRound className="h-5 w-5" /></span>
          <div>
            <h1 className="text-lg font-semibold">Set a new password</h1>
            <p className="text-sm text-slate-500">{me?.business.name}</p>
          </div>
        </div>
        <p className="mb-5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Kadai Kalanjiyam support reset your password. Set your own new password to continue — only you will know it.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Password support gave you"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label="New password again"><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          {err && <p className="text-sm text-red-600" role="alert">{err}</p>}
          <Button type="submit" block disabled={busy}>Save new password</Button>
        </form>
        <button type="button" onClick={async () => { await api.auth.logout(); await refresh() }} className="mt-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700">
          <LogOut className="h-4 w-4" />Sign out
        </button>
      </Card>
    </div>
  )
}
