# BillPoodum — Configurable Business Management & POS

One platform that adapts to the business using it: common core (products, customers, orders,
payments, expenses), optional modules (tables, kitchen, inventory, mobile ordering…), and
configurable terminology ("Product" → "Menu Item", "Customer" → "Guest").

Two ways to run the same app:

| | Data | Start |
|---|---|---|
| **Demo app** (default) | in this browser, with demo shops and demo logins | `npm run dev` |
| **Zoho Catalyst** | the real backend in [`backend/`](backend/README.md) — Data Store, Cache, Stratus | `npm run dev:catalyst` (+ `npm --prefix backend run dev` locally) |

Catalyst: database design in [server/catalyst/schema.sql](server/catalyst/schema.sql) ·
[TABLES.md](server/catalyst/TABLES.md) (what each table is for) · deployment in
[server/catalyst/DEPLOY.md](server/catalyst/DEPLOY.md). On Catalyst there are no demo logins — the product admin
creates every customer.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 and use a **demo account** on the login page (all accounts: [DEMO_ACCOUNTS.md](DEMO_ACCOUNTS.md)) (Owner, Manager,
Cashier, Waiter, Kitchen Staff — each sees only what their role allows). Demo business:
*Food Corner* (restaurant + fast food) with ~30 days of history. Reset any time from
**Settings → Audit & Data**.

## What’s inside

| Area | Screen |
|---|---|
| Owner | Dashboard (today vs yesterday, payment split, top items, live orders, low stock), Reports (daily income, sales, items, customers, inventory, CSV export) |
| Cashier | Fast billing: search / barcode + Enter, categories, popular items, variants & add-ons, discount, cash / UPI / card / split / credit, receipt print / PDF / share / WhatsApp. Keys: `F2` search, `F9` collect, `F8` more options |
| Waiter | Mobile order taking (`/m/order`, PWA-ready), table grid, add to running orders, send KOT |
| Restaurant | Tables (status, transfer, merge, bill, cancel), Kitchen display (New → Preparing → Ready → Served, elapsed time) |
| Customers (no login) | QR menu `/q/<businessId>` (`?t=<tableId>` for dine-in): specials, cart, contact details, live order tracking. TV board `/display/<businessId>` |
| Specials & QR | Daily Specials (per date, offer price, tag, copy previous day), QR Orders inbox with sound alert, accept/reject, printable table QR codes, auto-accept setting |
| Branches | Branch switcher (one branch or All branches), combined dashboard with branch comparison, per-branch bills (AD-, VL-), tables, kitchen, stock and QR codes, staff branch access |
| Back office | Menu items (variants, add-ons, tax, units, veg flag, KOT flag), Inventory (purchase, wastage, damage, adjustments, history), Customers (credit, outstanding, collect dues), Payments, Expenses |
| Batch & expiry | Track batch & expiry per item (milk, curd, bread, medicines); expiry required on stock-in; sold first-expiry-first-out; Inventory → Expiry tab (expired / 7 / 30 days) with write-off; dashboard alert; billing warns on expired stock |
| Barcode labels | Products → Print labels: pick items and counts, 50×25 / 38×25 mm rolls or A4 65-up sheets, shop name, price, MRP, barcode (EAN-13 / Code 128), packed & best-before dates; creates in-store barcodes (20…) for items without one |
| Printer | Settings → Printer (per branch — each branch has its own setup, shared by its counters; the paired USB / Bluetooth printer is remembered per device): print dialog, or direct ESC/POS over USB (WebUSB), Serial/COM (Web Serial) or Bluetooth (Web Bluetooth) in Chrome/Edge; auto-print after payment, copies, paper cut, cash drawer on cash bills; text mode or image mode (prints Tamil names); falls back to the print dialog on errors |
| Product admin | `/admin`: all customers (status, validity, branch usage, registered date) with search and filters; create customer + owner login (no public sign-up); reset password; 1 / 2 / 6 / 12 months or custom validity, renew / extend with history and price; branch limit (price = branches × months × rate); activate / deactivate; permanent delete with typed confirmation; audit log. Admin team with roles (super / manager / support); read-only **View as customer** support view (logged with reason); Usage report (billing in 7 / 30 days, last bill, last login, monthly subscription revenue). Expired accounts are read-only: write buttons are disabled and the API refuses writes |
| Photos | Upload any JPG / PNG / WebP / GIF (HEIC where the browser supports it) up to 50 MB / 200 megapixels. The upload API compresses it before storing: upright, metadata removed, ≤ 800 px, WebP at the highest quality that fits **≤ 50 KB** (smaller sizes if needed), plus a 320 px thumbnail for lists. Save APIs re-check so nothing larger is ever stored |
| Import | Products → **Import** and sign-up Items step → **Import from CSV**: upload (sample CSV per business type), auto-matched columns for every Add-form field (name, price, category, MRP, cost, barcode, SKU, unit, GST, veg, sizes `Half:120 \| Full:200`, add-ons, stock, low-stock, batch & expiry, KOT, service, photo URL, active), row checks with errors / warnings and in-place fixes, choose rows, skip or update existing items (barcode, else name), one-transaction import, download rows not imported |
| WhatsApp | Released per customer by the product admin (**Features** page: off / selected / all). Settings → Integrations → WhatsApp Business: 4-step setup (enable, connect Meta Cloud API account, test, templates — ready-made offer sample + bill template editor with Meta's rules and live preview), auto-send bill, message log with sent / delivered / read. "Send on WhatsApp" on bills and Orders, "Send offer" on Customers appear only when connected and the template is approved. Demo mode: Meta calls are simulated |
| Language | English / தமிழ் for the whole app (user menu or sign-in screen), saved per user. Add a language with one dictionary file in `src/i18n/` (see `ta.ts`). Bills stay in English |
| Returns | Orders → **Return / exchange**: pick items and qty, restock or damaged, reason; value comes off the bill's due first, then refund (cash / UPI / card) or a **credit note** (CN-1001) that can be used to pay a later bill — "Start exchange bill" opens billing with it. Stock goes back into its batch; reports show net sales after returns |
| Price lists | Retail shops can turn on a second price list (Settings → Billing, e.g. "Contractor rate"): wholesale price per item / size, customer price list, billing switches automatically for those customers (or by the toggle) |
| Staff | **Staff** page: daily attendance (present / half day / absent / leave), monthly summary, pay (monthly or daily) with sales commission %, advances, salary payment with slip — booked as expenses |
| Help & support | User menu → Help & support: report a problem with screenshots (capture this screen or attach), category & urgency, conversation with the team. Admin **Support** inbox with status, priority, assignee and reply |
| Renewals | Admin **Renewals**: expiring (next 14 days) and expired lists; WhatsApp reminder every day from 7 days before the end (pause per customer, send now), reminder log. Admin **WhatsApp**: connect BillPoodum's own WhatsApp Business number (Meta Cloud API), test, reminder template with Meta's rules, preview and approval. Demo mode logs instead of sending |
| Data export | Admin customer page and Settings → Audit & data: full data as **Excel** (one sheet per table) or **ZIP** (CSVs + photos + README), without passwords — offered before a delete |
| Setup | Sign-up → 6-step onboarding, Settings: profile, billing & tax, terminology, modules, staff & roles (permission matrix), tables, audit log |

## Structure

```
src/core/      domain types, config (modules, templates, roles), pricing rules
src/data/      mock DB + seed + api (swap point for the real backend)
src/features/  shared POS building blocks (cart, catalog grid, payment, receipt)
src/pages/     one file per screen
server/        MySQL schema + migration notes
```
