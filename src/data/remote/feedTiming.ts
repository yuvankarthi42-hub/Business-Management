// How often a screen asks the change feed (no event hub): screens where another counter's change must show quickly
// (new KOT, QR order, a table's bill) every 30 s; every other screen (dashboard, reports, products, settings…) every
// 60 s — about half the server calls. Hidden tabs and idle screens don't ask at all (sync.ts).
const URGENT = /^\/(kitchen|qr-orders|tables|billing|m\/order|customer-orders)(\/|$|\?)/

export const feedInterval = (path: string) => (URGENT.test(path) ? 30_000 : 60_000)
