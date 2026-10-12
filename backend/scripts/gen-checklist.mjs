// Writes server/catalyst/SETUP-TABLES.md: every table and column with the exact Catalyst console
// settings, in an order where each parent table exists before the tables that point to it.
// Run: node backend/scripts/gen-checklist.mjs   (after gen-schema.mjs)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tables = JSON.parse(readFileSync(join(root, 'backend/setup/tables.json'), 'utf8'))

// Parents first. A self reference (categories.parent_id) doesn't count. Foreign keys that would make a
// loop are added afterwards ("add later" below).
const order = [], placed = new Set(), later = []
const deps = (t) => tables[t].columns.filter((c) => c.references && c.references !== t).map((c) => c.references)
while (order.length < Object.keys(tables).length) {
  const ready = Object.keys(tables).filter((t) => !placed.has(t) && deps(t).every((d) => placed.has(d)))
  if (!ready.length) {
    // Break a loop: place the table with the fewest missing parents and add those keys later.
    const t = Object.keys(tables).filter((x) => !placed.has(x)).sort((a, b) => deps(a).filter((d) => !placed.has(d)).length - deps(b).filter((d) => !placed.has(d)).length)[0]
    for (const c of tables[t].columns) if (c.references && c.references !== t && !placed.has(c.references)) later.push({ table: t, column: c })
    order.push(t); placed.add(t); continue
  }
  for (const t of ready) { order.push(t); placed.add(t) }
}
const laterSet = new Set(later.map((l) => `${l.table}.${l.column.name}`))

const TYPE = { varchar: 'Var Char', text: 'Text', encrypted: 'Encrypted text', bigint: 'BigInt', int: 'Int', double: 'Double', boolean: 'Boolean', datetime: 'DateTime', date: 'Date', fk: 'Foreign Key', id: 'BigInt' }
const lines = [
  '# Catalyst Data Store — table setup checklist',
  '',
  'Generated from `server/catalyst/schema.sql` by `backend/scripts/gen-checklist.mjs` — do not edit by hand.',
  '',
  'Create the tables **in this order** (Catalyst console → Cloud Scale → Data Store → Create table), then add the columns',
  'exactly as listed. ROWID, CREATORID, CREATEDTIME and MODIFIEDTIME are created by Catalyst automatically.',
  'When done, open `https://<your-function-url>/server/api/schema-check` with the header `x-setup-key: <SETUP_KEY>`',
  '(or Admin → Schema check) — it lists anything missing or different.',
  '',
  `**${order.length} tables · ${order.reduce((n, t) => n + tables[t].columns.length, 0)} columns.**`,
  '',
  '| Setting | Meaning |',
  '|---|---|',
  '| Mandatory | IsMandatory validator on |',
  '| Unique | IsUnique on (cannot be changed later — get it right first time) |',
  '| Search | Search Index on |',
  '| PII | PII/ePHI validator on |',
  '| FK → table (Cascade / Null) | Foreign Key: Parent Table = table, On Delete = Cascade / Null |',
  '',
]
order.forEach((t, i) => {
  lines.push(`## ${i + 1}. \`${t}\``, '', '| Column | Data type | Max length | Mandatory | Unique | Default | Foreign key | Search | PII |', '|---|---|---|---|---|---|---|---|---|')
  for (const c of tables[t].columns) {
    const fk = c.references ? `→ \`${c.references}\` (${c.onDelete === 'cascade' ? 'Cascade' : 'Null'})${laterSet.has(`${t}.${c.name}`) ? ' — **add later**' : ''}` : ''
    lines.push(`| \`${c.name}\` | ${TYPE[c.type]} | ${c.maxLength ?? ''} | ${c.mandatory ? '✔' : ''} | ${c.unique ? '✔' : ''} | ${c.default ?? ''} | ${fk} | ${c.search ? '✔' : ''} | ${c.pii ? '✔' : ''} |`)
  }
  lines.push('')
})
if (later.length) {
  lines.push('## Add these foreign-key columns last', '', 'Their parent table is created after the table itself, so add them once all tables exist:', '')
  for (const l of later) lines.push(`- \`${l.table}.${l.column.name}\` → \`${l.column.references}\` (${l.column.onDelete === 'cascade' ? 'Cascade' : 'Null'})`)
  lines.push('')
}
writeFileSync(join(root, 'server/catalyst/SETUP-TABLES.md'), lines.join('\n'))
console.log(`SETUP-TABLES.md: ${order.length} tables, ${later.length} foreign keys added later`)
