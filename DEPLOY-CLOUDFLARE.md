# Kadai Kalanjiyam — deploy on Cloudflare + Turso (account 2)

Release: branch `main`, commit `9582b96` (final test 16 Nov 2026). Package: **`cloudflare.zip`** in the project folder.

This is a **separate setup** from Catalyst (account 1 — see `DEPLOY-NEW-ACCOUNT.md`). It has its own Turso org, its own
buckets, its own secrets and its own product admin. The two never share data, logins or files.

```
Shops' phones / PCs / tablets
        │
        ▼
Worker "kk-api"  (one address: the web app  +  the API under /server/api)
   ├─ Turso org 2: 1 platform database + 1 database per shop
   ├─ R2 "kk-media" (public photos, logos)   ·   R2 "kk-media-private" (support screenshots, signed links only)
   ├─ Durable Object ShopHub (live updates over WebSocket — no timed checks)
   └─ Cron every hour (daily jobs, one batch per run; reminders once a day from 09:00 IST)
```

**What is in `cloudflare.zip`** (folder `kk-cloudflare/`):

| File | What it is |
|---|---|
| `dist-worker/worker.js` | The API (already built) |
| `web/` | The web app (already built; it calls `/server/api` on its own address, so no address is built in) |
| `wrangler.toml` | All settings, ready — you only change the lines marked **FILL** |
| `DEPLOY.md` | Short version of this guide |

**Time needed:** about 1½ hours the first time.

---

## Part A — Values you will collect

| # | Value | From |
|---|---|---|
| 1 | Turso platform database URL (`libsql://…`) | Step 2 |
| 2 | Turso group token | Step 2 |
| 3 | Turso API token | Step 2 |
| 4 | Turso organisation name | Step 2 |
| 5 | Turso group name | Step 2 |
| 6 | `AUTH_SECRET` | Step 3 |
| 7 | `SETUP_KEY` | Step 3 |
| 8 | `SECRETS_KEY` | Step 3 |
| 9 | `PASSWORD_PEPPER` (recommended) | Step 3 |
| 10 | R2 public domain (e.g. `https://media.yourdomain.com`) | Step 4 |
| 11 | Worker address (e.g. `https://kk-api.<you>.workers.dev`) | Step 6 |

Keep these in your password manager. **Never reuse the Catalyst (account 1) values.**

---

## Step 1 — Cloudflare account and plan (5 min)

1. Sign in at **https://dash.cloudflare.com** (create an account if new).
2. **Workers & Pages → Plans → Workers Paid** ($5 a month). The Free plan stops any request over 10 ms of CPU, and large
   shops (maligai) need more; Paid allows 30 s.
3. **Workers & Pages → Overview:** note your `workers.dev` subdomain (e.g. `karthick`). Your address will be
   `https://kk-api.<subdomain>.workers.dev` → value #11.

## Step 2 — Turso org 2 (15 min)

Open **https://app.turso.tech**. Use a **new organisation** (never the one Catalyst uses).

1. **Group:** Groups → **Create group** → e.g. `kk-cf` → location **Mumbai (aws-ap-south-1)** → value #5.
2. **Platform database:** Databases → **Create database** → e.g. `kk-cf-platform` → group `kk-cf`.
   Copy its URL `libsql://kk-cf-platform-<org>.aws-ap-south-1.turso.io` → value #1.
3. **Group token:** Groups → `kk-cf` → **Create Token** → **Full access**, **no expiry** → value #2.
   ⚠️ It must be the **group** token, otherwise creating a shop fails.
4. **API token:** Settings → **API Tokens** → **Create** → value #3.
5. **Organisation name:** in the address `app.turso.tech/<org>` → value #4.
6. **Plan:** Developer (or higher) for point-in-time restore (backups).

## Step 3 — Secrets (your computer, 5 min)

Run this once for each of #6, #7, #8 and #9 (a new value each time):

```bash
openssl rand -hex 32
```

**Optional — "Notify me" on the order tracking page:** in the project folder:

```bash
npm --prefix backend run vapid
```

