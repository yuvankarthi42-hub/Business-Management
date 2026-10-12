import { ChefHat, Eye, EyeOff, Scissors, ShoppingCart, Store, UtensilsCrossed } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '@/app/AppContext'
import { Logo } from '@/app/Layout'
import { Button, Checkbox, Field, Input, useToast } from '@/components/ui'
import { api } from '@/data'
import { formatPhone, phoneError } from '@/core/phone'
import { PhoneInput } from '@/components/PhoneInput'
import { LanguageToggle } from '@/i18n/LanguagePicker'

const roleIcon: Record<string, string> = { Owner: '👑', Manager: '🧑‍💼', Cashier: '💳', Waiter: '🧑‍🍳', 'Kitchen Staff': '🍳' }

/** Customers sign in with the username and password the product admin gave them (no public sign-up). */
export default function Login() {
  const nav = useNavigate()
  const loc = useLocation()
  const toast = useToast()
  const { refresh } = useApp()
  const [id, setId] = useState('') // username (optional way in)
  const [mobile, setMobile] = useState('') // E.164 from the country-code picker
  const [withUsername, setWithUsername] = useState(false)
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const demo = api.auth.demoUsers()
  const [demoBiz, setDemoBiz] = useState<string | null>(null)
  const currentDemo = demo.find((g) => g.business.id === demoBiz) ?? demo[0]
  const fromSignup = (loc.state as { signup?: boolean } | null)?.signup

  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try {
      await fn()
      await refresh()
      nav((loc.state as { from?: string })?.from ?? '/', { replace: true })
    } catch (e) {
      setError((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="flex min-h-[100dvh] bg-white">
      {/* Brand panel */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-50 via-white to-orange-50 p-12 lg:flex">
        <Logo light={false} />
        <div className="max-w-md">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-900">One platform.<br />Every kind of business.</h1>
          <p className="mt-4 text-lg text-slate-600">Billing, orders, tables, kitchen, stock and daily income — set up the way <em>your</em> business works.</p>
          <div className="mt-10 grid grid-cols-4 gap-3">
            {[{ i: ShoppingCart, l: 'Retail' }, { i: ChefHat, l: 'Food' }, { i: UtensilsCrossed, l: 'Restaurant' }, { i: Scissors, l: 'Service' }].map(({ i: I, l }) => (
              <div key={l} className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-white/70 p-4 shadow-card">
                <I className="h-6 w-6 text-brand-600" /><span className="text-xs font-medium text-slate-700">{l}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-400">© {new Date().getFullYear()} BillPoodum · Simplify your business</p>
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-96 w-96 rounded-full bg-brand-100/60 blur-3xl" />
      </div>

      {/* Form */}
      <div className="flex w-full flex-col justify-center px-5 py-10 sm:px-10 lg:w-[520px] lg:shrink-0">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center justify-between lg:justify-end"><span className="lg:hidden"><Logo light={false} /></span><LanguageToggle /></div>
          <h2 className="text-2xl font-semibold tracking-tight">Welcome back!</h2>
          <p className="mt-1 text-sm text-slate-500">Sign in with the mobile number and password you received</p>
          {fromSignup && <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">New accounts are created by the BillPoodum team. Contact us to get your username and password.</p>}

          <form className="mt-7 space-y-4" noValidate onSubmit={(e) => {
            e.preventDefault()
            if (!withUsername) {
              if (!mobile) { setError('Enter your mobile number'); return }
              const bad = phoneError(mobile)
              if (bad) { setError(bad); return }
            } else if (!id.trim()) { setError('Enter your username'); return }
            if (!pw) { setError('Enter your password'); return }
            go(() => api.auth.login(withUsername ? id : mobile, pw))
          }}>
            {withUsername ? (
              <div>
                <Field label="Username"><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. srimurugan" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
                <button type="button" onClick={() => { setWithUsername(false); setError('') }} className="mt-1.5 text-xs font-medium text-brand-600 hover:underline">Use mobile number instead</button>
              </div>
            ) : (
              <div>
                <label htmlFor="login-mobile" className="mb-1.5 block text-xs font-medium text-slate-600">Mobile number</label>
                <PhoneInput id="login-mobile" value={mobile} onChange={(v) => { setMobile(v); setError('') }} autoFocus />
                <button type="button" onClick={() => { setWithUsername(true); setError('') }} className="mt-1.5 text-xs font-medium text-brand-600 hover:underline">Use username instead</button>
              </div>
            )}
            <Field label="Password">
              <div className="relative">
                <Input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Enter your password" autoComplete="current-password" className="pr-10" />
                <button type="button" onClick={() => setShow(!show)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Toggle password">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            <div className="flex items-center justify-between">
              <Checkbox checked={remember} onChange={setRemember} label="Remember me" />
              <button type="button" onClick={() => toast('Ask the BillPoodum team (product admin) to reset your password', 'info')} className="text-xs font-medium text-brand-600 hover:underline">Forgot password?</button>
            </div>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <Button type="submit" block size="lg" disabled={busy}>{busy ? 'Please wait…' : 'Sign in'}</Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">Don’t have an account? Contact the BillPoodum team — we’ll create your login.</p>

          {demo.length > 0 && (
            <div className="mt-8 rounded-xl border border-dashed border-slate-300 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Store className="h-4 w-4 text-slate-400" />
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Try a demo business</p>
              </div>
              <div className="mb-3 grid grid-cols-4 gap-1.5">
                {demo.map((g) => (
                  <button key={g.business.id} onClick={() => setDemoBiz(g.business.id)}
                    className={`rounded-lg border px-2 py-2 text-center transition ${g.business.id === currentDemo?.business.id ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                    <span className="block text-lg">{g.business.emoji}</span>
                    <span className="block truncate text-[11px] font-semibold">{g.business.subType}</span>
                  </button>
                ))}
              </div>
              {currentDemo && (
                <>
                  <p className="mb-2 truncate text-xs text-slate-500">{currentDemo.business.name}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {currentDemo.users.map((u) => (
                      <button
                        key={u.id} disabled={busy}
                        onClick={() => go(() => api.auth.demoLogin(u.id))}
                        className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50"
                      >
                        <span className="text-lg">{roleIcon[u.role] ?? '👤'}</span>
                        <span className="min-w-0 leading-tight">
                          <span className="block truncate text-sm font-medium text-slate-800">{u.name}</span>
                          <span className="block truncate text-[11px] text-slate-500">{u.role}{currentDemo.users.some((x) => x.branchId !== u.branchId) ? ` · ${u.branch}` : ''} · {formatPhone(u.phone)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="mt-3 text-[11px] text-slate-400">Demo logins and the shared demo password are listed in <code>DEMO_ACCOUNTS.md</code>.</p>
            </div>
          )}
          <p className="mt-6 text-center text-xs text-slate-400"><Link to="/admin/login" className="hover:text-slate-600 hover:underline">Product admin sign-in</Link></p>
        </div>
      </div>
    </div>
  )
}
