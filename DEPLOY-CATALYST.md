# Kadai Kalanjiyam — host on Zoho Catalyst + Turso (step by step, from zero)

Release: branch `main`, commit `9582b96` and later (final test 16 Nov 2026).
This is **account 1 — Catalyst + Turso**. Cloudflare (account 2) has its own guide: [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md).

This guide starts from nothing: a new Zoho Catalyst project, a new Turso database group, photo storage, the API, the
daily job and the web app. Follow the steps in order. Nothing is copied from any test setup — production starts empty.

**Already running on Catalyst?** You don't need this whole guide — go to **[Updating an existing setup](#updating-an-existing-setup)**.

```
Shops' phones / PCs / tablets
        │
        ▼
Slate (web app)  ──►  Catalyst function "api"  ──►  Turso: 1 platform database + 1 database per shop (Mumbai)
                      Catalyst function "daily" (Cron 09:00)
                      Catalyst Stratus (photos, logos)
```

| What | Where it runs | File you upload |
|---|---|---|
| Web app (screens) | Catalyst **Slate** | `web-prod.zip` |
| API (every bill, login, report) | Catalyst function **`api`** (Advanced I/O) | `api.zip` |
| Daily jobs (reminders, clean-ups) | Catalyst function **`daily`** (Cron) | `daily.zip` |
| Data | **Turso** (one database per shop) | — |
| Photos and logos | Catalyst **Stratus** | — |

**Time needed:** about 2 hours the first time (including the tests).

---

## Part A — Values you will collect

Keep this list in a **password manager**. Never paste these values in chat, email or Git.

| # | Name | What it is | Where you get it | Goes into | Needed? |
|---|---|---|---|---|---|
| 1 | `TURSO_PLATFORM_URL` | Platform database address (`libsql://…`) | Step 2.2 | api, daily | **Required** |
| 2 | `TURSO_AUTH_TOKEN` | Turso **group** token (full access) | Step 2.3 | api, daily | **Required** |
| 3 | `TURSO_API_TOKEN` | Turso API token (makes a database for each new shop) | Step 2.4 | api, daily | **Required** |
| 4 | `TURSO_ORG` | Turso organisation name | Step 2.5 | api, daily | **Required** |
| 5 | `TURSO_GROUP` | Group name, e.g. `kk-prod` | Step 2.1 | api, daily | **Required** |
| 6 | `TURSO_DB_PREFIX` | Shop database name prefix, e.g. `kk` → `kk-shop-1` (default `bp`) | Step 2.7 | api | Optional |
| 7 | `AUTH_SECRET` | Signs every login (random) | Step 3 | api | **Required** |
| 8 | `SETUP_KEY` | For tables, migrations and the first admin (random) | Step 3 | api | **Required** |
| 9 | `SECRETS_KEY` | Encrypts each shop's database token (random). **Never change it later** | Step 3 | api, daily | **Required** |
| 10 | `STRATUS_BUCKET` | Photo bucket name, e.g. `kk-media` | Step 4 | api | **Required** |
| 11 | `STRATUS_PUBLIC_URL` | The bucket's public address | Step 4 | api | **Required** |
| 12 | `ALLOWED_ORIGINS` | The web app's address (Slate URL) | Step 8 | api | **Required** |
| 13 | `PASSWORD_PEPPER` | Extra secret mixed into every password (random). **Never change or remove it once set** | Step 3 | api | Recommended |
| 14 | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | "Notify me" on the order tracking page | Step 3 | api | Optional |
| 15 | `VAPID_SUBJECT` | e.g. `mailto:KadaiKalanjiyam@gmail.com` | — | api | Optional (with #14) |
| 16 | `ACCOUNT_ID` | This setup's label, e.g. `cat-1` (stops it from ever using another setup's database) | You choose | api, daily | Optional |
| — | Product admin username + password | Your own admin login — **not a variable**; made once in Step 7.3 | Step 7.3 | — | **Required** |

Leave these **unset** (the defaults are right): `PASSWORD_ITERATIONS`, `DAILY_SHOPS_PER_RUN`, `DAILY_REMINDERS_PER_RUN`,
`DAILY_REQUEST_BUDGET`, `DAILY_CPU_BUDGET_MS`, `CLIENT_IP_SOURCE`, `TRUSTED_PROXIES` (only if Step 7.5 asks for it),
`CRON_KEY`, `TURSO_LOCATION`.

---

## Step 0 — On your computer: install, test, build the server zips (25 min)

**0.1 Requirements (once):** Node.js **24** (check with `node -v`), and the project folder from GitHub (`main` branch).

