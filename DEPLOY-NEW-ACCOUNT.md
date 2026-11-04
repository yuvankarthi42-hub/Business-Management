# Kadai Kalanjiyam — full deployment on a NEW account (from zero)

Release: branch `main`, commit `454d963` (4 Nov 2026).
This guide sets up everything fresh: a new **Zoho Catalyst** project, a new **Turso** database group, photo storage,
the API, the daily job, the web app and (optionally) order notifications. Nothing is copied from the old test setup —
production starts empty.

**What's new in this release (for anyone who deployed an earlier one):** no AppSail / live-update hub any more (open
screens check for changes every 30–60 s), release flags in **Admin → Features** (QR Orders, Daily Specials & offers
display, GST report — all **off** until you turn them on, Step 9), a **Single device** flag that stops background
checks for one-counter shops, every regular API under 10 ms CPU, and simpler forms.

```
Shops' phones / PCs / tablets
        │
        ▼
Slate (web app)  ──►  Catalyst function "api"  ──►  Turso: 1 platform database + 1 database per shop (Mumbai)
                      Catalyst function "daily" (Cron 09:00)
                      Catalyst Stratus (photos, logos)
```

**Time needed:** about 2–2½ hours the first time (including running the tests).

---

## Part A — Keys and values you will collect (fill this in as you go)

Keep this list in a **password manager**. Never paste these in chat, email or Git.

| # | Name | What it is | Where you get it | Goes into | Needed? |
|---|---|---|---|---|---|
| 1 | `TURSO_PLATFORM_URL` | Platform database address (`libsql://…`) | Turso, Step 2.2 | api, daily | **Required** |
| 2 | `TURSO_AUTH_TOKEN` | **Group** token (full access) | Turso, Step 2.3 | api, daily | **Required** |
| 3 | `TURSO_API_TOKEN` | Turso API token (creates a database for each new shop) | Turso, Step 2.4 | api, daily | **Required** |
| 4 | `TURSO_ORG` | Your Turso organisation name | Turso, Step 2.5 | api, daily | **Required** |
| 5 | `TURSO_GROUP` | Group name, e.g. `kk-prod` | You choose, Step 2.1 | api, daily | **Required** |
| 6 | `TURSO_DB_PREFIX` | Name prefix for shop databases, e.g. `kk` → `kk-shop-1` (default `bp`) | You choose | api | Optional |
| 7 | `AUTH_SECRET` | Signs every login (random, 64 hex) | Generate, Step 3 | api | **Required** |
| 8 | `SETUP_KEY` | For setup / migrations / first admin (random) | Generate, Step 3 | api | **Required** |
| 9 | `SECRETS_KEY` | Encrypts each shop's database token and WhatsApp tokens (random). **Never change later** | Generate, Step 3 | api, daily | **Required** |
| 10 | `STRATUS_BUCKET` | Photo bucket name, e.g. `kk-media` | You choose, Step 4 | api | **Required** |
| 11 | `STRATUS_PUBLIC_URL` | Bucket's public address | Catalyst, Step 4 | api | **Required** |
| 12 | `ALLOWED_ORIGINS` | Web app address (Slate URL) | Catalyst, Step 8 | api | **Required** (set in Step 8) |
| 13 | `VAPID_PUBLIC_KEY` | Notifications public key | Generate, Step 3 | api | Optional |
| 14 | `VAPID_PRIVATE_KEY` | Notifications private key (secret) | Generate, Step 3 | api | Optional |
| 15 | `VAPID_SUBJECT` | `mailto:KadaiKalanjiyam@gmail.com` | — | api | Optional |
| 19 | Admin username + password | The first product-admin login — **not a variable**: you create it once in Step 7.3 | You choose, Step 7.3 | — | **Required** |
| 20 | `PASSWORD_PEPPER` | Extra server secret mixed into every password hash (random, 32+ characters). **Never change or remove it once set** — every password would stop working | Generate, Step 3 | api | Optional (recommended) |
| 21 | `PASSWORD_ITERATIONS` | Password hash strength (PBKDF2). Default `20000` (fits a 10 ms CPU budget) | — | api | Optional (leave unset) |
| 22 | `DAILY_SHOPS_PER_RUN` | Daily jobs: shops handled per run. Default `20` | — | daily, api | Optional (leave unset) |
| 23 | `DAILY_REMINDERS_PER_RUN` | Daily jobs: renewal reminders sent per run. Default `20` | — | daily, api | Optional (leave unset) |
| 24 | `DAILY_REQUEST_BUDGET` | Daily jobs: most outgoing requests one run may make. Default `40` | — | daily, api | Optional (leave unset) |
| 25 | `DAILY_CPU_BUDGET_MS` | Daily jobs: CPU time after which a run stops starting new shops. Default `7` | — | daily, api | Optional (leave unset) |
| 26 | `DAILY_REMINDER_HOUR` | Hourly runs only: renewal reminders go from this hour (IST). Default `9` | — | api | Optional (leave unset) |

