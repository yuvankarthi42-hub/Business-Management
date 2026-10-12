// App language. Screens are written in English; when another language is chosen the visible text
// is swapped in place from a dictionary (exact phrases + "{0}" patterns). Adding a language =
// adding one dictionary file and one row in LANGUAGES — no screen code changes.
//
// Not translated: anything inside [data-no-i18n] (printed bills, labels, user-typed names),
// form values the user types, and text not found in the dictionary (product names, etc.).
import { useSyncExternalStore } from 'react'

export interface Dictionary {
  /** English phrase → translation */
  exact: Record<string, string>
  /** English template with {0}, {1}… → translation (placeholders may be reordered or dropped) */
  patterns: Record<string, string>
}

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  // { code: 'hi', name: 'Hindi', native: 'हिन्दी' },      → add src/i18n/hi.ts
  // { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  // { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  // { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
] as const
export type Lang = (typeof LANGUAGES)[number]['code']

const LOADERS: Partial<Record<Lang, () => Promise<Dictionary>>> = {
  ta: () => import('./ta').then((m) => m.default),
}

const DEVICE_KEY = 'billpoodum.lang'
export const deviceLang = (): Lang => {
  try { const v = localStorage.getItem(DEVICE_KEY); return LANGUAGES.some((l) => l.code === v) ? (v as Lang) : 'en' } catch { return 'en' }
}

// ---------- Translation lookup ----------

let dict: Dictionary | null = null
let compiled: { re: RegExp; out: string; slots: number[] }[] = []
/** Lower-cased keys, for terms the screens lower-case ("Add new customer"). Tamil has no case. */
let lower = new Map<string, string>()
const cache = new Map<string, string | null>()
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function compile(d: Dictionary) {
  lower = new Map(Object.entries(d.exact).map(([k, v]) => [k.toLowerCase(), v]))
  compiled = Object.entries(d.patterns)
    .filter(([k]) => k.replace(/\{\d\}/g, '').replace(/[^A-Za-z]/g, '').length >= 3)
    .sort((a, b) => b[0].replace(/\{\d\}/g, '').length - a[0].replace(/\{\d\}/g, '').length)
    .map(([k, out]) => {
      const slots: number[] = []
      const re = new RegExp(`^${k.split(/(\{\d\})/).map((part) => {
        const m = part.match(/^\{(\d)\}$/)
        if (m) { slots.push(Number(m[1])); return '(.{1,60}?)' }
        return esc(part.replace(/\s+/g, ' '))
      }).join('')}$`)
      return { re, out, slots }
    })
}

/** Translate one phrase (whitespace-normalised). Returns null when there's no translation. */
function lookup(s: string, depth = 0): string | null {
  if (!dict) return null
  if (cache.has(s)) return cache.get(s)!
  let r: string | null = dict.exact[s] ?? lower.get(s.toLowerCase()) ?? null
  // Patterns only for short UI text; long paragraphs could make the regexes slow.
  if (r === null && depth < 2 && s.length <= 140) {
    for (const p of compiled) {
      const m = s.match(p.re)
      if (!m) continue
      const vals: Record<number, string> = {}
      p.slots.forEach((slot, i) => { const v = m[i + 1]; vals[slot] = lookup(v, depth + 1) ?? v })
      r = p.out.replace(/\{(\d)\}/g, (_, n) => vals[Number(n)] ?? '')
      break
    }
  }
  // Counts around a phrase: "12 tables", "Available (7)", "Bills · 3".
  if (r === null && depth < 2) {
    const m = s.match(/^([\d.,₹]+ ?)(\S.*)$/) ?? s.match(/^(.*\S)( \(\d+\)| · \d+)$/)
    if (m) {
      const numFirst = /^[\d.,₹]/.test(m[1])
      const t = lookup(numFirst ? m[2] : m[1], depth + 1)
      if (t !== null) r = numFirst ? m[1] + t : t + m[2]
    }
  }
  cache.set(s, r)
  return r
}

