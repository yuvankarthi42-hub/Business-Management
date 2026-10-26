# Kadai Kalanjiyam — full deployment on a NEW account (from zero)

Release: branch `release/kadai-kalanjiyam`, commit `bcac956`.
This guide sets up everything fresh: a new **Zoho Catalyst** project, a new **Turso** database group, photo storage,
the API, the daily job, the web app and (optionally) live updates and notifications. Nothing is copied from the old
test setup — production starts empty.

```
Shops' phones / PCs / tablets
        │
        ▼
Slate (web app)  ──►  Catalyst function "api"  ──►  Turso: 1 platform database + 1 database per shop (Mumbai)
                      Catalyst function "daily" (Cron 09:00)
                      Catalyst Stratus (photos, logos)
                      AppSail "events" (optional: live updates)
```

**Time needed:** about 2–2½ hours the first time (including running the tests).

---

## Part A — Keys and values you will collect (fill this in as you go)

Keep this list in a **password manager**. Never paste these in chat, email or Git.

| # | Name | What it is | Where you get it | Goes into |
|---|---|---|---|---|
| 1 | `TURSO_PLATFORM_URL` | Platform database address (`libsql://…`) | Turso, Step 2.2 | api, daily |
| 2 | `TURSO_AUTH_TOKEN` | **Group** token (full access) | Turso, Step 2.3 | api, daily |
| 3 | `TURSO_API_TOKEN` | Turso API token (creates a database for each new shop) | Turso, Step 2.4 | api, daily |
| 4 | `TURSO_ORG` | Your Turso organisation name | Turso, Step 2.5 | api, daily |
| 5 | `TURSO_GROUP` | Group name, e.g. `kk-prod` | You choose, Step 2.1 | api, daily |
| 6 | `TURSO_DB_PREFIX` | Name prefix for shop databases, e.g. `kk` → `kk-shop-1` | You choose | api, daily |
| 7 | `AUTH_SECRET` | Signs every login (random, 64 hex) | Generate, Step 3 | api, daily, AppSail |
| 8 | `SETUP_KEY` | For setup/migrations/first admin (random) | Generate, Step 3 | api, daily |
| 9 | `SECRETS_KEY` | Encrypts WhatsApp tokens (random). **Never change later** | Generate, Step 3 | api, daily |
| 10 | `STRATUS_BUCKET` | Photo bucket name, e.g. `kk-media` | You choose, Step 4 | api, daily |
| 11 | `STRATUS_PUBLIC_URL` | Bucket's public address | Catalyst, Step 4 | api, daily |
| 12 | `ALLOWED_ORIGINS` | Web app address (Slate URL) | Catalyst, Step 8 | api, daily, AppSail |
| 13 | `VAPID_PUBLIC_KEY` | Notifications public key | Generate, Step 3 (optional) | api |
| 14 | `VAPID_PRIVATE_KEY` | Notifications private key (secret) | Generate, Step 3 (optional) | api |
| 15 | `VAPID_SUBJECT` | `mailto:KadaiKalanjiyam@gmail.com` | — (optional) | api |
| 16 | `EVENTS_SECRET` | Shared secret between api and the event hub (random) | Generate, Step 3 (optional) | api, AppSail |
| 17 | `EVENTS_URL` | Event hub address | AppSail, Step 10 (optional) | api |
| 18 | `EVENTS_PUBLIC_URL` | Same event hub address | AppSail, Step 10 (optional) | api |
| 19 | Admin username + password | The first product-admin login | You choose, Step 7.3 | (not a variable) |

Not needed in this setup: `CRON_KEY`, `CATALYST_TZ_OFFSET_MIN`, `TURSO_LOCATION` (leave them unset).

---

## Step 0 — Run all the test cases on your computer first (15 min)

Deploy only a build whose tests all pass. Do this on the computer that has the project folder.

**0.1 Requirements (once):** Node.js **18 or newer** (check with `node -v`).

**0.2 Install the packages** (project folder):

```bash
npm install
```

```bash
npm --prefix backend install
```

