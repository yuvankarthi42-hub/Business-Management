# Production deployment — step by step

This guide moves Kadai Kalanjiyam from the **test** setup (Catalyst *development* environment) to **production**, for real
customers. All steps are done in the browser consoles (Catalyst, Turso, Slate). Only the build commands run on your computer.

The test setup stays as it is, so you can keep using it for trying changes. Production gets its **own** Catalyst
environment, its **own** Turso group and databases, and its **own** secrets. Nothing from the test data is copied:
production starts empty.

```
Customers' phones / PCs
        │
        ▼
Slate (web app, production)  ──►  Catalyst function "api" (production)  ──►  Turso: platform DB + one DB per shop
                                   Catalyst function "daily" (Cron 09:00)      (Mumbai)
                                   Catalyst Stratus (photos)
```

**Before you start, decide two things:**

| Decision | Recommended | Why |
|---|---|---|
| Catalyst data centre | **India** (`console.catalyst.zoho.in`, addresses end in `.catalystserverless.in`) | The test project is in the US (`.com`), while Turso and your customers are in India. Each database step then crosses the world twice, which makes bills slow. Put the function, the database and the customers in the same region. |
| Turso plan | **Developer** (or higher) | It keeps backups / point-in-time restore of the shops' money data. The free plan keeps very little. |

---

## Step 1 — Create the production Catalyst project (India)

1. Open **console.catalyst.zoho.in** and sign in.
2. Click **Create Project**, name it e.g. `billpoodum`, and choose **India** if a data-centre choice is shown.
3. Open the project. You will work in its **Production** environment (environment switcher at the top of the console).
   - If Catalyst asks you to deploy to Development first and then "Deploy to Production", do that. The steps below are
     the same in both environments. Just make sure the **environment variables (Step 4.3) are set in Production**.

> Staying in the existing US project instead? Use its **Production** environment and continue the same way. It works,
> but bills will be slower for Indian customers.

## Step 2 — Turso: production group, database and tokens

Use the Turso dashboard: **app.turso.tech**.

1. **Group:** go to **Groups → Create group**.
   - Name it `billpoodum-prod`.
   - Location: **Mumbai (aws-ap-south-1)**.
2. **Platform database:** go to **Databases → Create database**.
   - Name it `bp-prod-platform`.
   - Group: **`billpoodum-prod`**.
   - Copy its URL (`libsql://bp-prod-platform-<org>.aws-ap-south-1.turso.io`). This is `TURSO_PLATFORM_URL`.
3. **Group token:** go to **Groups → `billpoodum-prod` → Create Token**.
   - Choose **full access** (read & write) and no expiry.
   - Copy it. This is `TURSO_AUTH_TOKEN`.
   - ⚠️ It must be a **group** token. A token made on a database page opens only that one database, and creating a
     customer then fails with "The new database refused TURSO_AUTH_TOKEN".
4. **API token:** go to **Settings → API Tokens → Create**.
   - Make it organisation-wide, or scoped to the group `billpoodum-prod`.
   - Copy it. This is `TURSO_API_TOKEN`. The API uses it to create a database for each new customer.
5. **Organisation name:** it is shown in the dashboard URL (`app.turso.tech/<org>`). This is `TURSO_ORG`.
6. **Plan:** under **Settings → Billing**, choose **Developer**, and check the backup / point-in-time restore setting.

Tokens are shown only once. Keep them in a password manager, and **never paste them in chat, email or Git**.

## Step 3 — Build the production files (your computer)

From the project folder:

**3.1 The API and the daily job**

```bash
npm --prefix backend install
```

```bash
npm run backend:build
```

```bash
cd catalyst/functions/api && npm install --omit=dev && cd ../daily && npm install --omit=dev && cd ../../..
```

```bash
rm -f api.zip daily.zip && (cd catalyst/functions/api && zip -qr ../../../api.zip .) && (cd catalyst/functions/daily && zip -qr ../../../daily.zip .)
```

This gives you `api.zip` and `daily.zip` in the project folder. The same files work for test and production: all
settings come from the environment variables.

**3.2 The web app (built after Step 4, once you know the production API URL)**: see Step 6.

## Step 4 — Catalyst: Stratus, functions and settings (Production environment)

### 4.1 Stratus (photos)

1. Go to **Cloud Scale → Stratus → Create Bucket**.
2. Name it `billpoodum-media`.
3. Allow **public read** for objects.
4. Copy the bucket URL. This is `STRATUS_PUBLIC_URL`.