**0.2 Install the packages** (in the project folder):

```bash
npm install
```

```bash
npm --prefix backend install
```

**0.3 Run all the test cases** (61 test files, each run on 3 database types — about 5–15 minutes):

```bash
npm run backend:test
```

At the end of each of the three runs you must see `# fail 0`:

| Run | Expected |
|---|---|
| SQLite | `# tests 212` · `# pass 212` · `# fail 0` |
| Turso protocol | `# tests 212` · `# pass 209` · `# skipped 3` · `# fail 0` |
| In-memory | `# tests 212` · `# pass 193` · `# skipped 19` · `# fail 0` |

"Skipped" = tests for another database type (normal). Any `not ok` → **don't deploy**; send the `not ok` lines to your
developer. (Two CPU-time tests can fail only when the computer is very busy; run that test file again alone — if it passes,
it's fine.)

**0.4 Check the code builds:**

```bash
npm run typecheck
```

```bash
npm --prefix backend run build
```

Both must finish without `error`. (`npm --prefix backend run build` prints a few `"import.meta"` warnings — normal.)

**0.5 Make the server zips:**

```bash
rm -f api.zip daily.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .)
```

You now have `api.zip` and `daily.zip`. The web app zip is made later (Step 8), because it needs the API address.

---

## Step 1 — Create the Catalyst project (10 min)

1. Open **https://console.catalyst.zoho.in** (India data centre) and sign in with the Zoho account for this setup.
2. **Create Project** → name, e.g. `kadai-kalanjiyam` → choose **India** if asked.
3. Open the project and use the **Production** environment (switcher at the top). If Catalyst makes you set up
   Development first and then "Deploy to Production", that's fine — make sure every environment variable is also set in
   **Production**.
4. Catalyst **Cache** is not used (the API keeps its cache in Turso) — nothing to set up there.

## Step 2 — Turso database (15 min)

Open **https://app.turso.tech** and sign in (create an account if new).

1. **Group:** Groups → **Create group** → name `kk-prod` → location **Mumbai (aws-ap-south-1)** → value #5.
2. **Platform database:** Databases → **Create database** → name `kk-prod-platform` → group `kk-prod`.
   Copy its URL `libsql://kk-prod-platform-<org>.aws-ap-south-1.turso.io` → value #1.
3. **Group token:** Groups → `kk-prod` → **Create Token** → **Full access**, **no expiry** → value #2.
   ⚠️ It must be the **group** token (not a database token), otherwise creating a shop fails.
4. **API token:** Settings → **API Tokens** → **Create** (organisation-wide, or for `kk-prod`) → value #3.
5. **Organisation name:** shown in the address `app.turso.tech/<org>` → value #4.
6. **Plan:** Settings → Billing → **Developer** (or higher) — this gives point-in-time restore (your backup).
7. Choose the shop database prefix, e.g. `kk` → value #6.

Tokens are shown only once — save them right away.

## Step 3 — Make the secrets (your computer, 5 min)

Run this once for each of `AUTH_SECRET` (#7), `SETUP_KEY` (#8), `SECRETS_KEY` (#9) and `PASSWORD_PEPPER` (#13) — a new
value each time:

```bash
openssl rand -hex 32
```

**Optional — "Notify me" on the order tracking page** (in the project folder):

```bash
npm --prefix backend run vapid
```

It prints `VAPID_PUBLIC_KEY=…` and `VAPID_PRIVATE_KEY=…` (#14). Without them the tracking page shows **Refresh** only.

## Step 4 — Photo storage: Stratus (5 min)

1. Catalyst console → **Cloud Scale → Stratus → Create Bucket**.
2. Name, e.g. `kk-media` → value #10.
3. Allow **public read** for objects (photos and logos show in the app and on the QR menu).
4. Copy the bucket URL → value #11.

## Step 5 — The `api` function (15 min)

1. **Serverless → Functions → Create Function**
   - Type **Advanced I/O**, name **`api`** (exactly), stack **Node.js 24**.
   - Upload **`api.zip`**.
2. Open **Functions → api** and copy its address, ending in `/server/api`, e.g.
   `https://kadai-kalanjiyam-1234567.catalystserverless.in/server/api` → this is your **API URL**.
   (In Production it has **no** `development` in it.)
3. **Configuration → Environment Variables** — add:

| Name | Value |
|---|---|
| `AUTH_SECRET` | #7 |
| `SETUP_KEY` | #8 |
| `SECRETS_KEY` | #9 |
| `PASSWORD_PEPPER` | #13 (recommended) |
| `TURSO_PLATFORM_URL` | #1 |
| `TURSO_AUTH_TOKEN` | #2 |
| `TURSO_API_TOKEN` | #3 |
| `TURSO_ORG` | #4 |
| `TURSO_GROUP` | #5 |
| `TURSO_DB_PREFIX` | #6 (optional) |
| `STRATUS_BUCKET` | #10 |
| `STRATUS_PUBLIC_URL` | #11 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | #14, #15 (optional) |
| `ACCOUNT_ID` | #16 (optional) |

   `ALLOWED_ORIGINS` (#12) is added in Step 8, once the web app has its address.
4. **Memory: 128 MB** (function settings → Memory). If the smoke test in Step 7.4 shows "20 bills at the same time"
   taking more than ~5 seconds, set it to 256 MB.
5. **Save** and **Deploy**.

## Step 6 — The `daily` function (5 min)

1. **Functions → Create Function** → type **Cron**, name **`daily`**, stack **Node.js 24** → upload **`daily.zip`**.
2. **Environment Variables** — the **same** values as on `api`:

| Name | Value |
|---|---|
| `SECRETS_KEY` | #9 |
| `TURSO_PLATFORM_URL` | #1 |
| `TURSO_AUTH_TOKEN` | #2 |
| `TURSO_API_TOKEN` | #3 |
| `TURSO_ORG` | #4 |
| `TURSO_GROUP` | #5 |
| `ACCOUNT_ID` | #16 (only if set on `api`, same value) |

3. **Memory: 128 MB**, then **Save** and **Deploy**.
4. **Cloud Scale → Triggers → Cron → Create:** every day at **09:00**, time zone **Asia/Kolkata**, target function
   **`daily`** (renewal reminders, expiring loyalty points, clean-ups).

## Step 7 — Check the API, create the tables and the first admin (20 min)

In the commands, replace `<api-url>` with your API URL (Step 5) and `<SETUP_KEY>` with #8.

### 7.1 Health check

```bash
curl -s <api-url>/health
```

✔ Expected: `{"ok":true,"version":"1.0.0","handlers":202}`
✘ No answer / error page → `api` isn't deployed, or the URL is wrong (it must end in `/server/api`).

### 7.2 Create the database tables

```bash
curl -s <api-url>/schema-check -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: `"ok": true` (this first call creates the platform tables).
✘ `Not allowed` → `SETUP_KEY` missing on `api`, shorter than 16 characters, or typed differently.

```bash
curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: a list of databases brought up to date (only the platform database at this point).

### 7.3 Create the first product admin (one time only)

The **product admin** is you — the Kadai Kalanjiyam owner. This login creates customers (shops), renews subscriptions
and answers support tickets. It is **not** a shop login.

Choose a **name**, a **username** (4–30 characters: small letters, numbers, `.` `-` `_`, e.g. `kk.admin`) and a
**password** (12+ characters with letters, numbers and symbols). Save them in your password manager.

**Mac / Linux:**

```bash
curl -s -X POST <api-url>/rpc/admin.setup -H "content-type: application/json" -d '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

**Windows PowerShell:**

```powershell
Invoke-RestMethod -Method Post -Uri "<api-url>/rpc/admin.setup" -ContentType "application/json" -Body '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

✔ Expected: `{"data":{"id":"1","username":"<admin username>"}}`

| Message | Meaning / fix |
|---|---|
| `Setup is not allowed` | Wrong `SETUP_KEY`, or it isn't set (16+ characters) on `api`. |
| `Setup is already done` | A first admin already exists — sign in with it. |
| `Username: 4–30 letters, numbers…` | Change the username. |
| `Password must be at least 6 characters` | Use a longer password. |

The password was typed in the command — close that terminal window afterwards. More admins later: **Admin → Team → Add
admin** (each person their own login).

### 7.4 Smoke test on the live API (2 min)

Runs real checks against the deployed API: sign-in, settings, a product with stock, bill numbers, **two bills at the same
moment**, **20 bills from 20 counters at once**, report totals — then deletes its test shop.

```bash
node backend/scripts/smoke.mjs --url <api-url> --admin <admin username> --password <admin password> --setup-key <SETUP_KEY>
```

✔ Expected: every line starts with `✔`; the last line is `20 passed, 0 failed`.
✘ Any `✘` → don't give it to shops yet. Usual causes: wrong Turso tokens, `TURSO_GROUP` or `TURSO_ORG`.

### 7.5 Visitor address check (1 min)

Sign-in limits count per visitor address — make sure a visitor can't fake it:

```bash
curl -s <api-url>/ip-check -H "x-setup-key: <SETUP_KEY>" -H "X-Forwarded-For: 1.2.3.4"
```

✔ Expected: `"ip"` is **your own internet address** (compare with https://ifconfig.me), never `1.2.3.4`.
✘ Shows `1.2.3.4` → don't go live; tell the developer.
✘ Shows a Zoho / proxy address (the same for everyone) → put that address in `TRUSTED_PROXIES` on `api` and check again.

## Step 8 — The web app on Slate (15 min)

The web app has the API URL built in, so it is built **now**, after Step 5.

1. In the project folder, copy `.env.prod.example` to **`.env.prod`** and set:
   ```
   VITE_BACKEND=catalyst
   VITE_API_BASE=<api-url>
   VITE_ROUTER=hash
   VITE_CONTACT_WHATSAPP=917013905970
   ```
2. Build and zip:
   ```bash
   npm run build:prod
   ```
   ```bash
   rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
   ```
3. Catalyst console → **Slate → Create App → Upload** `web-prod.zip` → **Deploy**.
4. Copy the Slate address, e.g. `https://web-xxxx.onslate.in` → value #12.
5. **Let the web app call the API:**
   - **Functions → api → Environment Variables:** add `ALLOWED_ORIGINS` = the Slate address (no `/` at the end) → Save
     and Deploy.
   - **Cloud Scale → Authentication → Whitelisting → Authorized Domains:** add the Slate address and turn on **CORS**.
6. **Own domain (optional):** Slate → your app → **Domains** → add e.g. `app.kadaikalanjiyam.in`, add the DNS records it
   shows at your domain provider, and add that address to `ALLOWED_ORIGINS` too (comma-separated).

## Step 9 — Turn on the features (5 min)

Open `https://<slate-address>/#/admin/login` → sign in as the product admin → **Features**. On a new setup they start
**Off** for everyone:

| Feature | What the customer gets | Suggested |
|---|---|---|
| **QR Orders** | QR menu, QR Orders screen, order tracking | **All customers** (or **Selected** for food / restaurant shops) |
| **Daily Specials & offers display** | Specials, offer prices in billing / QR menu, TV display | **All customers** |
| **GST report** | GST returns tab in Reports | **All customers** |
| **Single device (no background sync)** | Screens stop checking every 30–60 s for other devices' changes | **Off**; turn it on per customer for one-counter shops |
| **WhatsApp integration** | Settings → Integrations | **Off** (sending is still simulated) |

Press **Save** on each card you change. The same switches are on every customer's page (**Admin → Customers → the shop →
Features**).

## Step 10 — First real check (15 min)

1. `https://<slate-address>/#/admin/login` → sign in as the product admin.
2. **Admin → Customers → Create customer** (a test shop first). In Turso, a database `kk-shop-1` appears in `kk-prod`.
3. `https://<slate-address>/#/login` → sign in as that shop's owner → finish the setup → add items → make a bill.
4. Check:
   - [ ] Bill and **print** on a real thermal printer; tap **Collect** twice fast → only **one** bill.
   - [ ] **KOT** → shows on **Kitchen**.
   - [ ] **Shop logo** upload (Settings → Business Profile) → shows in the top bar.
   - [ ] **QR menu** on a phone → order → appears in **QR Orders** (within ~30 s) → **Track order** updates by itself.
   - [ ] A **mobile / repair shop**: **Service Jobs** → new job with an advance → move it to Ready → bill it at delivery.
   - [ ] A **Cashier** login: billing works; Reports / Expenses are hidden.
   - [ ] Phone and tablet layout.
   - [ ] Admin page shows the shop, its usage and the audit log.

## Step 11 — Before giving it to customers

| Item | What to do |
|---|---|
| Backups | Turso Developer plan with point-in-time restore (Step 2.6). See "Backups" below. |
| Features | QR Orders / Daily Specials / GST report on for the right shops (Step 9). |
| WhatsApp | Keep **off** (simulated). |
| Terms & Privacy | Pages at `/#/terms` and `/#/privacy` — have a lawyer check them and add your legal entity name. |
| UPI | The payment QR is a placeholder — confirm UPI payments manually. |
| Free-tier size | Turso free: about 36 small shops, or 3 hotels, or 1 large shop — then Turso needs a paid plan. |
| Pilot | 1–2 friendly shops for 2–4 weeks; check bills, stock and payments daily in the first week. |

---

## Updating an existing setup

**For the current release the zips are already built** in the project folder: `api.zip`, `daily.zip`, `web-prod.zip`
(`web-prod.zip` uses the API address in your `.env.prod`; the previous zips are in `previous-zips-2026-11-17/`).

1. **Back up** Turso (point-in-time restore is on with the Developer plan).
2. Catalyst console → upload `api.zip` → **api**, `daily.zip` → **daily**, `web-prod.zip` → **Slate** → Deploy each.
3. Update the tables (only migrations not yet done are applied):
   ```bash
   curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```
   This release adds `0012_request_log`, `0013_drop_branch_stock_business_index` and `0014_service_jobs`.
4. Check `/health` (`"handlers":202`), sign in, a bill and its print, the Orders page, a KOT and a Service Job.
5. Refresh every shop screen once (or close and reopen the app). Signed-in users stay signed in.

**For a later release, make the zips yourself** (project folder, after Step 0.3 passes):

```bash
npm --prefix backend run build
```

```bash
rm -f api.zip daily.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .)
```

```bash
npm run build:prod
```

```bash
rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
```

Then steps 1–5 above. Keep the previous zips in a dated folder (e.g. `previous-zips-<date>/`) to roll back: to roll back,
upload the previous zips the same way.

---

## Backups and restoring a shop

**What protects the data**
- **Turso point-in-time restore** (the main backup): every database — the platform one and each shop's — can be restored to
  any moment within your Turso plan's retention window.
- **The shop's own export** (Settings → Audit & Data → Download, or Admin → customer → Export): Excel or ZIP — a copy for
  the shop, **not** a restorable backup.
- **Photos** (Stratus) are not backed up separately — keep bucket versioning on if your plan offers it.

**Restore one shop's database (e.g. a wrong bulk change at 3 PM)**
1. Turso → the shop's database (`<prefix>-shop-<id>`, e.g. `kk-shop-1`) → **Restore / branch from a point in time** → a
   time just before the problem. This makes a **new** database with a new URL.
2. Create a token for it (Turso → database → Create token, full access).
3. Encrypt the token the way the API stores it (same `SECRETS_KEY` as `api`), on your computer:
   ```bash
   SECRETS_KEY='<SECRETS_KEY>' node backend/scripts/encrypt-secret.mjs '<new token>'
   ```
   It prints `v1:…`. Then, in the Turso shell of the **platform** database:
   `UPDATE shop_databases SET db_url = '<new libsql url>', db_token = '<the v1:… value>' WHERE business_id = <shop id>;`
4. Redeploy `api` (same zip) so running instances drop the old connection.
5. Open the shop in the app and check the latest bills. Keep the old database a few days, then delete it.

**Restore the platform database** (logins, shop list, subscriptions): restore it in the same group, then set
`TURSO_PLATFORM_URL` to the new URL on **both** `api` and `daily` and redeploy both.

## If something goes wrong

| Problem | Fix |
|---|---|
| `/health` fails | Function not deployed, or wrong zip — upload `api.zip` again and deploy. |
| "Server is not configured (AUTH_SECRET)" | `AUTH_SECRET` missing or shorter than 32 characters on `api`. |
| Login page says it can't reach the server | `VITE_API_BASE` wrong in `.env.prod` (rebuild `web-prod.zip`), or `ALLOWED_ORIGINS` / Authorized Domains missing the Slate address. |
| Creating a customer fails: "refused TURSO_AUTH_TOKEN" | `TURSO_AUTH_TOKEN` is a database token — use the **group** token (Step 2.3). |
| Creating a customer fails: Turso API error | `TURSO_API_TOKEN`, `TURSO_ORG` or `TURSO_GROUP` wrong. |
| Photos / logo don't upload | `STRATUS_BUCKET` / `STRATUS_PUBLIC_URL` wrong, or the bucket isn't public-read. |
| A shop has no QR Orders / Daily Specials / GST returns | The feature is off for it (Step 9), or the shop's own module is off (Settings → Modules). |
| Service Jobs missing for a mobile shop | The shop type must be **Service** (e.g. Repair) or **Retail → Electronics**, and the module on in Settings → Modules. |
| Another device's change shows late | Normal on Catalyst: Billing, Tables, Kitchen, QR orders and Take Order check every 30 s, other screens every 60 s. |
| Every request refused after changing `TURSO_PLATFORM_URL` | `ACCOUNT_ID` differs from the one stored in that platform database — use this setup's own database. |
| Wrong change in a shop's data | Turso point-in-time restore — "Backups and restoring a shop" above. |
