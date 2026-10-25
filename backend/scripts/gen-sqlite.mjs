// Turso (libSQL / SQLite) schema, generated from server/catalyst/schema.sql — the single source of truth.
//   node backend/scripts/gen-sqlite.mjs
//     → server/turso/platform.sql, server/turso/shop.sql    the full current schema of each kind of database
//     → backend/migrations/<kind>/0001_init.sql             the first migration (= the full schema, written once)
//     → backend/src/db/migrations.gen.ts                    every migration file, bundled into the API
// Tables are split by backend/scripts/placement.mjs: one platform database + one database per shop.
// A foreign key is kept only when both tables are in the same database (the API checks the others).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOTH, PLATFORM } from './placement.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sql = readFileSync(join(root, 'server/catalyst/schema.sql'), 'utf8')

// ---------- parse schema.sql (keeps each column's comment) ----------
const tables = []
for (const m of sql.matchAll(/(?:--[^\n]*\n)*CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
  const [block, name, body] = m
  const lead = block.slice(0, block.indexOf('CREATE TABLE')).split('\n').map((l) => l.replace(/^--\s?/, '').trim()).filter(Boolean)
  const columns = []
  let last = null
  for (const raw of body.split('\n')) {
    if (/^\s+--/.test(raw) && last) { last.comment = `${last.comment} ${raw.trim().replace(/^--\s?/, '')}`.trim(); continue }
    const line = raw.replace(/\s+--.*$/, '')
    const c = line.match(/^ {2}(\w+)\s+(VARCHAR\((\d+)\)|(?:TEXT|ENCRYPTED|BIGINT|INT|DOUBLE|BOOLEAN|DATETIME|DATE)\b)(.*)$/)
    if (!c) continue
    const [, col, typeRaw, len, rest] = c
    const comment = raw.includes('--') ? raw.slice(raw.indexOf('--') + 2).trim() : ''
    const fk = rest.match(/FK → (\w+) (CASCADE|NULL)/)
    const def = rest.match(/DEFAULT ('([^']*)'|[\w.-]+)/)
    last = {
      name: col, type: typeRaw.startsWith('VARCHAR') ? 'varchar' : typeRaw.toLowerCase(), len: len ? Number(len) : null,
      notNull: /\bNOT NULL\b/.test(rest), unique: /\bUNIQUE\b/.test(rest),
      def: def ? (def[2] !== undefined ? `'${def[2]}'` : def[1]) : null,
      fk: fk ? { table: fk[1], onDelete: fk[2] === 'CASCADE' ? 'CASCADE' : 'SET NULL' } : null,
      isEnum: /^[A-Z]\w+:/.test(comment) && typeRaw === 'INT',
      comment,
    }
    columns.push(last)
  }
  tables.push({ name, lead, columns })
}
if (tables.length < 50) throw new Error(`Only ${tables.length} tables parsed`)

// ---------- parents first ----------
const byName = new Map(tables.map((t) => [t.name, t]))
const order = [], placed = new Set()
const deps = (t) => t.columns.filter((c) => c.fk && c.fk.table !== t.name).map((c) => c.fk.table)
while (order.length < tables.length) {
  const ready = tables.filter((t) => !placed.has(t.name) && deps(t).every((d) => placed.has(d)))
  if (!ready.length) throw new Error('Foreign keys form a loop')
  for (const t of ready) { order.push(t); placed.add(t.name) }
}

// ---------- columns ----------
const q = (s) => `"${s}"`
function colSql(c, present) {
  let type, checks = []
  switch (c.type) {
    case 'varchar': case 'text': case 'encrypted': case 'datetime': type = 'TEXT'; break
    case 'date': type = 'TEXT'; checks.push(`${q(c.name)} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`); break
    case 'boolean': type = 'INTEGER'; checks.push(`${q(c.name)} IN (0, 1)`); break
    case 'double': type = 'REAL'; break
    default: type = 'INTEGER' // INT, BIGINT, FK ids
  }
  if (c.isEnum) checks.push(`${q(c.name)} >= 1`) // codes from enums.ts; new values never need a migration
  let def = c.def
  if (def && c.type === 'boolean') def = def === 'true' ? '1' : '0'
  const parts = [q(c.name).padEnd(26), type.padEnd(8)]
  if (c.notNull) parts.push('NOT NULL')
  if (c.unique) parts.push('UNIQUE')
  if (def !== null) parts.push(`DEFAULT ${def}`)
  const sameDb = c.fk && present.has(c.fk.table)
  if (sameDb) parts.push(`REFERENCES ${q(c.fk.table)}("id") ON DELETE ${c.fk.onDelete}`)
  for (const ch of checks) parts.push(`CHECK (${c.notNull ? ch : `${q(c.name)} IS NULL OR ${ch}`})`)
  const other = c.fk && !sameDb ? `→ ${c.fk.table}.id in the ${present.has('businesses') ? 'shop' : 'platform'} database (checked by the API)` : ''
  return { sql: parts.join(' ').replace(/\s+$/, ''), comment: [c.len ? `max ${c.len}` : '', c.type === 'encrypted' ? 'AES-256-GCM ciphertext (encrypted in the API)' : '', other, c.comment].filter(Boolean).join(' · ') }
}

// ---------- indexes: the planned query paths + every foreign key ----------
const PLANNED = {
  orders: [['business_id', 'branch_id', 'status', 'created_at'], ['business_id', 'billed_at'], ['business_id', 'customer_id', 'status'], ['business_id', 'table_id', 'status'], ['business_id', 'order_number']],
  push_subscriptions: [['business_id', 'expires_at']],
  order_items: [['order_id', 'sort_order'], ['product_id']],
  payments: [['business_id', 'branch_id', 'created_at'], ['order_id'], ['business_id', 'customer_id']],
  stock_movements: [['business_id', 'product_id', 'created_at'], ['business_id', 'branch_id', 'created_at']],
  stock_batches: [['product_id', 'branch_id', 'expiry_date']],
  products: [['business_id', 'is_active']],
  customers: [['business_id', 'is_active']],
  kitchen_tickets: [['business_id', 'branch_id', 'status'], ['order_id']],
  expenses: [['business_id', 'branch_id', 'expense_date']],
  attendance: [['business_id', 'work_date']],
  audit_logs: [['business_id', 'created_at']],
  admin_audit_logs: [['business_id', 'created_at'], ['created_at']],
  whatsapp_messages: [['business_id', 'created_at'], ['campaign_id']],
  support_tickets: [['business_id', 'last_message_at'], ['status', 'last_message_at']],
  ticket_messages: [['ticket_id', 'created_at']],
  sale_returns: [['business_id', 'branch_id', 'created_at'], ['order_id']],
  daily_specials: [['business_id', 'special_date']],
  subscription_periods: [['business_id', 'created_at']],
  users: [['business_id', 'is_active']],
}


const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
const KINDS = {
  platform: { title: 'platform database (one)', has: (t) => PLATFORM.includes(t) || BOTH.includes(t) },
  shop: { title: 'shop database (one per shop)', has: (t) => !PLATFORM.includes(t) },
}

function build(kind) {
  const k = KINDS[kind]
  const list = order.filter((t) => k.has(t.name))
  const present = new Set(list.map((t) => t.name))
  const out = [
    '-- =====================================================================================================',
    `--  BillPoodum — Turso (libSQL / SQLite) schema: ${k.title}`,
    '-- =====================================================================================================',
    '--  GENERATED by backend/scripts/gen-sqlite.mjs from server/catalyst/schema.sql — do not edit by hand.',
    '--  To change a table: edit schema.sql, run the generator, and add the difference as a new migration file',
    `--  backend/migrations/${kind}/NNNN_<what>.sql (ALTER TABLE …). The tests check the migrations add up to this file.`,
    '--',
    '--  Same tables, columns and relations as the approved design (see server/catalyst/TABLES.md). Mapping:',
    '--    Catalyst ROWID              → "id" INTEGER PRIMARY KEY AUTOINCREMENT (never reused; the API calls it ROWID)',
    '--    CREATEDTIME / MODIFIEDTIME  → "created_at" / "updated_at"  TEXT, ISO-8601 UTC (set automatically)',
    '--    VARCHAR(n) / TEXT           → TEXT  (max length checked by the API, so it can grow without a table rebuild)',
    '--    INT / BIGINT / FK ids       → INTEGER   · money in paise, qty in thousandths, % in basis points',
    '--    BOOLEAN                     → INTEGER 0 / 1',
    '--    DATE / DATETIME             → TEXT  YYYY-MM-DD / ISO-8601 UTC (sorts and compares correctly)',
    '--    ENCRYPTED                   → TEXT holding AES-256-GCM ciphertext (the API encrypts with SECRETS_KEY)',
    '--    Fixed lists (enums)         → INTEGER codes from server/catalyst/enums.ts (CHECK >= 1 only, so a new',
    '--                                   value never needs a migration). Never renumber; add at the end.',
    '--    FK → x CASCADE / NULL       → REFERENCES x("id") ON DELETE CASCADE / SET NULL — only when x is in this',
    '--                                   database; a reference to the other database is a plain INTEGER.',
    '--  The API turns on foreign keys ("PRAGMA foreign_keys = ON") on every connection.',
    '-- =====================================================================================================',
    '',
  ]
  let indexCount = 0
  for (const t of list) {
    out.push(...t.lead.filter((l) => !/^=+$/.test(l)).map((l) => `-- ${l}`))
    out.push(`CREATE TABLE IF NOT EXISTS ${q(t.name)} (`)
    const cols = [
      { sql: `${q('id').padEnd(26)} INTEGER  PRIMARY KEY AUTOINCREMENT`, comment: 'ROWID' },
      ...t.columns.map((c) => colSql(c, present)),
      { sql: `${q('created_at').padEnd(26)} TEXT     NOT NULL DEFAULT ${NOW}`, comment: 'CREATEDTIME' },
      { sql: `${q('updated_at').padEnd(26)} TEXT     NOT NULL DEFAULT ${NOW}`, comment: 'MODIFIEDTIME' },
    ]
    cols.forEach((c, i) => out.push(`  ${c.sql}${i < cols.length - 1 ? ',' : ''}${c.comment ? `  -- ${c.comment}` : ''}`))
    out.push(') STRICT;', '')
    out.push(`CREATE TRIGGER IF NOT EXISTS ${q(`${t.name}_updated_at`)} AFTER UPDATE ON ${q(t.name)} FOR EACH ROW WHEN NEW."updated_at" = OLD."updated_at"`)
    out.push(`BEGIN UPDATE ${q(t.name)} SET "updated_at" = ${NOW} WHERE "id" = NEW."id"; END;`, '')
    const idx = [...(PLANNED[t.name] ?? [])]
    const leads = new Set(idx.map((cols) => cols[0]))
    for (const c of t.columns) if (c.fk && !c.unique && !leads.has(c.name)) { idx.push([c.name]); leads.add(c.name) }
    for (const cols of idx) {
      for (const c of cols) if (!['created_at', 'updated_at'].includes(c) && !t.columns.some((x) => x.name === c)) throw new Error(`Index on unknown column ${t.name}.${c}`)
      out.push(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t.name}_${cols.join('_')}`)} ON ${q(t.name)} (${cols.map(q).join(', ')});`)
      indexCount++
    }
    out.push('')
  }

  out.push(
    '-- =====================================================================================================',
    '--  Added for Turso',
    '-- =====================================================================================================',
    '',
    '-- Which migration files have run on this database.',
    'CREATE TABLE IF NOT EXISTS "schema_migrations" (',
    '  "version"                  TEXT     PRIMARY KEY,  -- file name, e.g. 0001_init',
    `  "applied_at"               TEXT     NOT NULL DEFAULT ${NOW}`,
    ') STRICT;',
    '',
  )
  let extra = 1
  if (kind === 'shop') {
    extra += 2
    indexCount += 1
    out.push(
      '-- Change feed: every committed write adds a row (same transaction); other devices ask "what changed since',
      '-- <id>" every ~15 s and re-read only those screens. Rows older than 2 days are removed by the daily job.',
      'CREATE TABLE IF NOT EXISTS "change_log" (',
      '  "id"                       INTEGER  PRIMARY KEY AUTOINCREMENT,',
      '  "business_id"              INTEGER  NOT NULL,',
      '  "branch_id"                INTEGER,             -- NULL = whole business',
      '  "tag"                      TEXT     NOT NULL,   -- orders · catalog · stock · customers · … (the app cache tags)',
      '  "origin"                   TEXT,                -- the device that made the change (it has already refreshed)',
      `  "created_at"               TEXT     NOT NULL DEFAULT ${NOW}`,
      ') STRICT;',
      'CREATE INDEX IF NOT EXISTS "ix_change_log_created_at" ON "change_log" ("created_at");',
      '',
      '-- Raised on every change to users, roles, branches, settings, the subscription or features → cached',
      '-- sign-in sessions reload. One row per shop (business_id kept so shops can share a database later).',
      'CREATE TABLE IF NOT EXISTS "sync_epochs" (',
      '  "business_id"              INTEGER  PRIMARY KEY,',
      '  "epoch"                    INTEGER  NOT NULL DEFAULT 1,',
      `  "updated_at"               TEXT     NOT NULL DEFAULT ${NOW}`,
      ') STRICT;',
      '',
    )
  }
  return { sql: out.join('\n'), tables: list.length + extra, indexCount }
}

const migDir = join(root, 'backend/migrations')
const bundle = {}
for (const kind of Object.keys(KINDS)) {
  const { sql: full, tables: n, indexCount } = build(kind)
  mkdirSync(join(root, 'server/turso'), { recursive: true })
  writeFileSync(join(root, `server/turso/${kind}.sql`), full)
  const dir = join(migDir, kind)
  mkdirSync(dir, { recursive: true })
  // 0001 is the full schema the first time; after a database exists it must never change (add 0002_… instead).
  const init = join(dir, '0001_init.sql')
  if (!existsSync(init) || process.argv.includes('--reset-init')) writeFileSync(init, full)
  bundle[kind] = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort().map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }))
  console.log(`server/turso/${kind}.sql: ${n} tables, ${indexCount} indexes · migrations: ${bundle[kind].map((m) => m.version).join(', ')}`)
}
writeFileSync(join(root, 'backend/src/db/migrations.gen.ts'), `// GENERATED by backend/scripts/gen-sqlite.mjs from backend/migrations/ — do not edit by hand.
export interface Migration { version: string; sql: string }
export const MIGRATIONS: { platform: Migration[]; shop: Migration[] } = ${JSON.stringify(bundle)}
`)