/** Translate a string for non-DOM uses (alerts, document title, canvas). */
export function tr(s: string) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  const core = m[2].replace(/\s+/g, ' ')
  if (!core || !/[A-Za-z]/.test(core)) return s
  const out = lookup(core)
  return out === null ? s : m[1] + out + m[3]
}

// ---------- Live DOM translation ----------

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const
const SKIP = '[data-no-i18n], #print-area, script, style, textarea, code, kbd, [contenteditable="true"]'
const textRec = new WeakMap<Text, { src: string; out: string }>()
const attrRec = new WeakMap<Element, Record<string, { src: string; out: string }>>()
const touched = new Set<Node>()
let observer: MutationObserver | null = null

/** The product admin area is English-only (including its pop-ups, which render outside the page). */
const adminArea = () => location.pathname.startsWith('/admin')
const skipped = (el: Element | null) => !el || adminArea() || !!el.closest(SKIP)

function doText(n: Text) {
  const cur = n.nodeValue ?? ''
  const rec = textRec.get(n)
  if (rec && cur === rec.out) return
  if (skipped(n.parentElement)) return
  const out = tr(cur)
  if (out !== cur) { textRec.set(n, { src: cur, out }); touched.add(n); n.nodeValue = out } else {
    textRec.delete(n)
    if (import.meta.env.DEV && /[A-Za-z]{2}/.test(cur)) missing.add(cur.replace(/\s+/g, ' ').trim())
  }
}
/** Dev aid: English text seen on screen with no translation — `__i18nMissing` in the console. */
const missing = new Set<string>()
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __i18nMissing: Set<string> }).__i18nMissing = missing
function doAttrs(el: Element) {
  if (!ATTRS.some((a) => el.hasAttribute(a)) || skipped(el)) return
  const rec = attrRec.get(el) ?? {}
  for (const a of ATTRS) {
    const cur = el.getAttribute(a)
    if (cur === null || (rec[a] && rec[a].out === cur)) continue
    const out = tr(cur)
    if (out !== cur) { rec[a] = { src: cur, out }; el.setAttribute(a, out) } else delete rec[a]
  }
  attrRec.set(el, rec); touched.add(el)
}
function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { doText(root as Text); return }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const el = root as Element
  if (el.closest(SKIP)) return
  doAttrs(el)
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text)
    else doAttrs(n as Element)
  }
}

function start() {
  if (observer) return
  walk(document.body)
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target as Text)
      else if (m.type === 'attributes') doAttrs(m.target as Element)
      else m.addedNodes.forEach(walk)
    }
    if (touched.size > 5000) touched.forEach((n) => { if (!n.isConnected) touched.delete(n) })
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] })
}
function stop() {
  observer?.disconnect(); observer = null
  touched.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) { const r = textRec.get(n as Text); if (r && n.nodeValue === r.out) n.nodeValue = r.src; textRec.delete(n as Text) }
    else { const el = n as Element; const r = attrRec.get(el); if (r) for (const [a, v] of Object.entries(r)) if (el.getAttribute(a) === v.out) el.setAttribute(a, v.src); attrRec.delete(el) }
  })
  touched.clear()
}

// ---------- Current language ----------

let current: Lang = 'en'
const listeners = new Set<() => void>()

/** Switch the whole app. `remember` keeps it for this device (used before sign-in). */
export async function setLanguage(lang: Lang, remember = true) {
  if (remember) { try { localStorage.setItem(DEVICE_KEY, lang) } catch { /* private mode */ } }
  if (lang === current) return
  current = lang
  stop()
  dict = null; compiled = []; lower = new Map(); cache.clear()
  const load = LOADERS[lang]
  if (load) { dict = await load(); if (current !== lang) return; compile(dict); start() }
  document.documentElement.lang = lang
  listeners.forEach((l) => l())
}
export const getLanguage = () => current
export const useLanguage = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, getLanguage)
