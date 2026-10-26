# Kadai Kalanjiyam — deploy this release, step by step

Release: branch `release/kadai-kalanjiyam`, commit `bcac956` (25 Oct 2026).
All steps are in the **Catalyst console** (no command-line tools needed on the server side).

**Zips (project folder):**

| Zip | Goes to | Needed? |
|---|---|---|
| `api.zip` | Functions → `api` (Advanced I/O) | Yes |
| `daily.zip` | Functions → `daily` (Cron) | Yes |
| `web-prod.zip` | Slate → web app | Yes |
| `events.zip` | AppSail → `events` | Optional (live updates) |

Previous zips for rollback: `previous-zips-2026-10-21/`.

Replace `<api-url>` below with your API address, e.g. `https://billpoodum-60091831475.development.catalystserverless.in/server/api`.

---

## Step 0 — Before you start (5 min)

- [ ] **Which environment?** `web-prod.zip` currently calls the **development** API
      (`billpoodum-…development.catalystserverless.in`), from your `.env.prod`. If you are deploying to the
      **Production** environment, put the production API address in `.env.prod` and rebuild `web-prod.zip` first:
      ```bash
      npm run build:prod
      ```
      ```bash
      rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
      ```
- [ ] **Backup point:** note the time now. If anything goes wrong, Turso can restore every database to this moment
      (Turso dashboard → database → Restore from a point in time).
- [ ] Pick a quiet time (no shop billing), e.g. after closing.

## Step 1 — Change the secrets that were shared earlier (10 min)

These values were pasted in chat earlier, so replace them. **Never paste the new ones in chat or email.**

1. **Turso token:** Turso dashboard → your group → **Tokens** → create a new group token → copy it.
   Then delete the old token.
2. **SETUP_KEY:** make a new random value (24+ characters).
3. **Admin password:** sign in at `/#/admin/login` → change your admin password (after Step 4, or now if the app is up).

You'll put the new token and SETUP_KEY in the `api` function in Step 2.

## Step 2 — Update the `api` function (10 min)

1. Catalyst console → **Serverless → Functions → `api`** → **Upload** `api.zip` (replace the code).
2. **Configuration → Environment variables:** check / update these:

| Variable | Value |
|---|---|
| `TURSO_AUTH_TOKEN` | the **new** group token from Step 1 |
| `SETUP_KEY` | the **new** value from Step 1 |
| `AUTH_SECRET` | keep as is (changing it signs everyone out) |
| `SECRETS_KEY` | keep as is (never change) |
| `TURSO_PLATFORM_URL`, `TURSO_ORG`, `TURSO_API_TOKEN`, `TURSO_GROUP` | keep as is |
| `STRATUS_BUCKET`, `STRATUS_PUBLIC_URL`, `ALLOWED_ORIGINS` | keep as is |

3. **Optional — order-tracking notifications ("Notify me"):** on your computer run
   ```bash
   npm --prefix backend run vapid
   ```
   and add the two printed values plus a contact:

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | printed value |
| `VAPID_PRIVATE_KEY` | printed value (secret — never share) |
| `VAPID_SUBJECT` | `mailto:KadaiKalanjiyam@gmail.com` |

   Skip this and the tracking page simply shows **Refresh** only.
4. **Memory: 128 MB** (function settings → Memory) — halves the function cost. If bills feel slow, set it back to 256 MB.
5. **Save** and **Deploy** the function.

## Step 3 — Update the `daily` function (3 min)

1. **Functions → `daily`** → **Upload** `daily.zip`.
2. Environment variables: if you changed `TURSO_AUTH_TOKEN` in Step 2, change it here too (same value).
3. **Memory: 128 MB**, then **Save** and **Deploy**.
4. Check the cron is still there: **Cloud Scale → Triggers → Cron** → every day **09:00**, **Asia/Kolkata**, target `daily`.

## Step 4 — Database update (2 min)

This release adds two migrations: `0006_order_tracking` (shop databases: an index and a table for notifications) and
`0003_kv_cache` (platform database: a small shared-cache table — the API no longer uses Catalyst Cache on Turso, which
saves money).

1. Health check — should print `{"ok":true,…}`:
   ```bash
   curl -s <api-url>/health
   ```
2. Run the migration on every database once (use the **new** SETUP_KEY):
   ```bash
   curl -s -X POST <api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```
   It should list the databases as updated. (Shops also update by themselves on their first request — this just makes it
   happen now, before anyone bills.)

## Step 5 — Update the web app on Slate (3 min)

