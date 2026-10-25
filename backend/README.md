# Kadai Kalanjiyam API (Zoho Catalyst + Turso)

TypeScript + Express, bundled into a Catalyst Advanced I/O function (`catalyst/functions/api`) and a Cron function
(`catalyst/functions/daily`).
- Data is in **Turso**: one platform database plus one database per shop. The Catalyst Data Store still works as a
  single-database option.
- How it works: [`server/catalyst/TURSO.md`](../server/catalyst/TURSO.md).
- Deploy steps: [`server/catalyst/DEPLOY.md`](../server/catalyst/DEPLOY.md).

## Run and test locally

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the same API at `http://localhost:8787/server/api`, with the same database layout as production.
- The databases are SQLite files in `.local/sqlite/` (`platform.sqlite`, `local-shop-<id>.sqlite`), run with sql.js, so
  there is nothing to install.
- Copy `.env.local.example` to `.env.local` first; it creates the first product admin.
- `LOCAL_DB=memory` uses the in-memory single-database store instead.
- In another terminal, run the web app against it with `npm run dev:catalyst` from the repository root.

```bash
npm test
```

Every test runs three times:
- `test:sqlite`: real SQLite, one database per shop.
- `test:hrana`: the production Turso driver over HTTP, against a stand-in Turso server (`test/fakeTurso.ts`).
- `test:memory`: one in-memory database with the Catalyst Data Store's rules.

## How a request works

`POST /rpc/<namespace>.<method>` with `{ "args": [...] }` → `{ "data": … , "effects"?: … }` or `{ "error": { message, code } }`.
The names match the app's `api.<namespace>.<method>()`, so screens don't change.

Before any handler runs (`src/app.ts`):
1. The token is checked: customer `t:'u'` (it carries the shop id) or admin `t:'a'`, HS256 with `AUTH_SECRET`.
2. The shop's database is opened.
3. The signed-in user, role, business and branches are loaded. They are cached in function memory, keyed by the shop's
   epoch, and every change that affects them calls `bumpEpoch()`.
4. The branch from the `x-branch` header is accepted only if the user may open it.
5. Writes are refused in support view, on expired (read-only) accounts and on deactivated accounts.
6. The handler's permission is checked.
7. A write runs as one transaction (handler option `tx`). Its action name goes to the change feed in the same
   transaction.

Every query filters by the signed-in business, and ids from the browser are checked with `own()`. Changing a request in
the browser can't reach another shop or branch: another shop's data is in another database.

## Code map

| Folder | What |
|---|---|
| `src/db/` | the `Db` interface and its implementations:<br>• `TursoDb` (`turso.ts`), with drivers `sql/hrana.ts` (Turso over HTTPS) and `sql/sqljs.ts` (local)<br>• `CatalystDb` and `MemoryDb` (single database)<br>• `databases.ts`: which database a request uses, plus creating and dropping shop databases<br>• `migrate.ts` and `scoped.ts`: each handle only reaches its own database's tables |
| `src/core/` | request context (`c.db` = shop, `c.platform`, `c.tx()`), handler registry, tokens, passwords, epochs, encryption, files |
| `src/domain/` | table ⇄ app-shape mapping and shared rules: business, people, catalogue, stock, orders, units & enums (`util.ts`), the shop directory and sign-in names (`directory.ts`) |
| `src/modules/` | one file per feature; each registers its actions with `define()` |
| `migrations/` | `platform/` and `shop/` SQL files, run in order (generated `0001_init`, then hand-written) |
| `test/` | end-to-end tests through HTTP |
| `scripts/` | schema generators, setup checklist, build, smoke test for a deployed API |

## Adding a feature

1. **Table changes.**
   - Edit `server/catalyst/schema.sql`: new tables or columns only. Never renumber enums in `server/catalyst/enums.ts`;
     add at the end.
   - For a new table, say where it lives in `scripts/placement.mjs`. Not listed means the shop database.
   - Run `npm run gen`.
   - Add `migrations/<platform|shop>/NNNN_<what>.sql` with the `CREATE TABLE` / `ALTER TABLE`. Copy it from the new
     `server/turso/*.sql`.
2. **Create `src/modules/<feature>.ts`:**
   ```ts
   define('myFeature', {
     list: userRead(async (c) => …),                              // read: c.db = this shop's database
     save: userWrite(async (c, input) => …, { perm: 'settings.manage' }), // write: one transaction
   })
   ```
   and import it in `src/modules/index.ts`. Use `c.platform` for platform tables; the tests fail if a handle is used for
   the wrong database.
3. **In the app.**
   - Add the same method to the mock API (`src/data/api.ts`) so the demo works.
   - Tell the cache about it in `src/data/remote/policy.ts`: for reads, the tags and how long to keep them; for writes,
     which tags they change. Other devices then use the same rules through the change feed.
4. **Add a test** in `test/` and run `npm test`.

Rules that keep things correct:
- Money in paise (`toMinor`), quantities in thousandths (`toMilli`).
- The shop's day with `bizDay(c)`: the server runs in UTC.
- Stock only through `moveStock()` / `moveStockMany()`, and bill / order numbers only through `nextNumber()`.
- No calls to other services (WhatsApp, file storage) inside a transaction: use `tx: 'none'`.
- A change that touches both databases must be safe if it stops half-way. Use `c.onFail()` / `c.afterCommit()`; see
  `domain/directory.ts`.

## Things to check on the first real deploy

The smoke test (`scripts/smoke.mjs`) covers these:
- **Turso.** The platform database migrates on the first request, and a new customer gets its own database. It also
  prints how long 20 bills at the same moment take.
- **Catalyst Data Store** (if used instead):
  - ZCQL `UPDATE … WHERE row_version = n` must return the updated rows.
  - The time zone of `CREATEDTIME` (`CATALYST_TZ_OFFSET_MIN`).
  - Column names that may be reserved words. The schema check shows them.
