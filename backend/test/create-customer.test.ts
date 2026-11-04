import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withShop } from './fixtures'
import { PER_SHOP, TEST_DB } from './helpers'
import { TursoDb } from '../src/db/turso'
import { MIGRATIONS } from '../src/db/migrations.gen'
import { migrate } from '../src/db/migrate'
import { SqlJsDriver, sqlJs } from '../src/db/sql/sqljs'
import { outgoing } from '../src/core/meter'

type Row = Record<string, unknown>
const DROP = new Set(['ROWID', 'CREATEDTIME', 'MODIFIEDTIME', 'id', 'created_at', 'updated_at'])

test('admin.createCustomer: the batched (Turso) way writes exactly what the step-by-step way writes', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  const proto = TursoDb.prototype as unknown as { writeBatch?: unknown }
  const batch = proto.writeBatch
  try {
    s.setToken(s.adminToken)
    const make = (k: string) => s.call<{ id: string; username: string }>('admin.createCustomer', { businessName: `Shop ${k}`, ownerName: 'Owner', username: `owner${k}`, password: 'shop1234', phone: `98765000${k}0`, email: `o${k}@example.com`, validity: { months: 12 }, maxBranches: 2, note: 'Paid by UPI', plan: 'retail' })
    const r0 = outgoing.n
    const fast = await make('1')
    const fastRequests = outgoing.n - r0
    proto.writeBatch = undefined // the old way (as on a database without batches)
    const r1 = outgoing.n
    const slow = await make('2')
    const slowRequests = outgoing.n - r1
    proto.writeBatch = batch
    // (Both already use the one-request table creation; hrana's in-process test server counts its own requests too.)
    if (TEST_DB === 'sqlite') assert.ok(fastRequests <= 20 && fastRequests < slowRequests, `fewer requests: ${fastRequests} vs ${slowRequests}`)

    const platform = await s.env.dbs.platform()
    const both = async (id: string, k: string) => {
      const biz = (await platform.get('businesses', id))!
      const ownerId = String(biz.owner_user_id)
      const shop = await s.env.dbs.shop(id)
      const branches = await shop.select('branches', {}), roles = await shop.select('roles', { orderBy: [['ROWID', 'ASC']] }), users = await shop.select('users', {})
      const roleName = new Map(roles.map((r) => [r.ROWID, `ROLE:${r.name}`])), branchName = new Map(branches.map((b, i) => [b.ROWID, `BRANCH${i}`]))
      const own = [`Shop ${k}`, `owner${k}`, `+9198765000${k}0`, `o${k}@example.com`]
      const strip = (r: Row) => {
        const o: Row = {}
        for (const [f, v] of Object.entries(r)) {
          if (DROP.has(f) || f === 'password_hash' || f === 'db_url' || f === 'subscription_start_at' || f === 'subscription_end_at' || f === 'start_at' || f === 'end_at') continue
          if (f === 'business_id') o[f] = String(v) === id ? 'BIZ' : v
          else if (f === 'role_id') o[f] = roleName.get(String(v)) ?? v
          else if (f === 'default_branch_id' || f === 'branch_id') o[f] = branchName.get(String(v)) ?? v
          else if (f === 'owner_user_id' || f === 'user_id') o[f] = String(v) === ownerId ? 'OWNER' : v
          else if (typeof v === 'string') { let t = v; for (const x of own) t = t.split(x).join('<own>'); if (f === 'uniq_key' && 'role_id' in r) { const rid = String(r.role_id); if (t.startsWith(`${rid}:`)) t = (roleName.get(rid) ?? rid) + t.slice(rid.length) } else t = t.split(`${id}:`).join('BIZ:'); o[f] = t }
          else o[f] = v
        }
        return o
      }
      const span = (x: Row) => Math.round((Date.parse(String(x.subscription_end_at ?? x.end_at)) - Date.parse(String(x.subscription_start_at ?? x.start_at))) / 60_000) // minutes (both are 'now + 12 months')
      return {
        biz: strip(biz), bizSpan: span(biz),
        logins: (await platform.select('login_names', { where: { business_id: id } })).map(strip).sort((a, b) => Number(a.kind) - Number(b.kind)),
        periods: (await platform.select('subscription_periods', { where: { business_id: id } })).map((p) => ({ ...strip(p), span: span(p) })),
        logs: (await platform.select('admin_audit_logs', { where: { business_id: id } })).map(strip),
        db: (await platform.select('shop_databases', { where: { business_id: id } })).map((r) => ({ status: r.status, schema_version: r.schema_version })),
        branches: branches.map(strip), roles: roles.map(strip),
        perms: (await shop.select('role_permissions', {})).map(strip).sort((a, b) => String(a.uniq_key).localeCompare(String(b.uniq_key))),
        taxes: (await shop.select('tax_rates', {})).map(strip),
        users: users.map((u) => ({ ...strip(u), hashed: String(u.password_hash).startsWith('pbkdf2-sha256$') })),
        tables: (await shop.sql!(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)),
        migrations: (await shop.sql!('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version),
      }
    }
    const a = await both(fast.id, '1'), b = await both(slow.id, '2')
    assert.deepEqual(a, b)
    assert.equal(a.logins.length, 3, 'username, mobile and email claimed')
    assert.ok(a.logins.every((l) => l.user_id === 'OWNER'), 'every claim points at the owner')
    assert.equal(a.migrations.length, MIGRATIONS.shop.length)
    // The new owner can sign in.
    s.setToken(null)
    const login = await s.call<{ token: string }>('auth.login', fast.username, 'shop1234')
    assert.ok(login.token)
    console.log(`requests: batched ${fastRequests}, step by step ${slowRequests}`)
  } finally { proto.writeBatch = batch; s.close() }
})

test('admin.createCustomer: taken names give the same messages; a taken email is skipped; a failed shop database leaves nothing', async () => {
  const s = await withShop()
  try {
    s.setToken(s.adminToken)
    const base = { ownerName: 'O', password: 'shop1234', validity: { months: 1 }, maxBranches: 1 }
    await s.call('admin.createCustomer', { ...base, businessName: 'First', username: 'firstshop', phone: '9811100001', email: 'same@example.com' })
    await assert.rejects(s.call('admin.createCustomer', { ...base, businessName: 'X', username: 'firstshop', phone: '9811100002' }), /Username firstshop is already taken/)
    await assert.rejects(s.call('admin.createCustomer', { ...base, businessName: 'X', username: 'othershop', phone: '9811100001' }), /already used by another account/)
    const second = await s.call<{ id: string }>('admin.createCustomer', { ...base, businessName: 'Second', username: 'secondshop', phone: '9811100003', email: 'same@example.com' })
    const platform = await s.env.dbs.platform()
    const names = await platform.select('login_names', { where: { business_id: second.id } })
    assert.deepEqual(names.map((n) => String(n.login)).sort(), ['+919811100003', 'secondshop'].sort().map((x) => names.find((n) => String(n.login).endsWith(x.replace('+91', '')))?.login ?? x).sort(), 'the taken email is not claimed')
    assert.equal(names.length, 2)
    // The shop's database can't be made: nothing is left behind (business row, sign-in names, database row).
    const dbs = s.env.dbs as unknown as { createShop(id: string): Promise<void> }
    const real = dbs.createShop.bind(dbs)
    dbs.createShop = async () => { throw new Error('Turso is down') }
    const before = { biz: (await platform.select('businesses', {})).length, names: (await platform.select('login_names', {})).length }
    await assert.rejects(s.call('admin.createCustomer', { ...base, businessName: 'Broken', username: 'brokenshop', phone: '9811100004' }))
    dbs.createShop = real
    assert.deepEqual({ biz: (await platform.select('businesses', {})).length, names: (await platform.select('login_names', {})).length }, before)
    // …and the same names can be used right after.
    await s.call('admin.createCustomer', { ...base, businessName: 'Broken', username: 'brokenshop', phone: '9811100004' })
  } finally { s.close() }
})

test('migrations: a brand-new database gets the same tables in one request as file by file; existing databases migrate as before', { skip: TEST_DB === 'memory' }, async () => {
  const SQL = await sqlJs()
  const fresh = new SqlJsDriver(new SQL.Database())
  const r0 = outgoing.n
  assert.deepEqual(await migrate(fresh, 'shop'), MIGRATIONS.shop.map((m) => m.version))
  assert.ok(outgoing.n - r0 <= 3, `one request for the tables (plus the check): ${outgoing.n - r0}`)
  // File by file (the old way), as a reference.
  const old = new SqlJsDriver(new SQL.Database())
  for (const m of MIGRATIONS.shop) { await old.script(m.sql); await old.run([{ sql: 'INSERT INTO "schema_migrations" ("version") VALUES (?)', args: [m.version] }]) }
  const schema = async (d: SqlJsDriver) => (await d.run([{ sql: `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name` }, { sql: 'SELECT version FROM schema_migrations ORDER BY version' }])).map((r) => r.rows)
  assert.deepEqual(await schema(fresh), await schema(old))
  // Already up to date: nothing to do. Part-way (an existing database before a new file): the step-by-step path.
  assert.deepEqual(await migrate(fresh, 'shop'), [])
  const part = new SqlJsDriver(new SQL.Database())
  await part.script(MIGRATIONS.shop[0].sql); await part.run([{ sql: 'INSERT INTO "schema_migrations" ("version") VALUES (?)', args: [MIGRATIONS.shop[0].version] }])
  assert.deepEqual(await migrate(part, 'shop'), MIGRATIONS.shop.slice(1).map((m) => m.version))
  assert.deepEqual(await schema(part), await schema(old))
  // A failing file: nothing applied, and the database is still usable.
  const bad = new SqlJsDriver(new SQL.Database())
  const files = MIGRATIONS.shop as { version: string; sql: string }[]
  const saved = files[1].sql
  files[1].sql = 'CREATE TABLE "broken" (; nonsense'
  try { await assert.rejects(migrate(bad, 'shop')) } finally { files[1].sql = saved }
  assert.deepEqual((await bad.run([{ sql: "SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'" }]))[0].rows, [[0]], 'rolled back')
  assert.deepEqual(await migrate(bad, 'shop'), MIGRATIONS.shop.map((m) => m.version), 'works on the next try')
})

test('migrations: two instances migrating the same brand-new database at once — one applies, the other finds it done (no error)', { skip: TEST_DB === 'memory' }, async () => {
  const SQL = await sqlJs()
  const d = new SqlJsDriver(new SQL.Database())
  const [a, b] = await Promise.all([migrate(d, 'shop'), migrate(d, 'shop')])
  const all = MIGRATIONS.shop.map((m) => m.version)
  assert.deepEqual([a, b].sort((x, y) => y.length - x.length), [all, []])
  assert.deepEqual((await d.run([{ sql: 'SELECT version FROM schema_migrations ORDER BY version' }]))[0].rows.map((r) => r[0]), all)
})

test('admin.createCustomer: the shop’s starting rows are one transaction; a failure part-way leaves nothing anywhere', { skip: !PER_SHOP }, async () => {
  const s = await withShop()
  const proto = TursoDb.prototype as unknown as { writeBatch: (ops: { insert?: string }[]) => Promise<unknown> }
  const real = proto.writeBatch
  try {
    s.setToken(s.adminToken)
    const platform = await s.env.dbs.platform()
    const count = async () => ({
      biz: (await platform.select('businesses', {})).length, names: (await platform.select('login_names', {})).length,
      dbs: (await platform.select('shop_databases', {})).length, periods: (await platform.select('subscription_periods', {})).length,
    })
    const before = await count()
    // The second shop batch (permissions + owner) fails after the first (branch, roles, GST rates) went through.
    proto.writeBatch = async function (this: unknown, ops: { insert?: string }[]) { if (ops.some((o) => o.insert === 'users')) throw new Error('connection lost'); return real.call(this, ops) }
    await assert.rejects(s.call('admin.createCustomer', { businessName: 'Half', ownerName: 'O', username: 'halfshop', password: 'shop1234', phone: '9822200001', validity: { months: 1 }, maxBranches: 1 }))
    proto.writeBatch = real
    assert.deepEqual(await count(), before, 'no business, sign-in names, shop database or period left')
    // The platform batch fails at the end: the same clean-up.
    proto.writeBatch = async function (this: unknown, ops: { insert?: string }[]) { if (ops.some((o) => o.insert === 'subscription_periods')) throw new Error('connection lost'); return real.call(this, ops) }
    await assert.rejects(s.call('admin.createCustomer', { businessName: 'Half', ownerName: 'O', username: 'halfshop', password: 'shop1234', phone: '9822200001', validity: { months: 1 }, maxBranches: 1 }))
    proto.writeBatch = real
    assert.deepEqual(await count(), before)
    // Then it works with the same names.
    await s.call('admin.createCustomer', { businessName: 'Half', ownerName: 'O', username: 'halfshop', password: 'shop1234', phone: '9822200001', validity: { months: 1 }, maxBranches: 1 })
    assert.equal((await count()).biz, before.biz + 1)
  } finally { proto.writeBatch = real; s.close() }
})