1. Catalyst console → **Slate** → your web app → **Upload** `web-prod.zip` → **Deploy**.
2. Open the app in the browser and press **Ctrl+Shift+R** (hard refresh). You should see the new **shop-front logo**
   and the name **Kadai Kalanjiyam**.

## Step 6 — Optional: live updates (event hub on AppSail) — only from about 15 shops (15 min)

**Skip this for now.** AppSail runs all the time (about $13 a month). Without it, urgent screens (Kitchen, QR orders,
Tables, Billing) check every 30 s and other screens every 60 s — almost free. Add it at about 15+ shops.

1. Catalyst console → **AppSail** → **Create app** → Node.js 18 → name `events` → upload `events.zip`.
   - Start command: `node index.js`
   - **Instances: min 1, max 1** (important — the hub keeps open screens in memory)
   - Memory: 256 MB
2. AppSail **environment variables**:

| Variable | Value |
|---|---|
| `AUTH_SECRET` | **same** as the `api` function |
| `EVENTS_SECRET` | a new random value, 32+ characters |
| `ALLOWED_ORIGINS` | **same** as the `api` function |

3. Deploy it and copy its URL (e.g. `https://events-xxxx.catalystappsail.in`). Check it:
   ```bash
   curl -s <events-url>/health
   ```
   → `{"ok":true,"boot":"…","clients":0}`
4. Go back to **Functions → `api`** → environment variables → add:

| Variable | Value |
|---|---|
| `EVENTS_URL` | the AppSail URL |
| `EVENTS_PUBLIC_URL` | the same AppSail URL |
| `EVENTS_SECRET` | the **same** value as on AppSail |

5. Save and **Deploy** the `api` function again.
6. Test: open **Kitchen** on one device and bill a KOT item on another — the ticket should appear within 1–2 seconds.
   If it doesn't, the screens still update the old way (every 30 s); check the AppSail logs.

## Step 7 — Check everything works (15 min)

Use a test shop (or your own) — not a customer's shop.

- [ ] **Sign in** as the shop owner. Logo and name are new.
- [ ] **Bill:** add an item → **Collect**. Tap Collect fast twice — only **one** bill is made (Orders shows it once).
- [ ] **Print** the receipt on the thermal printer.
- [ ] **KOT:** a dine-in / takeaway order with **KOT** → appears on **Kitchen**.
- [ ] **QR order:** scan the table / shop QR on a phone → place an order → it shows in **QR Orders** with the chime.
- [ ] **Track my order:** on the phone, **Track order** → enter the order number → status shows. Accept it on the
      counter → tap **Refresh status** (or it updates by itself with live updates on).
- [ ] **Cancel** a bill → stock comes back; if it was paid with a credit note, the note gets its credit back.
- [ ] **Staff rights:** sign in as a **Cashier** → billing works; **Reports / Expenses** are not shown, and product
      cost price is not visible.
- [ ] **Dashboard** and **Reports** load for the owner.
- [ ] **Settings → Business Profile → Shop logo:** upload a logo → it shows in the top bar and on the QR menu.
- [ ] **Export:** Settings → Audit & Data → Download (Excel) works.

## Step 8 — Tell the shops

- Each counter, Kitchen and tablet screen: **refresh the browser once** (or close and reopen the app) so it loads the
  new version.
- The keyboard shortcut **F9** is removed. Use the **Collect / Pay** button (or **Ctrl+Enter** on the tile billing screen).
- WhatsApp sending is still **simulated** — keep it off in Admin → Features for real shops.

---

## If something goes wrong (rollback)

1. **App broken after upload:** upload the old zips from `previous-zips-2026-10-21/` to the same places
   (`api.zip`, `daily.zip`, `web-prod.zip`) and deploy. The new database index/table from Step 4 is harmless to the
   old version — no database rollback needed.
2. **Data problem (wrong bulk change):** Turso point-in-time restore — see **"Backups and restoring a shop"** in
   `server/catalyst/PRODUCTION.md`.
3. **Live updates misbehaving:** remove `EVENTS_URL`, `EVENTS_PUBLIC_URL`, `EVENTS_SECRET` from the `api` function and
   deploy — screens go back to the old 30 s updates. You can stop the AppSail app.
4. **Notifications misbehaving:** remove the `VAPID_*` variables and deploy — the tracking page shows Refresh only.

## Quick reference

| What | Where |
|---|---|
| All settings explained | `server/catalyst/DEPLOY.md` |
| First-time production setup, backups, restore | `server/catalyst/PRODUCTION.md` |
| Demo accounts (mock only) | `DEMO_ACCOUNTS.md` |
| Code on GitHub | branch `release/kadai-kalanjiyam` |