Not needed in this setup: `CRON_KEY`, `CATALYST_TZ_OFFSET_MIN`, `TURSO_LOCATION` (leave them unset).
(#16–#18 were the AppSail live-update settings `EVENTS_SECRET`, `EVENTS_URL`, `EVENTS_PUBLIC_URL` — removed: on Catalyst
open screens check for changes every 30–60 s. If they are still set on `api` from an older setup, they are ignored.)

---

## Step 0 — Run all the test cases on your computer first (20 min)

Deploy only a build whose tests all pass. Do this on the computer that has the project folder.

**0.1 Requirements (once):** Node.js **18 or newer** (check with `node -v`).

**0.2 Install the packages** (project folder):

```bash
npm install
```

```bash
npm --prefix backend install
```

**0.3 Run the backend test cases** — 43 test files (120 test cases), each run on 3 database types (real SQLite,
Turso's network protocol, and the in-memory store like Catalyst's Data Store):

```bash
npm run backend:test
```

It takes about 10–15 minutes. At the end of each of the three runs you must see `# fail 0`:

| Run | Expected |
|---|---|
| SQLite | `# tests 120` · `# pass 120` · `# fail 0` |
| Turso protocol | `# tests 120` · `# pass 117` · `# skipped 3` · `# fail 0` |
| In-memory | `# tests 120` · `# pass 102` · `# skipped 18` · `# fail 0` |

"Skipped" tests are ones that don't apply to that database type (for example request counting on the in-memory
store) — that is normal. Any `not ok` or `# fail 1` (or more) → **do not deploy**; send the lines starting with
`not ok` to your developer.

What the test cases cover (backend/test/):

| Test file | Checks |
|---|---|
| `billing`, `counter`, `save-once` | Bills, KOT, QR orders, discounts and price changes need rights, a bill saved only once (double tap / dropped connection) |
| `returns-staff`, `high-fixes` | Returns, credit notes (given back on cancel), staff pay, staff rights on reports / expenses / cost price |
| `gst`, `purchases`, `loyalty`, `textile` | GST reports (GSTR-1/3B, HSN), purchases & supplier payments, loyalty points (expiry runs once), textile designs & stickers |
| `tracking`, `events`, `costs`, `menu-cache`, `feed-note` | Order tracking & notifications, live-update rules (shop isolation, rights), the change feed, caches that save database reads |
| `business`, `core`, `ops`, `multidb`, `admin-export`, `admin-usage`, `support-whatsapp`, `logo`, `livepatch` | Settings, stock, expenses, one database per shop + migrations, admin & export, usage report, support, shop logo, live list updates |
| `feature-release`, `module-off`, `module-guards`, `shop-types` | Release flags (QR Orders, Daily Specials, GST report, Single device), modules switched off, every shop type's set-up |
| `orders-page`, `payments-page`, `products-page`, `purchases-page`, `purchases-many`, `paging` | Screens that load page by page (orders, payments, catalogue, purchases) |
| `reports-sql`, `inventory-week`, `daily-jobs`, `discount`, `design-batch`, `create-customer`, `change-password`, `passwords`, `plans`, `dbkv` | Fast reports, daily jobs, category discounts, textile designs, new shops, passwords, prices, the shared cache |

**0.4 Check the app builds** (no errors):

```bash
npm run typecheck
```

```bash
npm --prefix backend run build
```

Both must finish without `error`. (`npm --prefix backend run build` may print two `"import.meta"` warnings — those are
normal.)

**0.5 Make the server zips** (the web app zip is made later, in Step 8):

```bash
rm -f api.zip daily.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .)
```

You now have `api.zip` and `daily.zip` in the project folder.

## Step 1 — Create the Catalyst project (10 min)

1. Open **https://console.catalyst.zoho.in** (India data centre — your shops and the database are in India, so bills are
   faster). Sign in with the **new** Zoho account.