### 4.2 Functions

1. Go to **Serverless → Functions → Create Function**.
   - Type **Advanced I/O**, name `api`, stack **Node.js 18**.
   - Upload `api.zip`.
2. Go to **Create Function** again.
   - Type **Cron**, name `daily`, stack **Node.js 18**.
   - Upload `daily.zip`.
3. Open **Functions → api** and copy its URL, ending in `/server/api`, e.g.
   `https://billpoodum-12345678.catalystserverless.in/server/api`. It has **no `development`** in it.

### 4.3 Environment variables

Open **Functions → api → Configuration → Environment Variables**. Add the variables below, then add **the same
values** on **daily**.

For the three secrets, run this on your computer **three times** and use a different value for each:

```bash
openssl rand -hex 32
```

| Name | Value |
|---|---|
| `AUTH_SECRET` | random value 1 — signs every login |
| `SETUP_KEY` | random value 2 — for schema-check, migrations and the first admin |
| `SECRETS_KEY` | random value 3 — encrypts WhatsApp tokens. **Never change it later.** |
| `TURSO_PLATFORM_URL` | from Step 2.2 |
| `TURSO_AUTH_TOKEN` | group token from Step 2.3 |
| `TURSO_API_TOKEN` | API token from Step 2.4 |
| `TURSO_ORG` | from Step 2.5 |
| `TURSO_GROUP` | `billpoodum-prod` |
| `TURSO_DB_PREFIX` | `prod`. Shop databases are then named `prod-shop-1`, `prod-shop-2`… and can never be mixed up with the test ones. |
| `STRATUS_BUCKET` | `billpoodum-media` |
| `STRATUS_PUBLIC_URL` | from Step 4.1 |
| `ALLOWED_ORIGINS` | the Slate URL. Fill this in after Step 6 (`.in` / `.com` twins are allowed automatically). |

Use **new** secrets for production, not the test ones. Then a test login can never open production.

## Step 5 — Check the database and create the first admin

**5.1 Health:** it should print `{"ok":true,…}`.

```bash
curl -s https://<prod-api-url>/health
```

**5.2 Schema check:** it should print `"ok": true` and `"tables": 17`. The platform tables are created by this first call.

```bash
curl -s https://<prod-api-url>/schema-check -H "x-setup-key: <SETUP_KEY>"
```

**5.3 First product admin:** this works only once. Use a strong password.

```bash
curl -s -X POST https://<prod-api-url>/rpc/admin.setup -H "content-type: application/json" -d '{"args":["<SETUP_KEY>",{"name":"<your name>","username":"<admin username>","password":"<admin password>"}]}'
```

**5.4 Smoke test (recommended).** It makes a throw-away shop with its own database, bills from 20 counters at once and
prints the time, then deletes the shop:

```bash
node backend/scripts/smoke.mjs --url https://<prod-api-url> --admin <admin username> --password <admin password> --setup-key <SETUP_KEY>
```

All steps should pass. In India the "20 bills at the same time" line should be well under a few seconds.

## Step 6 — Web app on Slate (production)

**6.1 Production settings.** Copy `.env.prod.example` to `.env.prod` and fill it in:

```
VITE_BACKEND=catalyst
VITE_API_BASE=https://<prod-api-url>
VITE_ROUTER=hash
VITE_CONTACT_WHATSAPP=91XXXXXXXXXX
```

`VITE_API_BASE` is the production URL from Step 4.2, ending in `/server/api`. The WhatsApp line is optional.

**6.2 Build and zip.**

```bash
npm run build:prod
```

```bash
rm -f web-prod.zip && (cd dist-prod && zip -qr ../web-prod.zip .)
```

`build:prod` uses `.env.prod` only, so a production build never points to the test API.

**6.3 Upload.**
1. In the Catalyst console (Production), go to **Slate → Create App → Upload**.
2. Upload `web-prod.zip`, then **Deploy**.
3. Copy the Slate URL (e.g. `https://web-xxxx.onslate.in`).

**6.4 Allow the app to call the API.**
1. Go to **Functions → api → Environment Variables**, set `ALLOWED_ORIGINS` to the Slate URL (no `/` at the end), and save.
2. Go to **Cloud Scale → Authentication → Whitelisting → Authorized Domains**, add the Slate URL, and turn on **CORS**.

**6.5 Custom domain (optional).** In **Slate → your app → Domains**, add e.g. `app.yourbrand.in`, and add the DNS records
it shows at your domain provider. Then put that address into `ALLOWED_ORIGINS` as well (comma-separated).