**0.3 Run the backend test cases** — 20 test files, each run on 3 database types (real SQLite, Turso's network
protocol, and the in-memory store like Catalyst's Data Store):

```bash
npm run backend:test
```

It takes a few minutes. At the end you must see this **three times** (one per database type):

```
# pass 20
# fail 0
```

Any `not ok` or `# fail 1` (or more) → **do not deploy**; send the lines starting with `not ok` to your developer.

What the test cases cover (backend/test/):

| Test file | Checks |
|---|---|
| `billing`, `counter`, `save-once` | Bills, KOT, QR orders, discounts and price changes need rights, a bill saved only once (double tap / dropped connection) |
| `returns-staff`, `high-fixes` | Returns, credit notes (given back on cancel), staff pay, staff rights on reports / expenses / cost price |
| `gst`, `purchases`, `loyalty`, `textile` | GST reports (GSTR-1/3B, HSN), purchases & supplier payments, loyalty points (expiry runs once), textile designs & stickers |
| `tracking`, `events`, `costs` | Order tracking & notifications, live updates (shop isolation, rights), caches that save database reads |
| `business`, `core`, `ops`, `multidb`, `admin-export`, `support-whatsapp`, `logo`, `livepatch` | Settings, stock, expenses, one database per shop + migrations, admin & export, support, shop logo, live list updates |

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
rm -f api.zip daily.zip events.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .) && (cd catalyst/appsail/events && zip -qr ../../../events.zip .)
```

You now have `api.zip`, `daily.zip` and `events.zip` in the project folder.

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

Run this **four times** — one new value each for `AUTH_SECRET` (#7), `SETUP_KEY` (#8), `SECRETS_KEY` (#9) and
`EVENTS_SECRET` (#16):

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
3. **Configuration → Environment Variables** — add:

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
| `TURSO_DB_PREFIX` | #6 (e.g. `kk`) |
| `STRATUS_BUCKET` | #10 |
| `STRATUS_PUBLIC_URL` | #11 |
| `ALLOWED_ORIGINS` | leave empty for now — filled in Step 8 |
| `VAPID_PUBLIC_KEY` | #13 (optional) |
| `VAPID_PRIVATE_KEY` | #14 (optional) |
| `VAPID_SUBJECT` | `mailto:KadaiKalanjiyam@gmail.com` (optional) |

4. **Memory: 128 MB** (function settings → Memory). The app is small; 128 MB halves the function cost. Step 7.4
   checks the speed — if "20 bills at the same time" takes more than ~5 seconds, set it back to 256 MB.
5. **Save** and **Deploy**.

## Step 6 — The `daily` function (5 min)

1. **Functions → Create Function** → type **Cron**, name **`daily`**, stack **Node.js 18** → upload **`daily.zip`**.
2. **Environment Variables:** add the **same** values as `api` for: `AUTH_SECRET`, `SETUP_KEY`, `SECRETS_KEY`,
   `TURSO_PLATFORM_URL`, `TURSO_AUTH_TOKEN`, `TURSO_API_TOKEN`, `TURSO_ORG`, `TURSO_GROUP`, `TURSO_DB_PREFIX`,
   `STRATUS_BUCKET`, `STRATUS_PUBLIC_URL`. (The `VAPID_*` and `EVENTS_*` ones are not needed here.)
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

✔ Expected: `{"ok":true,"version":"1.0.0","handlers":17x}`
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

✔ Expected: every line starts with `✔`, and the last line is `N passed, 0 failed`. In India the "20 bills at the same
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
   - **Functions → api → Environment Variables:** set `ALLOWED_ORIGINS` = the Slate address (no `/` at the end).
     Save and deploy. Do the same on **daily**.
   - **Cloud Scale → Authentication → Whitelisting → Authorized Domains:** add the Slate address and turn on **CORS**.
6. **Custom domain (optional):** Slate → your app → **Domains** → add e.g. `app.kadaikalanjiyam.in`, add the DNS records it
   shows at your domain provider, then add that address to `ALLOWED_ORIGINS` too (comma-separated).

## Step 9 — First real check (15 min)

1. Open `https://<slate-address>/#/admin/login` → sign in as the product admin (Step 7.3).
2. **Admin → Customers → Create customer** (a test shop first). In Turso, a database `kk-shop-1` appears in `kk-prod`.
3. Open `https://<slate-address>/#/login` → sign in as that shop's owner → finish the setup → add items → make a bill.
4. Check:
   - [ ] Bill and **print** on a real thermal printer.
   - [ ] Tap **Collect** twice fast → only **one** bill.
   - [ ] **KOT** → shows on **Kitchen**.
   - [ ] **Settings → Business Profile → Shop logo** upload → shows in the top bar.
   - [ ] **QR menu** on a phone → place an order → it appears in **QR Orders** → **Track order** with the order number.
   - [ ] A **Cashier** login: billing works; Reports/Expenses are hidden.
   - [ ] Phone and tablet layout.
   - [ ] Admin page shows the shop, its usage and the audit log.

