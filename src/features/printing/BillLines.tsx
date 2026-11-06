// A bill's lines on screen (and in the browser print dialog), laid out with the same column code as the
// thermal printer (rowLines), so the screen shows exactly what the paper will.
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { CHARS, type BillSection, type Line, type Paper } from './doc'
import { rowLines } from './escpos'

/** `active`: the part of the bill being edited in Settings → Bill design (shown highlighted). */
export function BillLines({ doc, paper, active }: { doc: Line[]; paper: Paper; active?: BillSection | null }) {
  const W = CHARS[paper]
  const narrow = paper === '58mm'
  return (
    <div data-no-i18n className={clsx('whitespace-pre font-mono leading-snug text-black', narrow ? 'text-[10px]' : 'text-[11px]')} style={{ width: `${W}ch`, maxWidth: '100%' }}>
      {doc.map((l, i) => {
        const lit = !!active && l.sec === active
        const box = (el: ReactNode) => (lit ? <div key={i} className="-mx-1 bg-amber-100 px-1">{el}</div> : el)
        if (l.k === 'hr') return box(<div key={i} className={l.strong ? 'my-1 border-t-2 border-black' : 'my-1 border-t border-dashed border-black'} />)
        if (l.k === 'feed') return box(<div key={i} style={{ height: `${l.n * 1.2}em` }} />)
        if (l.k === 'text') {
          return box(<div key={i} className={clsx(l.s.length > W ? 'whitespace-pre-wrap' : 'whitespace-pre', l.align === 'center' && 'text-center', l.align === 'right' && 'text-right', l.bold && 'font-bold', l.big && (narrow ? 'text-[13px]' : 'text-[15px]'), l.small && 'text-[0.85em]')}>{l.s}</div>)
        }
        return box(<div key={i}>{rowLines(l.cells, l.widths, l.big ? Math.floor(W / 2) : W).map((s, j) => (
          <div key={j} className={clsx(l.bold && 'font-bold', l.big && 'text-[1.7em] leading-tight')}>{s}</div>
        ))}</div>)
      })}
    </div>
  )
}
