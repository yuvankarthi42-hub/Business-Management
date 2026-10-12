// Smoke test for a deployed API (run after `catalyst deploy`). Uses a throw-away test shop, then deletes it.
//   node backend/scripts/smoke.mjs --url https://<project>.development.catalystserverless.in/server/api \
//        --admin <admin username> --password <admin password> [--setup-key <SETUP_KEY>]
// It checks the things that can only be verified on the real Data Store: inserts, ZCQL reads, the
// conflict-safe UPDATE used for bill numbers and stock, unique keys, GROUP BY totals and cascade delete.
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const base = (arg('url') ?? '').replace(/\/$/, '')
const adminUser = arg('admin'), adminPass = arg('password'), setupKey = arg('setup-key')
if (!base || !adminUser || !adminPass) { console.log('Usage: node backend/scripts/smoke.mjs --url <api url> --admin <username> --password <password> [--setup-key <key>]'); process.exit(1) }

let ok = 0, failed = 0
// `show` = what to print for a passed step (never tokens or passwords).
const step = async (name, fn, show = (v) => (typeof v === 'string' ? v : undefined)) => {
  try { const v = await fn(); ok++; const out = show(v); console.log(`✔ ${name}${out !== undefined ? ` — ${out}` : ''}`); return v }
  catch (e) { failed++; console.log(`✘ ${name} — ${e.message}`); return undefined }
}
const rpc = async (name, token, ...args) => {
  const res = await fetch(`${base}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ args }) })
  const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
  if (body.error) throw new Error(`${body.error.message} (${body.error.code ?? res.status})`)
  return body
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

await step('health', async () => { const r = await fetch(`${base}/health`); const j = await r.json(); must(j.ok, 'not ok'); return `${j.handlers} actions` })
if (setupKey) await step('schema check', async () => {
  const j = await (await fetch(`${base}/schema-check`, { headers: { 'x-setup-key': setupKey } })).json()
  if (j.error) throw new Error(j.error.message)
  const d = j.data
  must(d.ok, `missing tables: ${d.missingTables.join(', ') || '—'}; missing columns: ${d.missingColumns.map((x) => `${x.table}.${x.column}`).slice(0, 10).join(', ') || '—'}; type: ${d.wrongType.length}; rules: ${d.wrongRules.length}`)
  return `${d.tables} tables OK`
})
const admin = await step('admin sign-in', async () => (await rpc('admin.login', null, adminUser, adminPass)).data.token, () => 'signed in')
if (!admin) { console.log(`\n${ok} passed, ${failed} failed`); process.exit(1) }

const stamp = Date.now().toString(36)
const phone = `9${String(Date.now()).slice(-9)}`
const shopPass = `Smoke${stamp}!`
const created = await step('create test customer', async () => (await rpc('admin.createCustomer', admin, { businessName: `Smoke Test ${stamp}`, ownerName: 'Smoke', username: `smoke${stamp}`, password: shopPass, phone, validity: { months: 1 }, maxBranches: 1 })).data, (v) => `Smoke Test ${stamp}`)
let owner
if (created) {
  owner = await step('owner sign-in', async () => (await rpc('auth.login', null, `smoke${stamp}`, shopPass)).data.token, () => 'signed in')
  await step('auth.me', async () => { const me = (await rpc('auth.me', owner)).data; must(me.business.name.startsWith('Smoke Test'), 'wrong business'); return me.business.billing.invoicePrefix })
  await step('settings save (JSON setting row)', async () => { await rpc('business.update', owner, { address: 'Smoke street', billing: { taxEnabled: false } }); return 'ok' })
  const p = await step('product with opening stock', async () => (await rpc('products.save', owner, { name: 'Smoke item', price: 10, trackStock: true, stock: 5 })).data, (v) => `stock ${v.stock}`)
  if (p) {
    const item = { id: 'x', productId: p.id, name: '', variantId: null, variantName: null, addOns: [], qty: 2, unit: 'pc', unitPrice: 0, taxRate: 0, notes: '', kotQty: 0 }
    const draft = { type: 'counter', tableId: null, customerId: null, items: [item], discount: 0, notes: '', source: 'pos' }
    const b1 = await step('bill 1 (numbers + stock UPDATE)', async () => { const r = await rpc('orders.checkout', owner, draft, [{ method: 'cash', amount: 20 }]); must(r.effects?.stock?.[0]?.stock === 3, `stock ${JSON.stringify(r.effects)}`); return r.data.invoiceNumber })
    const b2 = await step('bill 2 (next number)', async () => (await rpc('orders.checkout', owner, draft, [{ method: 'upi', amount: 20 }])).data.invoiceNumber)
    if (b1 && b2) await step('bill numbers go up', async () => { must(b1 !== b2, `${b1} = ${b2}`); return `${b1} → ${b2}` })
    await step('two bills at the same time (no duplicate numbers)', async () => {
      const [x, y] = await Promise.all([rpc('orders.checkout', owner, { ...draft, items: [{ ...item, qty: 0.5 }] }, [{ method: 'cash', amount: 5 }]), rpc('orders.checkout', owner, { ...draft, items: [{ ...item, qty: 0.5 }] }, [{ method: 'cash', amount: 5 }])])
      must(x.data.invoiceNumber !== y.data.invoiceNumber, 'same bill number twice'); return `${x.data.invoiceNumber}, ${y.data.invoiceNumber}`
    })
    await step('stock after 4 sales is 0', async () => { const list = (await rpc('products.list', owner)).data; const s = list.find((x) => x.id === p.id)?.stock; must(s === 0, `stock ${s}`); return String(s) })
    await step('stock can’t go below zero', async () => { try { await rpc('inventory.adjust', owner, p.id, 'wastage', 1, 'smoke'); throw new Error('was allowed') } catch (e) { must(/below zero/.test(e.message), e.message); return 'refused' } })
    await step('report totals (GROUP BY)', async () => { const s = (await rpc('reports.summary', owner, new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() + 3600e3).toISOString())).data; must(s.orderCount === 4, `orders ${s.orderCount}`); return `₹${s.sales}` })
    // 20 counters at once on one shop: the shop's single writer must take every bill, with unique numbers.
    const bulk = await step('product for the load test', async () => (await rpc('products.save', owner, { name: 'Smoke bulk', price: 1, trackStock: true, stock: 40 })).data, (v) => `stock ${v.stock}`)
    if (bulk) {
      const line = { ...item, productId: bulk.id, qty: 1 }
      await step('20 bills at the same time', async () => {
        const t0 = Date.now()
        const all = await Promise.all(Array.from({ length: 20 }, () => rpc('orders.checkout', owner, { ...draft, items: [line] }, [{ method: 'cash', amount: 1 }])))
        const ms = Date.now() - t0
        const nums = new Set(all.map((r) => r.data.invoiceNumber))
        must(nums.size === 20, `${nums.size} different numbers`)
        const left = (await rpc('products.list', owner)).data.find((x) => x.id === bulk.id)?.stock
        must(left === 20, `stock ${left}`)
        return `${ms} ms for all 20 (${Math.round(ms / 20)} ms each on average)`
      })
    }
    await step('change feed', async () => {
      const r = (await rpc('sync.changes', owner, null)).data
      return r.supported ? `on (newest change ${r.latest})` : 'off (Catalyst Data Store)'
    })
  }
  await step('delete test customer (its database / cascade)', async () => { await rpc('admin.deleteCustomer', admin, created.id, `Smoke Test ${stamp}`); return 'deleted' })
  await step('owner can’t sign in after delete', async () => { try { await rpc('auth.login', null, `smoke${stamp}`, shopPass); throw new Error('still works') } catch (e) { must(/Wrong/.test(e.message), e.message); return 'refused' } })
}
console.log(`\n${ok} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
