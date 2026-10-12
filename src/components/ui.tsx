import clsx from 'clsx'
import {
  ArrowRightLeft, Check, ChefHat, Combine, FolderPlus, IndianRupee, PackagePlus, Pause, Pencil, Play, Plus, ReceiptText, Search, SlidersHorizontal, Store, Trash2, Truck, Undo2, UserPlus, Wand2, X, XCircle,
  type LucideIcon,
} from 'lucide-react'
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'soft'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-300',
  secondary: 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-sm',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-300',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm disabled:bg-emerald-300',
  soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
}

// ---------- Read-only mode ----------

/** Set (to the reason) when the account can't be changed: subscription expired, or a support view. */
export const ReadOnlyContext = createContext<string | null>(null)
export const useReadOnly = () => useContext(ReadOnlyContext)

// Icons and labels that mean "this changes data". `write` on a Button overrides the guess.
const WRITE_ICONS = new Set<LucideIcon>([Plus, Pencil, Trash2, UserPlus, PackagePlus, SlidersHorizontal, Combine, ArrowRightLeft, ChefHat, XCircle, Undo2, ReceiptText, IndianRupee, Truck, Wand2, Store, FolderPlus, Pause, Play, Check])
const WRITE_TEXT = /^(Save|Collect|Pay\b|Accept|Reject|Mark |Start |Send|Add|New |Create|Delete|Remove|Record|Hold|Merge|Transfer|Move|Generate|Update|Settle|Void|Write off|Cancel order|Delivered|Picked up|Reset|Copy previous|Make poster|Refresh poster|Place order|Close order|Confirm|Apply|Resume|Order more)/
const firstText = (c: ReactNode): string => (typeof c === 'string' ? c : Array.isArray(c) ? firstText(c.find((x) => typeof x === 'string' || Array.isArray(x)) ?? '') : '')
const looksLikeWrite = (icon: LucideIcon | undefined, children: ReactNode) => (!!icon && WRITE_ICONS.has(icon)) || WRITE_TEXT.test(firstText(children).trim())

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant; size?: Size; icon?: LucideIcon; block?: boolean
  /** Changes data → disabled in read-only mode. Guessed from the icon / label when not given. */
  write?: boolean
}>(function Button({ variant = 'primary', size = 'md', icon: Icon, block, className, children, write, disabled, title, ...rest }, ref) {
  const readOnly = useContext(ReadOnlyContext)
  const locked = !!readOnly && (write ?? looksLikeWrite(Icon, children))
  return (
    <button
      ref={ref}
      disabled={disabled || locked}
      title={locked ? readOnly! : title}
      aria-disabled={locked || undefined}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed select-none whitespace-nowrap',
        variants[variant], sizes[size], block && 'w-full', className,
      )}
      {...rest}
    >
      {Icon && <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />}
      {children}
    </button>
  )
})

export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button aria-label={label} title={label} className={clsx('inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors', className)} {...rest}>
      <Icon className="h-[18px] w-[18px]" />
    </button>
  )
}

// ---------- Form controls ----------

const fieldBase = 'w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/10 disabled:bg-slate-50'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(fieldBase, 'h-10', className)} {...rest} />
})

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(fieldBase, 'py-2 min-h-[72px]', className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(fieldBase, 'h-10 pr-8', className)} {...rest}>{children}</select>
}

export function Field({ label, hint, error, children, className }: { label?: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      {label && <span className="mb-1.5 block text-xs font-medium text-slate-600">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  )
}

export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { kbd?: string }>(function SearchInput({ className, kbd, ...rest }, ref) {
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input ref={ref} className={clsx(fieldBase, 'h-10 pl-9', kbd && 'pr-12')} {...rest} />
      {kbd && <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{kbd}</kbd>}
    </div>
  )
})

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand-600' : 'bg-slate-300')}
    >
      <span className={clsx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
      {label}
    </label>
  )
}

