import clsx from 'clsx'
import { shopLogo } from '@/core/brand'

/** The shop's logo in a rounded square — the Kadai Kalanjiyam logo until the shop uploads its own. */
export function ShopLogo({ business, className }: { business: { logoUrl?: string | null; name?: string } | null | undefined; className?: string }) {
  const own = !!business?.logoUrl
  return (
    <span className={clsx('flex shrink-0 items-center justify-center overflow-hidden rounded-lg', own && 'bg-white ring-1 ring-slate-200', className ?? 'h-9 w-9')}>
      <img src={shopLogo(business)} alt={own ? `${business?.name ?? 'Shop'} logo` : 'Kadai Kalanjiyam'} className={clsx('h-full w-full', own ? 'object-contain p-0.5' : 'object-cover')} draggable={false} />
    </span>
  )
}