It prints `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Without them the tracking page shows **Refresh** only.

## Step 4 — R2 buckets (10 min)

Cloudflare dashboard → **R2 Object Storage**:

1. **Create bucket** `kk-media` (public photos and logos) → **Settings → Custom Domains → Connect Domain**
   (e.g. `media.yourdomain.com`; the domain must be on this Cloudflare account) → value #10.
2. **Create bucket** `kk-media-private` (support screenshots) → **no** custom domain, **Public access / r2.dev: off**.
   Only the API reads it, through links that stop working after 30–60 minutes.

Use exactly these two names (they are in `wrangler.toml`), or change them there too.

## Step 5 — Fill in the settings (5 min)

1. Unzip `cloudflare.zip` → folder `kk-cloudflare/`.
2. Open `kk-cloudflare/wrangler.toml` and change the lines marked **FILL**:

| Line | Set to |
|---|---|
| `R2_PUBLIC_URL` | #10 |
| `LIVE_URL` | `wss://kk-api.<subdomain>.workers.dev/server/api/live` (from #11, with `wss://`) |
| `TURSO_PLATFORM_URL` | #1 |
| `TURSO_ORG` | #4 |
| `TURSO_GROUP` | #5 (e.g. `kk-cf`) |

   Leave the rest as it is. `ACCOUNT_ID = "cf-1"` marks this setup: a Worker pointed at another setup's database refuses
   every request, and another setup's tokens and file links are refused.
3. **Own domain (optional):** to use e.g. `app.yourdomain.com` instead of `workers.dev`, uncomment the `routes` line
   and use that domain in `LIVE_URL` too.

## Step 6 — Deploy the Worker (15 min)

Needs **Node.js 20+** on your computer. In a terminal, inside the `kk-cloudflare` folder:

1. Sign in to Cloudflare (opens the browser once):
   ```bash
   npx wrangler login
   ```
2. Add the secrets — run each line, paste the value when asked:
   ```bash
   npx wrangler secret put AUTH_SECRET
   ```
   ```bash
   npx wrangler secret put SETUP_KEY
   ```
   ```bash
   npx wrangler secret put SECRETS_KEY
   ```
   ```bash
   npx wrangler secret put PASSWORD_PEPPER
   ```
   ```bash
   npx wrangler secret put TURSO_AUTH_TOKEN
   ```
   ```bash
   npx wrangler secret put TURSO_API_TOKEN
   ```
   Values: #6, #7, #8, #9, #2 (group token), #3. Optional: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
   `VAPID_SUBJECT` (e.g. `mailto:you@yourdomain.com`).
   ⚠️ `PASSWORD_PEPPER` must **never change or be removed** later, or every password stops working.
3. **Check it on your computer first** (one time, before the first deploy):
   ```bash
   npx wrangler dev
   ```
   Open the address it prints (e.g. `http://localhost:8787`). You can't sign in yet (no admin); check that the app
   opens and `http://localhost:8787/server/api/health` answers `"ok":true`. Stop it with **Ctrl+C**.