## Step 7 — Daily renewal reminders

Go to **Cloud Scale → Triggers → Cron → Create**:
- Every day at **09:00**
- Time zone **Asia/Kolkata**
- Target function **daily**

## Step 8 — First real check

1. Open `https://<slate-url>/#/admin/login` and sign in as the product admin.
2. Create your first customer. In Turso, the database `prod-shop-1` appears in the group `billpoodum-prod`.
3. Open `https://<slate-url>/#/login` and sign in as that shop's owner. Finish the setup steps, add a few items and
   make a bill.
4. Print a receipt on a real thermal printer, and check a phone and a tablet.
5. Open the admin page: the customer, the usage and the audit log should show the new shop.

## Step 9 — Before giving it to customers

| Item | Status |
|---|---|
| Tokens pasted in chat earlier (test setup) | Delete them in Turso and make new ones. Production uses only the new tokens from Step 2. |
| WhatsApp sending | Still **simulated** (messages are logged, not really sent). Keep the WhatsApp feature **off** in Admin → Features until the real Meta WhatsApp API is connected. |
| Backups | Turso Developer plan (or higher) with point-in-time restore turned on (Step 2.6). |
| Terms & Privacy | Publish them before you store other businesses' sales and customer phone numbers. |
| Product name | Decide the final name before printing anything. The code can be renamed in one go. |
| Pilot | Give it to 1–2 friendly shops for 2–4 weeks first, then start selling. |

---

## Updating production later

1. Test the change on the **test** setup first.
2. Run the backend tests:

   ```bash
   npm run backend:test
   ```

3. **API changed:** run Step 3.1 again, then upload the new `api.zip` / `daily.zip` to the **production** functions.
4. **Web app changed:** run Step 6.2 again, then upload the new `web-prod.zip` to the **production** Slate app.
   Browsers pick up the new version by themselves on their next visit.
5. **Table change** (new migration file): shop databases update themselves on their next request. To update all at once:

   ```bash
   curl -s -X POST https://<prod-api-url>/migrate -H "x-setup-key: <SETUP_KEY>"
   ```

**Going back:** keep the previous `api.zip`, `daily.zip` and `web-prod.zip` (for example in a dated folder). To undo an
update, upload the previous files again. The data stays as it is.

## Backups and restoring a shop

**What protects the data today**
- **Turso point-in-time restore** (the main backup): every database — the platform one and each shop's — can be restored to
  any moment within your Turso plan's retention window (check it in the Turso dashboard; upgrade the plan if it's too short).
- **The shop's own export** (Settings → Audit & Data → Download, or Admin → customer → Export): Excel or ZIP. For a very big
  shop, lists with more than 20,000 rows hold only the newest 20,000 — the file then has a **"Read me"** sheet saying which.
  An export is a copy for the shop, **not** a restorable backup.
- **Product photos** (Catalyst Stratus) are not backed up separately. Keep the bucket's versioning on if your plan offers it.

**Restore one shop's database (e.g. a wrong bulk change at 3 PM)**
1. Turso dashboard → the shop's database (`shop-<id>-…`, see the platform table `shop_databases.db_url`) → **Restore / branch
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

**Restore the platform database** (logins, shop list, subscriptions): the same steps with the platform database, then update
`TURSO_PLATFORM_URL` / `TURSO_PLATFORM_TOKEN` in the api and daily functions and redeploy both.

**Not built yet:** an automatic nightly copy of every shop to Stratus (independent of Turso). Add it if the Turso retention
window is shorter than you need.

## If something goes wrong

| What you see | What to check |
|---|---|
| `Couldn’t create the shop’s database — Turso refused the API token…` | `TURSO_API_TOKEN` (Step 2.4) |
| `… can’t find the organisation or group…` | `TURSO_ORG`, `TURSO_GROUP` |
| `… The new database refused TURSO_AUTH_TOKEN…` | `TURSO_AUTH_TOKEN` must be the **group** token (Step 2.3) |
| `token is not scoped to group …` (in the function log) | `TURSO_GROUP` must be the group your API token is allowed for |
| Sign-in shows a network error | `ALLOWED_ORIGINS` and Authorized Domains (Step 6.4) |
| Old screens after an update | Open the site once and press **Cmd/Ctrl + Shift + R** |
| Details of any error | **Catalyst → Functions → api → Logs** (look for the action name, e.g. `[createShop …]`) |
