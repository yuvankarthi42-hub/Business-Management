// M9 (CSV formulas), M1 (QR order floods), M7 (support password reset), M6 (pepper warning).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { csv } from '../../src/lib/csv'
import { warnIfNoPepper } from '../src/core/passwords'

test('M9: CSV cells that start like a formula are made text; numbers stay numbers', () => {
  const out = csv([{ Name: '=HYPERLINK("http://x","y")', Note: '+cmd', At: '@SUM(A1)', Neg: -50, NegText: '-50.00', Plain: 'Tea', Dash: '- item' }])
  const row = out.split('\r\n')[1]
  assert.ok(row.startsWith(`"'=HYPERLINK(""http://x"",""y"")"`), row)
  assert.ok(row.includes(",'+cmd,") && row.includes(",'@SUM(A1),"))
  assert.ok(row.includes(',-50,-50.00,Tea,'), 'numbers (and number text) unchanged')
  assert.ok(row.endsWith(",'- item"))
})

test('M6: production without PASSWORD_PEPPER → a warning (never a crash)', () => {
  const said: string[] = []
  assert.equal(warnIfNoPepper({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, (m) => said.push(m)), true)
  assert.match(said[0], /PASSWORD_PEPPER is not set/)
  assert.equal(warnIfNoPepper({ NODE_ENV: 'production', PASSWORD_PEPPER: 'x'.repeat(40) } as NodeJS.ProcessEnv, (m) => said.push(m)), false)
  assert.equal(warnIfNoPepper({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, (m) => said.push(m)), false)
})

async function qrShop(autoAccept: boolean) {
  const s = await withShop()
  await s.call('business.update', { billing: { taxEnabled: false }, modules: { billing: true, products: true, orders: true, tables: true, qrOrdering: true }, qr: { orderTypes: ['dine_in', 'takeaway'], autoAccept, baseUrl: '' } })
  const t1 = await s.call<{ id: string }>('tables.save', { label: 'T1', floor: 'Main', seats: 4 })
  const tea = await s.call<{ id: string }>('products.save', { name: 'Tea', price: 20 })
  const order = (extra: Record<string, unknown>) => s.call<{ orderId: string }>('public.placeOrder', s.businessId, { type: 'takeaway', tableId: null, items: [{ productId: tea.id, variantId: null, addOnIds: [], qty: 1, notes: '' }], guest: { name: 'Anu', phone: '', address: '' }, notes: '', ...extra })
  return { s, t1, tea, order }
}

test('M1: guest customers are not opted into offers', async () => {
  const { s, order } = await qrShop(false)
  try {
    s.setToken(null)
    await order({ guest: { name: 'Anu', phone: '9811111111', address: '' } })
    s.setToken(s.ownerToken)
    const c = (await s.call<{ name: string; phone: string; marketingOptIn?: boolean }[]>('customers.list')).find((x) => x.phone.endsWith('9811111111'))!
    assert.equal(c.marketingOptIn, false)
  } finally { s.close() }
})

test('M1: per phone (5 / 10 min) and per table (10 / 10 min) limits; a normal family is never stopped', async () => {
  const { s, t1, order } = await qrShop(false)
  try {
    s.setToken(null)
    for (let i = 0; i < 3; i++) await order({ guest: { name: 'Anu', phone: '9811111112', address: '' } }) // a family: fine
    await order({ guest: { name: 'Anu', phone: '9811111112', address: '' } })
    await order({ guest: { name: 'Anu', phone: '9811111112', address: '' } })
    await assert.rejects(order({ guest: { name: 'Anu', phone: '9811111112', address: '' } }), /Too many orders/)
    for (let i = 0; i < 10; i++) await order({ type: 'dine_in', tableId: t1.id, guest: { name: '', phone: '', address: '' } })
    await assert.rejects(order({ type: 'dine_in', tableId: t1.id, guest: { name: '', phone: '', address: '' } }), /Too many orders/)
  } finally { s.close() }
})

test('M1: with auto-accept, a 4th order from one network in 5 minutes waits for staff', async () => {
  const { s, order } = await qrShop(true)
  try {
    s.setToken(null)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await order({ guest: { name: 'G', phone: `98111112${20 + i}`, address: '' } })).orderId)
    s.setToken(s.ownerToken)
    const pending = await s.call<{ id: string }[]>('qr.pending')
    assert.deepEqual(pending.map((o) => o.id), [ids[3]], 'the first 3 accepted automatically; the 4th waits')
  } finally { s.close() }
})

test('M7: only super admins reset an owner’s password; the owner must then set their own (server-enforced)', async () => {
  const s = await withShop()
  try {
    // An admin Manager can't reset the owner's password any more.
    s.setToken(s.adminToken)
    await s.call('admin.saveAdmin', { name: 'Mgr', username: 'mgr1', role: 'manager', password: 'Manager#2026' })
    s.setToken(null)
    const mgr = (await s.call<{ token: string }>('admin.login', 'mgr1', 'Manager#2026')).token
    s.setToken(mgr)
    await assert.rejects(s.call('admin.resetPassword', s.businessId, 'Support#2026x'), (e: { status?: number }) => e.status === 403)
    // The super admin resets it.
    s.setToken(s.adminToken)
    await s.call('admin.resetPassword', s.businessId, 'Support#2026x')
    // The owner signs in with it: told, and everything but "set a new password" is refused.
    s.setToken(null)
    const r = await s.call<{ token: string; passwordResetAt?: string }>('auth.login', 'lakshmi', 'Support#2026x')
    assert.ok(r.passwordResetAt, 'the owner is told when support reset it')
    s.setToken(r.token)
    const me = await s.call<{ mustSetPassword?: boolean }>('auth.me')
    assert.equal(me.mustSetPassword, true)
    await assert.rejects(s.call('categories.list'), (e: { code?: string }) => e.code === 'PASSWORD_CHANGE_REQUIRED')
    await assert.rejects(s.call('users.list'), (e: { code?: string }) => e.code === 'PASSWORD_CHANGE_REQUIRED')
    // Setting their own password ends it.
    const next = await s.call<{ token: string }>('auth.changePassword', 'Support#2026x', 'MyOwn#Pass2026')
    s.setToken(next.token)
    assert.equal((await s.call<{ mustSetPassword?: boolean }>('auth.me')).mustSetPassword, undefined)
    await s.call('users.list')
    // The next sign-in is normal.
    s.setToken(null)
    const again = await s.call<{ passwordResetAt?: string }>('auth.login', 'lakshmi', 'MyOwn#Pass2026')
    assert.equal(again.passwordResetAt, undefined)
    // The shop's audit log says support reset it.
    s.setToken(s.ownerToken)
  } finally { s.close() }
})

test('M7: owners whose password was never reset by support are not affected', async () => {
  const s = await withShop()
  try {
    s.setToken(s.ownerToken)
    const me = await s.call<{ mustSetPassword?: boolean }>('auth.me')
    assert.equal(me.mustSetPassword, undefined)
    await s.call('users.list')
  } finally { s.close() }
})