## Step 10 — Optional: live updates (event hub on AppSail) — only from about 15 shops (15 min)

**Skip this for now.** AppSail runs all the time (about $13 a month). Without it, urgent screens (Kitchen, QR orders,
Tables, Billing) check for changes every 30 s and other screens every 60 s, which costs almost nothing. Add it when you
have about 15+ shops: screens then update within a second.

1. Catalyst console → **AppSail → Create App** → **Node.js 18** → name `events` → upload **`events.zip`**.
   - Start command: `node index.js`
   - **Instances: minimum 1, maximum 1** (required — the hub keeps open screens in memory)
   - Memory: 256 MB
2. AppSail **Environment Variables:**

| Name | Value |
|---|---|
| `AUTH_SECRET` | #7 (same as api) |
| `EVENTS_SECRET` | #16 |
| `ALLOWED_ORIGINS` | #12 (same as api) |

3. Deploy and copy the AppSail address (e.g. `https://events-xxxx.catalystappsail.in`). Check:
   ```bash
   curl -s <events-address>/health
   ```
   → `{"ok":true,"boot":"…","clients":0}`
4. **Functions → api → Environment Variables:** add

| Name | Value |
|---|---|
| `EVENTS_URL` | the AppSail address (#17) |
| `EVENTS_PUBLIC_URL` | the same AppSail address (#18) |
| `EVENTS_SECRET` | #16 (same as AppSail) |

   Save and deploy `api`.
5. Test: open **Kitchen** on one device, make a KOT on another → the ticket appears within 1–2 seconds.
   If not, screens still update every 30 s — check the AppSail logs.

## Step 11 — Before giving it to customers

| Item | What to do |
|---|---|
| Old test tokens / passwords | Not used here — but delete old Turso tokens that were shared earlier. |
| WhatsApp | Still **simulated** → keep it **off** in Admin → Features for real shops. |
| Backups | Turso Developer plan with point-in-time restore (Step 2.6). Restore steps: `server/catalyst/PRODUCTION.md` → "Backups and restoring a shop". |
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
   rm -f api.zip daily.zip events.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .) && (cd catalyst/appsail/events && zip -qr ../../../events.zip .)
   ```
   ```bash
   npm run build:prod
   ```
   ```bash
   rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
   ```
2. Upload `api.zip` → api, `daily.zip` → daily, `web-prod.zip` → Slate, (`events.zip` → AppSail if used).
3. If the release has a new migration:
   ```bash
   curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```
4. Keep the previous zips in a dated folder to roll back.

## If something goes wrong

| Problem | Fix |
|---|---|
| `/health` fails | Function not deployed, or wrong zip. Re-upload `api.zip` and deploy. |
| "Server is not configured (AUTH_SECRET)" | `AUTH_SECRET` missing or shorter than 32 characters on `api`. |
| Login page says it can't reach the server | `VITE_API_BASE` wrong in `.env.prod` (rebuild `web-prod.zip`), or `ALLOWED_ORIGINS` / Authorized Domains missing the Slate address. |
| Creating a customer fails: "refused TURSO_AUTH_TOKEN" | `TURSO_AUTH_TOKEN` is a database token — create a **group** token (Step 2.3). |
| Creating a customer fails: Turso API error | `TURSO_API_TOKEN`, `TURSO_ORG` or `TURSO_GROUP` wrong. |
| Photos / logo don't upload | `STRATUS_BUCKET` / `STRATUS_PUBLIC_URL` wrong, or bucket not public-read. |
| Live updates not working | Check AppSail is running (1 instance), `EVENTS_*` on api, same `EVENTS_SECRET` and `AUTH_SECRET` on both. Remove the `EVENTS_*` variables to switch it off. |
| Wrong change in a shop's data | Turso point-in-time restore — `server/catalyst/PRODUCTION.md` → "Backups and restoring a shop". |
