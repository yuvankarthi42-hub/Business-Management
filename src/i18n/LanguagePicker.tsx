import clsx from 'clsx'
import { Check, Languages } from 'lucide-react'
import { api } from '@/data'
import { LANGUAGES, setLanguage, useLanguage, type Lang } from '.'

/** Switch the app language. Saved for this device, and on the user's profile when signed in. */
export async function chooseLanguage(code: Lang, signedIn: boolean) {
  await setLanguage(code)
  if (signedIn) { try { await api.auth.setLanguage(code) } catch { /* device setting still applies */ } }
}

export function LanguageMenu({ signedIn = true }: { signedIn?: boolean }) {
  const lang = useLanguage()
  return (
    <div className="border-b border-slate-100 px-1.5 py-1.5" data-no-i18n>
      <p className="flex items-center gap-1.5 px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400"><Languages className="h-3.5 w-3.5" />Language · மொழி</p>
      {LANGUAGES.map((l) => (
        <button key={l.code} type="button" onClick={() => chooseLanguage(l.code, signedIn)}
          className={clsx('flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50', lang === l.code && 'font-semibold text-brand-700')}>
          <span>{l.native}{l.native !== l.name && <span className="ml-1.5 text-xs font-normal text-slate-400">{l.name}</span>}</span>
          {lang === l.code && <Check className="h-4 w-4" />}
        </button>
      ))}
    </div>
  )
}

/** Compact toggle for the sign-in screen. */
export function LanguageToggle({ className }: { className?: string }) {
  const lang = useLanguage()
  return (
    <div className={clsx('inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs font-medium', className)} data-no-i18n>
      {LANGUAGES.map((l) => (
        <button key={l.code} type="button" onClick={() => chooseLanguage(l.code, false)}
          className={clsx('rounded-md px-2.5 py-1', lang === l.code ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50')}>{l.native}</button>
      ))}
    </div>
  )
}
