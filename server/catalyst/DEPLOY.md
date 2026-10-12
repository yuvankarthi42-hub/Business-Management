# Deploying BillPoodum on Zoho Catalyst (+ Turso)

Project ID: `80411000000086002`. The app has these parts:

| Part | Where it runs | Built from |
|---|---|---|
| **API** (`api`, Advanced I/O function) + **daily job** (`daily`, Cron function) | Catalyst Functions | `backend/` → `catalyst/functions/` |
| **Data** | **Turso** — 1 platform database + 1 database per shop (recommended), or the Catalyst Data Store | `server/catalyst/schema.sql` |
| **Photos** | Catalyst Stratus | — |
| **Web app** (React) | Catalyst **Slate** (recommended) or Web Client Hosting | `src/` → `dist-catalyst/` |

How it works: [TURSO.md](TURSO.md). The demo app (`npm run dev`, data in the browser) is unchanged. `VITE_BACKEND=catalyst`
switches the same screens to the real API.

**Choose the database once, before the first customer:**
- **Turso (recommended)** — do step 3A, skip 3B.
- **Catalyst Data Store** (the first version) — skip 3A, do 3B. Every row read/written is billed by Catalyst; see CATALYST-TURSO.md.

No test shop or sample data is ever put in production: the smoke test (step 9) makes a throw-away shop and deletes it.

---

## 1. One-time tools

```bash
npm install -g zcatalyst-cli
```

```bash
catalyst login
```

`catalyst login` opens a Zoho sign-in in your browser — sign in with the account that owns the project.

## 2. Link this folder to the project

```bash
cd catalyst
```

```bash
catalyst project:use 80411000000086002
```

## 3A. Turso (recommended)

You need a Turso account with an organisation (the free plan allows 100 databases and 5 GB in total — enough to start;
the Developer plan has no database limit). In the Turso dashboard or with the `turso` CLI (`turso auth login` signs in
in your browser):

1. **Group** in the region closest to Catalyst's India data centre (e.g. Mumbai, `aws-ap-south-1`). The `default`
   group is fine if it is in that region.
2. **Platform database** in that group, e.g. `bp-platform` → note its URL (`libsql://bp-platform-<org>.turso.io`).
3. **Group token** (one token opens every database of the group, including the shop databases made later):
   `turso group tokens create <group>` → `TURSO_AUTH_TOKEN`.
4. **Platform API token** (lets the API create and delete shop databases): `turso auth api-tokens mint billpoodum` → `TURSO_API_TOKEN`.

The tables are created by the API itself (migrations) — the platform database on the first request, each shop's
database when the product admin creates the customer. Nothing to create by hand.

## 3B. Catalyst Data Store (only if you don't use Turso)

Catalyst has no API to create tables, so they are created once in the console:
**Cloud Scale → Data Store → Create table**. Follow [`SETUP-TABLES.md`](SETUP-TABLES.md) — every table in the order
listed (parents first), with each column's data type, max length, Mandatory, Unique, default, foreign key
(parent table + On Delete) exactly as written. *Unique* can't be changed after a column is made, so check it first.

Step 7 checks your work and lists anything missing.

## 4. Stratus bucket and Cache

- **Stratus → Create bucket** `billpoodum-media` (product photos, screenshots). Allow public read for objects, and note
  the bucket URL (e.g. `https://billpoodum-media-xxxx.zohostratus.com`).
- **Cache**: nothing to create (only the Data Store setup uses it, the default segment).

## 5. Build and deploy the API

From the repository root:

```bash
npm --prefix backend install
```

```bash
npm run backend:build
```

```bash
cd catalyst && catalyst deploy --only functions
```

## 6. Function settings (environment variables)

Console → **Serverless → Functions → api → Configuration → Environment variables**. Use long random values for the
two secrets and keep them private. Set the same `STRATUS_*` values on **daily** too.

