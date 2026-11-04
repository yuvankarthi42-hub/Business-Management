// Live updates for public screens (QR menu, TV specials board, customer order tracking): the event hub tells
// them "menu changed" / "your order changed" — no names, phones or other data. Off when the server has no hub
// (Catalyst, and the demo app): then the screens check now and then by themselves (useCheckEvery).
import { useEffect, useRef, useState } from 'react'
import { api } from '@/data'

/** Returns true while the server has live updates for public screens (a hub); false = none (check on a timer). */
export function usePublicLive(shop: string | null | undefined, order: string | null, on: { menu?: () => void; order?: () => void }): boolean {
  const handlers = useRef(on)
  handlers.current = on
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!shop) return
    let stopped = false
    let ctl: AbortController | null = null
    let since: string | null = null
    let wait = 1000
    const run = async () => {
      let url: string | null = null
      try { url = (await api.public.live()).url } catch { /* no hub */ }
      if (!url || stopped) return
      setLive(true)
      const base = new URL(url, location.href).href.replace(/\/$/, '')
      while (!stopped) {
        ctl = new AbortController()
        try {
          const res = await fetch(`${base}/public`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ shop, order, since }), signal: ctl.signal, credentials: 'omit', cache: 'no-store' })
          if (!res.ok || !res.body) throw new Error(String(res.status))
          const reader = res.body.getReader(), dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stopped) break
            buf += dec.decode(value, { stream: true })
            let i: number
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2)
              let event = 'message', data = ''
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim()
                else if (line.startsWith('data:')) data += line.slice(5).trim()
                else if (line.startsWith('id:')) since = line.slice(3).trim()
              }
              if (event === 'hello') { wait = 1000; continue }
              // Missed something while away: refresh once.
              if (event === 'resync') { handlers.current.menu?.(); handlers.current.order?.(); continue }
              try {
                const ev = JSON.parse(data) as { kind?: string }
                if (ev.kind === 'menu') handlers.current.menu?.()
                else if (ev.kind === 'order') handlers.current.order?.()
              } catch { /* comment / keep-alive */ }
            }
          }
        } catch { /* reconnect below */ }
        if (stopped) return
        await new Promise((r) => setTimeout(r, wait + Math.random() * 500))
        wait = Math.min(wait * 2, 30_000)
      }
    }
    void run()
    return () => { stopped = true; ctl?.abort(); setLive(false) }
  }, [shop, order])
  return live
}

/**
 * Without live updates: runs `check` every `ms` while the page is visible (and once when it becomes visible again
 * after at least `ms`). Nothing while hidden, nothing when `on` is false. The server answers these from its cache.
 */
export function useCheckEvery(ms: number, on: boolean, check: () => void) {
  const fn = useRef(check)
  fn.current = check
  useEffect(() => {
    if (!on) return
    let last = Date.now()
    const visible = () => document.visibilityState === 'visible'
    const tick = () => { if (visible() && Date.now() - last >= ms) { last = Date.now(); fn.current() } }
    const id = setInterval(tick, Math.min(ms, 15_000))
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [ms, on])
}