4. Deploy:
   ```bash
   npx wrangler deploy
   ```
   ✔ It prints the Worker address (#11) and the hourly cron.

## Step 7 — Tables, first admin, checks (20 min)

`<api-url>` = `https://kk-api.<subdomain>.workers.dev/server/api` · `<SETUP_KEY>` = #7.

### 7.1 Health check

```bash
curl -s <api-url>/health
```

✔ Expected: `{"ok":true,…}`

### 7.2 Create the database tables

```bash
curl -s <api-url>/schema-check -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: `"ok": true`

```bash
curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
```

✔ Expected: the platform database brought up to date.

### 7.3 First product admin (one time only)

```bash
curl -s -X POST <api-url>/rpc/admin.setup -H "content-type: application/json" -d '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

✔ Expected: `{"data":{"id":"1","username":"<admin username>"}}`
Use a **new** admin password (not the Catalyst one). Close the terminal window afterwards.

### 7.4 Smoke test on the live Worker (2 min)

From the **project folder** (not `kk-cloudflare`):

```bash
node backend/scripts/smoke.mjs --url <api-url> --admin <admin username> --password <admin password> --setup-key <SETUP_KEY>
```

✔ Expected: every line starts with `✔`, last line `20 passed, 0 failed`. It makes a throw-away test shop and deletes it.

### 7.5 Visitor address check (1 min)

```bash
curl -s <api-url>/ip-check -H "x-setup-key: <SETUP_KEY>" -H "X-Forwarded-For: 1.2.3.4"
```

✔ Expected: `"ip"` is **your own internet address** (compare with https://ifconfig.me), never `1.2.3.4`.

## Step 8 — Turn on the features (5 min)

Open `https://kk-api.<subdomain>.workers.dev/admin/login` → sign in as the product admin → **Features**
(same table as Step 9 of `DEPLOY-NEW-ACCOUNT.md`). Keep **WhatsApp** off (sending is still simulated).
**Single device** isn't needed on Cloudflare — live updates come over WebSocket, with no timed checks.

## Step 9 — First real check (15 min)

1. **Admin → Customers → Create customer** (a test shop). A `bp-shop-…` database appears in Turso org 2.
2. Open `https://kk-api.<subdomain>.workers.dev/login` → sign in as that shop's owner → setup → items → a bill.
3. Check:
   - [ ] Bill and **print** on a real thermal printer; **Collect** tapped twice → only one bill.
   - [ ] **KOT** → appears on **Kitchen** at once on a second device (live update).
   - [ ] Shop logo / product photo upload → shows (R2 public bucket).
   - [ ] **Support** ticket with a screenshot → the admin can open it (R2 private bucket).
   - [ ] **QR menu** on a phone → order → appears in **QR Orders** at once → **Track order** updates by itself.
   - [ ] A **Cashier** login: billing works; Reports / Expenses hidden.
   - [ ] Next day: Cloudflare → Workers → kk-api → **Logs / Cron** shows the hourly runs without errors.

## Step 10 — Before giving it to customers

| Item | What to do |
|---|---|
| Plan | **Workers Paid** on (Step 1). |
| Backups | Turso Developer plan with point-in-time restore (Step 2.6). |
| Free-tier size | Turso free: about 36 small shops, or 3 hotels, or 1 large shop — then Turso needs a paid plan. |
| WhatsApp | Keep **off** (simulated). |
| Pilot | 1–2 friendly shops for 2–4 weeks; check bills, stock and payments daily in the first week. |

---

## Later: updating this setup

1. Build the new package (project folder):
   ```bash
   npm --prefix backend run build:cloudflare
   ```
   ```bash
   VITE_BACKEND=catalyst VITE_API_BASE=/server/api VITE_CONTACT_WHATSAPP=917013905970 npm run build:cloudflare
   ```
2. In your `kk-cloudflare/` folder (keep your filled `wrangler.toml`): replace `dist-worker/worker.js` with
   `backend/dist-worker/worker.js`, and the `web/` folder with `dist-cloudflare/`.
3. Deploy and update the tables:
   ```bash
   npx wrangler deploy
   ```
   ```bash
   curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```
4. Each shop screen: refresh once (or close and reopen the app).
5. To roll back: `npx wrangler rollback` (goes back to the previous Worker version).

**Every release:** deploy **both** setups (Catalyst and Cloudflare) and run `/migrate` on **both** APIs.

## If something goes wrong

| Problem | Fix |
|---|---|
| `wrangler deploy` says the R2 bucket doesn't exist | Create `kk-media` and `kk-media-private` (Step 4), names exactly as in `wrangler.toml`. |
| `/health` works but sign-in says "Can't reach the database" | `TURSO_PLATFORM_URL` / `TURSO_AUTH_TOKEN` wrong — the token must be the **group** token. |
| Creating a customer fails | `TURSO_API_TOKEN`, `TURSO_ORG` or `TURSO_GROUP` wrong. |
| Every request refused after pointing at another database | `ACCOUNT_ID` doesn't match the one stored in that platform database — use this setup's own Turso org. |
| Other devices don't update at once | `LIVE_URL` wrong (must be `wss://<your address>/server/api/live`). Without it the app still works, just without live updates. |
| Photos don't show | `R2_PUBLIC_URL` wrong, or the custom domain on `kk-media` isn't active yet. |
| See the errors | Cloudflare → Workers → kk-api → **Logs** (or `npx wrangler tail`). |