| Variable | Value |
|---|---|
| `AUTH_SECRET` | 40+ random characters — signs every login. Changing it signs everyone out. |
| `SETUP_KEY` | 24+ random characters — only for the schema check, migrations and creating the first admin. |
| `SECRETS_KEY` | 32+ random characters — encrypts WhatsApp access tokens in Turso. Keep it forever (changing it means re-entering the tokens). |
| `STRATUS_BUCKET` | `billpoodum-media` |
| `STRATUS_PUBLIC_URL` | the bucket URL from step 4 |
| `ALLOWED_ORIGINS` | the web app address when it is on another domain (Slate), e.g. `https://billpoodum.onslate.in` |
| `CRON_KEY` | optional — only if you call `system.runDailyJobs` from outside |
| **Turso (3A)** | |
| `TURSO_PLATFORM_URL` | the platform database URL (`libsql://…`). Setting it switches the API to Turso. |
| `TURSO_AUTH_TOKEN` | the group token |
| `TURSO_ORG` | your Turso organisation (slug) |
| `TURSO_API_TOKEN` | the platform API token |
| `TURSO_GROUP` | the group name (default `default`) |
| `TURSO_DB_PREFIX` | optional, default `bp` — shop databases are named `bp-shop-<id>`. Use another prefix for a staging project. |
| `TURSO_LOCATION` | optional — only if new databases should go to a location other than the group's |
| **Data Store (3B)** | |
| `CATALYST_TZ_OFFSET_MIN` | `0` normally. If dates of new records show 5½ h off, set `330`. |

Set the same values on **daily** too (it reads the same databases).

## 7. Check the tables

```bash
curl -s https://<your-function-domain>/server/api/schema-check -H "x-setup-key: <SETUP_KEY>"
```

`"ok": true` means every table and column is right. Otherwise it lists missing tables, missing columns, wrong types
and missing Unique / Mandatory settings. With Turso it checks the platform database and also shows how many shop
databases are ready (`shops`) and how many still need the newest migration (`shopsBehind`).

## 8. Create the first product admin

```bash
curl -s -X POST https://<your-function-domain>/server/api/rpc/admin.setup -H "content-type: application/json" -d '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

This works only once (while there is no admin). Add more admins later in **Admin → Team**.

## 9. Smoke test (real databases)

```bash
node backend/scripts/smoke.mjs --url https://<your-function-domain>/server/api --admin <admin username> --password <admin password> --setup-key <SETUP_KEY>
```

It makes a throw-away test shop (with Turso: its own database), bills from 20 "counters" at once and prints how long
they took, checks bill numbers, stock, reports and the delete, then deletes the shop (and its database). All steps
should pass.

## 10. The web app

**Slate (recommended)** — React apps with normal links (`/billing`, `/q/<shop>` for QR menus).

1. Create `.env.catalyst` (copy `.env.catalyst.example`) with `VITE_API_BASE=https://<your-function-domain>/server/api`.
2. Build:

   ```bash
   npm run build:catalyst
   ```

3. Slate → New app → **Direct upload** of `dist-catalyst/` (or connect the Git repo with build command
   `npm run build:catalyst` and output `dist-catalyst`; set `VITE_BACKEND=catalyst` and `VITE_API_BASE` as Slate
   environment variables). Single-page app routing: send unknown paths to `index.html`.
4. Put the Slate address in the `api` function's `ALLOWED_ORIGINS` (step 6).

**Web Client Hosting (alternative)** — the app is served under `/app/` on the function's domain, so no CORS is needed:

```bash
npm run build:catalyst-webclient
```

```bash
cd catalyst && catalyst deploy --only client
```

Note: if refreshing a page like `/app/billing` shows "not found", use Slate instead.

## 11. Daily renewal reminders

Console → **Cloud Scale → Triggers → Cron → New**: every day at **09:00 IST**, target function **daily**. It runs
once per day (a second run the same day does nothing).

---

## Cost notes

See [CATALYST-TURSO.md](CATALYST-TURSO.md). With Turso, Catalyst bills only the function calls, Slate and Stratus; every
row is in Turso (free plan: 500 million rows read, 10 million written per month, 5 GB). The app reads from its own cache
and asks the server again only after a confirmed change — its own, or another device's through the change feed (one
small request every 30 s while a screen is open and in use).

## Updating later

Change code → run the tests:

```bash
npm run backend:test
```

then `npm run backend:build` and `catalyst deploy --only functions`.

A table change: edit `server/catalyst/schema.sql` and run `npm --prefix backend run gen`, then:
- **Turso:** add `backend/migrations/<platform|shop>/NNNN_<what>.sql` with the `ALTER TABLE`, build and deploy. Shop
  databases update on their next request. To update all at once:
  `curl -s -X POST https://<your-function-domain>/server/api/migrate -H "x-setup-key: <SETUP_KEY>"`
- **Data Store:** add the column in the console and check with step 7.