/** Pill tabs, as in the sample UI (Today / Yesterday / This Week...). */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, block }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: 'sm' | 'md'; className?: string; block?: boolean
}) {
  return (
    <div className={clsx('max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 no-scrollbar', block ? 'flex w-full' : 'inline-flex', className)}>
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)}
          className={clsx('inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition', block && 'flex-1',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.value ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-900')}
        >
          {o.label}
          {o.count !== undefined && <span className={clsx('rounded-full px-1.5 text-[10px] font-semibold', value === o.value ? 'bg-brand-100 text-brand-700' : 'bg-slate-200 text-slate-600')}>{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Horizontal category chips (scrollable on mobile). */
export function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
      {options.map((o) => (
        <button
          key={o.value} type="button" onClick={() => onChange(o.value)}
          className={clsx('shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition',
            value === o.value ? 'border-brand-600 bg-brand-600 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300')}
        >{o.label}</button>
      ))}
    </div>
  )
}

// ---------- Layout ----------

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('rounded-xl border border-slate-200/80 bg-white shadow-card', className)} {...rest}>{children}</div>
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start justify-between gap-3 px-5 pt-4', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

const tones = {
  slate: 'bg-slate-100 text-slate-700',
  blue: 'bg-brand-50 text-brand-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  violet: 'bg-violet-50 text-violet-700',
  orange: 'bg-orange-50 text-orange-700',
}
export type Tone = keyof typeof tones

export function Badge({ tone = 'slate', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function VegMark({ veg }: { veg: boolean }) {
  return (
    <span title={veg ? 'Veg' : 'Non-veg'} className={clsx('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', veg ? 'border-emerald-600' : 'border-red-600')}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', veg ? 'bg-emerald-600' : 'bg-red-600')} />
    </span>
  )
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400"><Icon className="h-6 w-6" /></div>
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-slate-100', className)} />
}

export function Spinner() {
  return <div className="flex h-full min-h-[40vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-[3px] border-brand-200 border-t-brand-600" /></div>
}

// ---------- Overlays ----------

/** Backdrop click handler that ignores clicks right after opening (protects against double-clicks). */
function useBackdropClose(open: boolean, onClose: () => void) {
  const [openedAt, setOpenedAt] = useState(0)
  useEffect(() => { if (open) setOpenedAt(Date.now()) }, [open])
  return () => { if (Date.now() - openedAt > 400) onClose() }
}

function useEsc(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  useEsc(open, onClose)
  const backdrop = useBackdropClose(open, onClose)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] animate-fade" onClick={backdrop} />
      <div className={clsx('relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-pop animate-pop sm:rounded-2xl',
        { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size])}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2 -mt-1" />
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-md' }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string
}) {
  useEsc(open, onClose)
  const backdrop = useBackdropClose(open, onClose)
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40 animate-fade" onClick={backdrop} />
      <div className={clsx('relative flex h-full w-full flex-col bg-white shadow-pop animate-slide', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2 -mt-1" />
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------- Toasts ----------

type Toast = { id: number; tone: 'success' | 'error' | 'info'; text: string }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x, { id, tone, text }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 3200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-4">
          {items.map((t) => (
            <div key={t.id} className={clsx('pointer-events-auto flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium shadow-pop animate-pop',
              t.tone === 'success' && 'bg-slate-900 text-white', t.tone === 'error' && 'bg-red-600 text-white', t.tone === 'info' && 'bg-brand-600 text-white')}>
              <span>{t.tone === 'success' ? '✓' : t.tone === 'error' ? '!' : 'i'}</span>{t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/** Wrap an async action: shows error toast on failure. Returns true on success. */
export function useAction() {
  const toast = useToast()
  return useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn()
      if (success) toast(success)
      return true
    } catch (e) {
      toast((e as Error).message || 'Something went wrong', 'error')
      return false
    }
  }, [toast])
}

// ---------- Table ----------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('overflow-x-auto', className)}><table className="w-full text-left text-sm">{children}</table></div>
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={clsx('whitespace-nowrap border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500', className)}>{children}</th>
}
export function Td({ children, className, ...rest }: { children?: ReactNode; className?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={clsx('border-b border-slate-100 px-4 py-3 align-middle text-slate-700', className)} {...rest}>{children}</td>
}

export function Stat({ label, value, sub, icon: Icon, tone = 'blue' }: { label: string; value: ReactNode; sub?: ReactNode; icon: LucideIcon; tone?: Tone }) {
  const iconTone: Record<Tone, string> = {
    blue: 'bg-brand-50 text-brand-600', green: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600',
    violet: 'bg-violet-50 text-violet-600', orange: 'bg-orange-50 text-orange-600', slate: 'bg-slate-100 text-slate-600',
  }
  return (
    <Card className="flex items-start gap-3 p-4">
      <div className={clsx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', iconTone[tone])}><Icon className="h-5 w-5" /></div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 truncate text-xl font-semibold tracking-tight text-slate-900">{value}</p>
        {sub && <div className="mt-1 text-xs">{sub}</div>}
      </div>
    </Card>
  )
}