2. **Create Project** → name it, e.g. `kadai-kalanjiyam` → choose **India** if asked.
3. Open the project. Use the **Production** environment (switcher at the top). If Catalyst makes you set up
   Development first and then "Deploy to Production", that's fine — just make sure every environment variable below is
   also set in **Production**.
4. Catalyst **Cache** is **not** used on this setup (it's billed per request; the API keeps its shared cache in Turso),
   so nothing to set up there.

## Step 2 — Turso database (15 min)

Open **https://app.turso.tech** and sign in (create an account if new).

1. **Group:** Groups → **Create group** → name `kk-prod` → location **Mumbai (aws-ap-south-1)**. → value #5.
2. **Platform database:** Databases → **Create database** → name `kk-prod-platform` → group `kk-prod`.
   Copy its URL `libsql://kk-prod-platform-<org>.aws-ap-south-1.turso.io` → value #1.
3. **Group token:** Groups → `kk-prod` → **Create Token** → **Full access**, **no expiry** → copy → value #2.
   ⚠️ It must be the **group** token (not a database token) — otherwise creating a shop fails.
4. **API token:** Settings → **API Tokens** → **Create** (organisation-wide, or scoped to `kk-prod`) → copy → value #3.
5. **Organisation name:** shown in the dashboard address `app.turso.tech/<org>` → value #4.
6. **Plan:** Settings → Billing → **Developer** (or higher) — this gives point-in-time restore (your backup).
7. Decide the shop database prefix, e.g. `kk` → value #6.

Tokens are shown only once — save them right away.

## Step 3 — Generate the secrets (your computer, 5 min)

Run this **three times** — one new value each for the required `AUTH_SECRET` (#7), `SETUP_KEY` (#8) and
`SECRETS_KEY` (#9). Run it a **fourth time** if you also use the recommended `PASSWORD_PEPPER` (#20):

```bash
openssl rand -hex 32
```

**Optional — notifications ("Notify me" on the order tracking page):** in the project folder run

```bash
npm --prefix backend run vapid
```

It prints `VAPID_PUBLIC_KEY=…` (#13) and `VAPID_PRIVATE_KEY=…` (#14). Skip it and the tracking page shows **Refresh** only.

## Step 4 — Photo storage: Stratus (5 min)

1. Catalyst console → **Cloud Scale → Stratus → Create Bucket**.
2. Name, e.g. `kk-media` → value #10.
3. Allow **public read** for objects (photos and logos are shown in the app and on the QR menu).
4. Copy the bucket URL → value #11.

## Step 5 — The `api` function (15 min)

1. **Serverless → Functions → Create Function**
   - Type **Advanced I/O**, name **`api`** (exactly), stack **Node.js 18**.
   - Upload **`api.zip`** (from the project folder).
2. Open **Functions → api** and copy its address, ending in `/server/api`, e.g.
   `https://kadai-kalanjiyam-1234567.catalystserverless.in/server/api` → this is your **API URL**.
   (In Production it has **no** `development` in it.)
3. **Configuration → Environment Variables** — add these **required** ones (the API doesn't work without them):

| Name | Value |
|---|---|
| `AUTH_SECRET` | #7 |
| `SETUP_KEY` | #8 |
| `SECRETS_KEY` | #9 |
| `TURSO_PLATFORM_URL` | #1 |
| `TURSO_AUTH_TOKEN` | #2 |
| `TURSO_API_TOKEN` | #3 |
| `TURSO_ORG` | #4 |
| `TURSO_GROUP` | #5 (e.g. `kk-prod`) |
| `STRATUS_BUCKET` | #10 |
| `STRATUS_PUBLIC_URL` | #11 |

   `ALLOWED_ORIGINS` (#12) is also required — you add it in Step 8, once the web app has its address.

   **Optional** (add only if you want them; everything works without):

| Name | Value | For |
|---|---|---|
| `TURSO_DB_PREFIX` | #6 (e.g. `kk`) | Shop database names (`kk-shop-1`…); default `bp` |
| `PASSWORD_PEPPER` | #20 | Extra password security (recommended) — **never change or remove it later** |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | #13, #14, #15 | "Notify me" on the order tracking page |

4. **Memory: 128 MB** (function settings → Memory). The app is small; 128 MB halves the function cost. Step 7.4
   checks the speed — if "20 bills at the same time" takes more than ~5 seconds, set it back to 256 MB.
5. **Save** and **Deploy**.

## Step 6 — The `daily` function (5 min)

1. **Functions → Create Function** → type **Cron**, name **`daily`**, stack **Node.js 18** → upload **`daily.zip`**.
2. **Environment Variables:** add these **required** ones, with the **same** values as on `api`:

| Name | Value |
|---|---|
| `SECRETS_KEY` | #9 |
| `TURSO_PLATFORM_URL` | #1 |
| `TURSO_AUTH_TOKEN` | #2 |
| `TURSO_API_TOKEN` | #3 |
| `TURSO_ORG` | #4 |
| `TURSO_GROUP` | #5 |

   Nothing else is needed on `daily` (it makes no sign-ins, photos or web calls).
3. **Memory: 128 MB**, then **Save** and **Deploy**.
4. **Cloud Scale → Triggers → Cron → Create:** every day at **09:00**, time zone **Asia/Kolkata**, target function **`daily`**.
   (Renewal reminders, expiring loyalty points, clean-ups.)

## Step 7 — Check the API, create the tables and the first admin (20 min)

Replace `<api-url>` with your API URL (Step 5) and `<SETUP_KEY>` with value #8. Run the commands on your computer
(Mac / Linux Terminal). Windows PowerShell versions are given too.

### 7.1 Health check

```bash
curl -s <api-url>/health
```

✔ Expected: `{"ok":true,"version":"1.0.0","handlers":177}`
✘ No answer / error page → the `api` function isn't deployed, or the URL is wrong (it must end in `/server/api`).

### 7.2 Create the database tables

```bash
curl -s <api-url>/schema-check -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: `"ok": true` (the platform tables are created by this first call).
✘ `Not allowed` → `SETUP_KEY` on the function is missing, shorter than 16 characters, or different from what you typed.

```bash
curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: a list of databases brought up to date (only the platform database at this point; it includes the small
`kv_cache` table the API uses as its shared cache — no Catalyst Cache is used on this setup).

### 7.3 Create the first product admin (one time only)

The **product admin** is you — the Kadai Kalanjiyam owner. This login creates customers (shops), renews
subscriptions and sees support tickets. It is **not** a shop login.

Choose:
- **Name** — e.g. `Karthick`
- **Username** — 4 to 30 characters: small letters, numbers, `.` `-` `_` (e.g. `kk.admin`)
- **Password** — at least 6 characters (use **12+** with letters, numbers and symbols). Save it in your password manager.

**Mac / Linux:**

```bash
curl -s -X POST <api-url>/rpc/admin.setup -H "content-type: application/json" -d '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

**Windows PowerShell:**

```powershell
Invoke-RestMethod -Method Post -Uri "<api-url>/rpc/admin.setup" -ContentType "application/json" -Body '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

✔ Expected: `{"data":{"id":"1","username":"<admin username>"}}`

| Error message | Meaning / fix |
|---|---|
| `Setup is not allowed` | Wrong `SETUP_KEY`, or it isn't set (16+ characters) on the `api` function. |
| `Setup is already done` | A first admin already exists — sign in with it. (Setup works only once, so nobody can make a second "first admin" later.) |
| `Username: 4–30 letters, numbers…` | Change the username (small letters, numbers, `.` `-` `_`). |
| `Password must be at least 6 characters` | Use a longer password. |

**Then:**
1. Open `https://<slate-address>/#/admin/login` (after Step 8) and sign in with this username and password.
2. **More admins** (accounts / support staff): **Admin → Team → Add admin** — give each person their own login and the
   right role (super, manager, support). Never share the first admin's password.
3. The password was typed in the command, so close that Terminal window afterwards and don't share your screen while
   running it.

### 7.4 Smoke test on the live server (recommended, 2 min)

This runs real test cases **against the deployed API**. It signs in as the product admin, creates a throw-away test
shop (with its own Turso database), and checks:

- sign-in, settings save, a product with opening stock
- bills get the next number, stock goes down, stock can't go below zero
- **two bills at the same time** never get the same number
- **20 bills from 20 counters at the same time** (prints the time taken)
- report totals, the change feed
- deleting the test shop removes its database, and its owner can't sign in afterwards

```bash
node backend/scripts/smoke.mjs --url <api-url> --admin <admin username> --password <admin password> --setup-key <SETUP_KEY>
```

✔ Expected: every line starts with `✔`, and the last line is `20 passed, 0 failed`. In India the "20 bills at the same
time" line should take well under a few seconds.
✘ Any `✘` line → don't give it to shops yet. Common causes: wrong Turso tokens (`create test customer` fails), or
`TURSO_GROUP` / `TURSO_ORG` wrong.

The test shop is deleted at the end; in Turso you may briefly see a `kk-shop-…` database appear and disappear.

## Step 8 — The web app on Slate (15 min)

The web app has the API URL built in, so it must be built **now**, after Step 5.

1. In the project folder, copy `.env.prod.example` to **`.env.prod`** and set:
   ```
   VITE_BACKEND=catalyst
   VITE_API_BASE=<api-url>
   VITE_ROUTER=hash
   VITE_CONTACT_WHATSAPP=917013905970
   ```
   (`VITE_API_BASE` = your API URL from Step 5, ending in `/server/api`.)
2. Build and zip:
   ```bash
   npm run build:prod
   ```
   ```bash
   rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
   ```
3. Catalyst console → **Slate → Create App → Upload** `web-prod.zip` → **Deploy**.
4. Copy the Slate address, e.g. `https://web-xxxx.onslate.in` → value #12.
5. **Allow the web app to call the API:**
   - **Functions → api → Environment Variables:** add `ALLOWED_ORIGINS` = the Slate address (no `/` at the end).
     Save and deploy. (Not needed on `daily`.)
   - **Cloud Scale → Authentication → Whitelisting → Authorized Domains:** add the Slate address and turn on **CORS**.
6. **Custom domain (optional):** Slate → your app → **Domains** → add e.g. `app.kadaikalanjiyam.in`, add the DNS records it
   shows at your domain provider, then add that address to `ALLOWED_ORIGINS` too (comma-separated).

## Step 9 — Turn on the features (Admin → Features, 5 min)

Sign in at `https://<slate-address>/#/admin/login` → **Features**. On a new setup these start **Off** for everyone —
a customer sees a feature only once it is on for them:

| Feature | What the customer gets | Suggested |
|---|---|---|
| **QR Orders** | QR Ordering module, QR Orders screen, customer QR menu and order tracking | **All customers** (or **Selected** for food / restaurant shops) |
| **Daily Specials & offers display** | Daily Specials module, offer prices in billing / QR menu, TV display | **All customers** (or **Selected**) |
| **GST report** | GST returns tab in Reports | **All customers** |
| **Single device (no background sync)** | Screens stop checking every 30–60 s for other devices' changes (only while QR ordering is off) — fewer Catalyst calls | **Off**; turn it on per customer (customer page) for one-counter shops |
| **WhatsApp integration** | Settings → Integrations | **Off** (sending is still simulated) |

Press **Save** on each card you change. The same switches are on every customer's page (**Admin → Customers →** the
shop **→ Features**). A shop's own module choices are kept: turning a feature off and on again brings them back.

## Step 10 — First real check (15 min)

1. Open `https://<slate-address>/#/admin/login` → sign in as the product admin (Step 7.3).
2. **Admin → Customers → Create customer** (a test shop first). In Turso, a database `kk-shop-1` appears in `kk-prod`.
3. Open `https://<slate-address>/#/login` → sign in as that shop's owner → finish the setup → add items → make a bill.
4. Check:
   - [ ] Bill and **print** on a real thermal printer.
   - [ ] Tap **Collect** twice fast → only **one** bill.
   - [ ] **KOT** → shows on **Kitchen**.
   - [ ] **Settings → Business Profile → Shop logo** upload → shows in the top bar.
   - [ ] **QR menu** on a phone → place an order → it appears in **QR Orders** (within ~30 s) → **Track order** with the
         order number; accept it on the counter → the tracking page updates by itself within ~30 s.
   - [ ] **Admin → Features → QR Orders → Off** for this shop → QR Orders disappears from its menu and the QR menu says
         "Online ordering is off"; turn it back on → it returns.
   - [ ] A **Cashier** login: billing works; Reports/Expenses are hidden.
   - [ ] Phone and tablet layout.
   - [ ] Admin page shows the shop, its usage and the audit log.

## Step 11 — Before giving it to customers

| Item | What to do |
|---|---|
| Old test tokens / passwords | Not used here — but delete old Turso tokens that were shared earlier. |
| WhatsApp | Still **simulated** → keep it **off** in Admin → Features for real shops. |
| Features | QR Orders / Daily Specials / GST report on for the shops that should have them (Step 9). |
| Backups | Turso Developer plan with point-in-time restore (Step 2.6). Restore steps: "Backups and restoring a shop" below. |
| Terms & Privacy | Pages are at `/#/terms` and `/#/privacy`. Have a lawyer check them; add your legal entity name. |
| UPI | The payment QR is a placeholder — confirm UPI payments manually. |
| Pilot | 1–2 friendly shops for 2–4 weeks; check their bills, stock and payments daily for the first week. |

---

## Later: updating this setup

0. Run the test cases first (Step 0.3) — all must pass.
1. Build new zips (project folder):
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
2. Upload `api.zip` → api, `daily.zip` → daily, `web-prod.zip` → Slate. Then on each shop screen: refresh the browser
   once (or close and reopen the app) so it loads the new version.
3. If the release has a new migration:
   ```bash
   curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```
4. Keep the previous zips in a dated folder to roll back.

## Backups and restoring a shop

**What protects the data today**
- **Turso point-in-time restore** (the main backup): every database — the platform one and each shop's — can be restored to
  any moment within your Turso plan's retention window (check it in the Turso dashboard; upgrade the plan if it's too short).
- **The shop's own export** (Settings → Audit & Data → Download, or Admin → customer → Export): Excel or ZIP. For a very big
  shop, lists with more than 20,000 rows hold only the newest 20,000 — the file then has a **"Read me"** sheet saying which.
  An export is a copy for the shop, **not** a restorable backup.
- **Product photos** (Catalyst Stratus) are not backed up separately. Keep the bucket's versioning on if your plan offers it.

**Restore one shop's database (e.g. a wrong bulk change at 3 PM)**
1. Turso dashboard → the shop's database (`<prefix>-shop-<id>`, e.g. `kk-shop-1`; see the platform table `shop_databases.db_url`) → **Restore / branch
   from a point in time** → pick a time just before the problem. This creates a **new** database with a new URL.
2. Create a token for the new database (Turso → database → Create token, full access).
3. Encrypt the new token the way the API stores it (same `SECRETS_KEY` as the api function), on your computer:
   ```bash
   SECRETS_KEY='<SECRETS_KEY>' node backend/scripts/encrypt-secret.mjs '<new token>'
   ```
   It prints `v1:…`. Then point the shop at the new database — Turso shell, **platform** database:
   `UPDATE shop_databases SET db_url = '<new libsql url>', db_token = '<the v1:… value>' WHERE business_id = <shop id>;`
   Never paste tokens or the SECRETS_KEY in chat or email.
4. Restart the `api` function (Catalyst console → Functions → api → redeploy the same zip): warm instances keep the old
   connection open until they restart.
5. Open the shop in the app and check the latest bills. Keep the old database for a few days, then delete it.

**Restore the platform database** (logins, shop list, subscriptions): restore it in the same group (step 1), then set
`TURSO_PLATFORM_URL` to the new database's URL on **both** `api` and `daily` and redeploy both. The group token
(`TURSO_AUTH_TOKEN`) keeps working for a database in the same group — no other change.

**Not built yet:** an automatic nightly copy of every shop to Stratus (independent of Turso). Add it if the Turso retention
window is shorter than you need.

## If something goes wrong

| Problem | Fix |
|---|---|
| `/health` fails | Function not deployed, or wrong zip. Re-upload `api.zip` and deploy. |
| "Server is not configured (AUTH_SECRET)" | `AUTH_SECRET` missing or shorter than 32 characters on `api`. |
| Login page says it can't reach the server | `VITE_API_BASE` wrong in `.env.prod` (rebuild `web-prod.zip`), or `ALLOWED_ORIGINS` / Authorized Domains missing the Slate address. |
| Creating a customer fails: "refused TURSO_AUTH_TOKEN" | `TURSO_AUTH_TOKEN` is a database token — create a **group** token (Step 2.3). |
| Creating a customer fails: Turso API error | `TURSO_API_TOKEN`, `TURSO_ORG` or `TURSO_GROUP` wrong. |
| Photos / logo don't upload | `STRATUS_BUCKET` / `STRATUS_PUBLIC_URL` wrong, or bucket not public-read. |
| A shop has no QR Orders / Daily Specials / GST returns | The feature is off for it: **Admin → Features** (Step 9) — and the shop's own module must be on (Settings → Modules). |
| Another device's change shows late | Normal on Catalyst: Billing, Tables, Kitchen, QR orders and Take Order check every 30 s, other screens every 60 s (only while the screen is in use). |
| Wrong change in a shop's data | Turso point-in-time restore — "Backups and restoring a shop" above. |
