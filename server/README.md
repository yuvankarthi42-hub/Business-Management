# Moving from mock data to MySQL

The frontend never touches storage directly. Every screen calls `api.*` from `src/data/index.ts`,
which today points at the mock implementation in `src/data/api.ts` (in-memory DB persisted to
`localStorage`). To go live:

1. **Create the database** — `mysql -u root -p billpoodum < server/schema.sql`.
2. **Build a REST server** (Node + Express/Fastify + `mysql2`, or any stack) with one endpoint per
   `api` method. Suggested mapping:

   | Mock call | HTTP |
   |---|---|
   | `api.auth.login(id, pw)` | `POST /auth/login` → JWT |
   | `api.auth.me()` | `GET /me` |
   | `api.business.update(patch)` | `PATCH /business` |
   | `api.products.list()` / `.save(p)` | `GET /products` / `PUT /products/:id` |
   | `api.orders.save(draft, {sendToKitchen})` | `POST /orders` (or `PUT /orders/:id`) |
   | `api.orders.checkout(draft, pays)` | `POST /orders/checkout` |
   | `api.orders.settle(id, pays)` | `POST /orders/:id/settle` |
   | `api.orders.cancel(id, reason)` | `POST /orders/:id/cancel` |
   | `api.kitchen.setStatus(id, s)` | `PATCH /kitchen-tickets/:id` |
   | `api.customers.collectDue(id, amt, m)` | `POST /customers/:id/collect` |
   | `api.reports.summary(from, to)` | `GET /reports/summary?from&to` |

3. **Port the business rules** that live in the mock API — they are the spec:
   - `src/core/pricing.ts` — totals, proportional discount, inclusive/exclusive tax, round-off.
     The server must recompute totals; never trust totals sent by the client.
   - `settle()` — invoice numbering (`sequences` row with `SELECT … FOR UPDATE`), payments,
     credit balance requires a customer, stock deduction, all in **one transaction**.
   - `cancel()` — void payments, return stock, cancel KOTs. Never `DELETE` financial rows.
   - `collectDue()` — FIFO allocation of a due payment across the oldest unpaid bills.
   - `requirePerm()` — enforce role permissions on the server for every write.
4. **Write `src/data/http.ts`** exporting an object with the same shape as `Api`
   (`export type Api = typeof api`) that calls `fetch`, then switch the export in
   `src/data/index.ts`. TypeScript will flag any missing method.
5. **Photos** — the mock stores product/category photos as small JPEG data URLs
   (`src/lib/image.ts` crops to 320×320). On the server, accept an upload
   (`POST /uploads` → S3 / disk), store the returned URL in `image_url`, and keep the
   same client-side resize so phones don't upload 5 MB pictures.
6. **Branches** — every transactional row has `branch_id`. Port `scope()` / `here()` /
   `writeBranch()` from `src/data/api.ts`: reads are limited to the branches a user may open
   (`user_branches`, owner = all); "All branches" is read-only; writes need one branch.
   Per-branch bill series live on `branches.invoice_prefix / next_invoice_number`.
7. **Phone numbers** — every API that accepts a mobile number must run it through the same
   rules as `src/core/phone.ts` (`normalizePhone` → E.164, per-country length check) and
   store the E.164 string. Uniqueness (staff login, customer per business) compares E.164.
   Clients send E.164 from the country-code picker; bare national numbers fall back to the
   business's `default_country`.
8. **Live updates** — the mock notifies screens via `subscribe()`. Replace with polling,
   SSE or WebSockets (kitchen display + tables benefit most).

Seed data for testing lives in `src/data/seed.ts` and can be exported to SQL inserts if needed.


## Product admin & customer accounts

- `/api/admin/*` uses its **own** login and JWT audience (`platform_admins`); a customer token can never call it.
- There is no public sign-up endpoint. `POST /api/admin/customers` creates the business, its main branch, default roles and
  the owner user (`users.username`) in one transaction.
- **Every** customer request goes through middleware that loads the business and:
  - rejects the request (and the login) when `status = 'deactivated'`;
  - when `sub_end_at < NOW()`, allows only `GET` (plus logout and the user's own language) and answers writes with
    `403 { code: 'READ_ONLY' }`. Do this on the server — hiding buttons is not enough.
- Creating a branch checks `COUNT(branches) < max_branches` inside the same transaction (`SELECT … FOR UPDATE`).
- Every query is scoped by the `business_id` from the token, never from the request body.
- Write an `admin_audit_logs` row for create, password reset, renew/extend, branch-limit change, (de)activation and delete.
- Permanent delete removes all rows of the business (FK `ON DELETE CASCADE`) after the admin types the business name.
- Admin roles (`platform_admins.role`): **super** = everything; **manager** = no delete, team or pricing; **support** = view,
  renew / extend and support view. Check the role on every `/api/admin/*` route (see `src/core/adminRoles.ts`).
- **Support view**: `POST /api/admin/customers/:id/support { reason }` issues a short-lived customer token marked
  `support: true` (+ admin id). The read-only middleware rejects every write for such tokens, and start / end are written to
  `admin_audit_logs`. It must not update `users.last_login_at`.

## Feature flags & WhatsApp integration

- `feature_flags` / `feature_flag_customers`: return the customer's enabled features in `/api/me`; every feature endpoint
  checks the flag again (WhatsApp routes answer `403 FEATURE_OFF` when it's off).
- WhatsApp uses the **Meta WhatsApp Cloud API** with the customer's own number and token (Meta bills the customer, not us).
  - Connect: store the access token encrypted (`access_token_enc`), return only `token_last4`.
  - Test: `GET https://graph.facebook.com/v20.0/{phone_number_id}?fields=verified_name,display_phone_number,quality_rating`.
  - Templates: `POST /{waba_id}/message_templates` (name, language, category, components). Map `{{customer_name}}`… to
    `{{1}}`… in order; image header for offers, document header for bills. Sync status with `GET /{waba_id}/message_templates`
    or the `message_template_status_update` webhook.
  - Send: `POST /{phone_number_id}/messages` with `type: template`. Upload the bill PDF / poster via `/{phone_number_id}/media`.
  - Webhook `/api/whatsapp/webhook`: verify the `X-Hub-Signature-256`, update `whatsapp_messages.status`
    (sent → delivered → read / failed), record opt-outs (customer replies STOP) into `customers.marketing_opt_in = 0`.
- Offers go only to customers with `marketing_opt_in = 1`; at most one offer per customer per day.
- The mock in `src/data/api.ts` (`whatsapp.*`) simulates all of this; `src/core/whatsapp.ts` has the template rules to reuse.

## Product import (CSV)

- `POST /api/products/import { items, onExisting: 'skip' | 'update', fileName }` — the browser parses the CSV (papaparse) and
  sends structured rows; the server re-runs the checks in `src/core/productImport.ts` and saves everything in **one**
  transaction (insert in batches of 500). Up to 5,000 rows per request.
- Existing items match by barcode, otherwise by name (case-insensitive) within the business. Updates never change stock —
  opening stock is only for new items and goes through `stock_movements` (+ `stock_batches` when expiry is tracked).
- Unknown categories are created. Write one audit row with the counts and file name.

## Image uploads (compressed on the server)

- `POST /api/uploads` (multipart) → `{ url, thumbUrl, bytes, width, height, quality, format }`. The screens send the
  **original** photo; nothing is compressed in the browser.
- Same pipeline as the mock in `src/data/media.ts`, with [`sharp`](https://sharp.pixelplumbing.com/):
  1. Reject files over 50 MB, check the real type from the first bytes (JPEG, PNG, WebP, GIF, HEIC/AVIF), and
     `limitInputPixels: 200_000_000` (sharp streams the decode, so large photos stay within memory) against decompression bombs.
  2. `.rotate()` (EXIF orientation), drop all metadata (EXIF / GPS), longest side ≤ 800 px (`fit: 'inside'`).
  3. WebP: binary search on quality (92 → 40) for the highest quality with `size ≤ 51,200 bytes`; if quality 40 is still
     too big, try 640 / 512 / 400 / 320 / 240 px.
  4. Thumbnail 320 px (≤ 16 KB) for lists and billing tiles.
  5. Save both to object storage (`<business>/products/<id>.webp`), insert `media_files`, return the URLs.
- `PUT /api/products` and `/api/categories` only accept image URLs from `/api/uploads`; a CSV photo link is downloaded on the
  server and run through the same pipeline (the mock keeps the link if the site blocks downloads from the browser).

## Returns, credit notes & price lists

- `POST /api/returns { orderId, lines: [{itemId, qty, restock}], reason, note, settle: 'refund' | 'credit_note', method }` —
  one transaction: check qty ≤ sold − already returned, value each line at the price actually paid (incl. tax and the
  bill's discount share, rounded to the rupee when round-off is on), take it off the bill's **due first**, then refund
  (`payments.kind = 'refund'`) or issue a credit note (`sale_returns.credit_remaining`, number from `sequences`). Restocked
  lines add `stock_movements` reason `return` (back into their batch when batches are tracked).
- A credit note is spent as a payment with `method = 'credit_note'`; lock the `sale_returns` row (`SELECT … FOR UPDATE`)
  and reduce `credit_remaining`. Reports: net sales = sales − returns; credit-note payments aren't new money received.
- Price list: `customers.price_tier = 'wholesale'` makes billing use `products.wholesale_price` (falls back to retail).
  The server re-prices every line from the DB — never trust prices sent from the browser.

## Staff attendance & salary

- `PUT /api/attendance/:userId/:day` (no future dates), `POST /api/attendance/mark-all`.
- `GET /api/payroll?month=2026-10` computes: monthly pay ÷ days in month × days worked (half day = ½, leave = paid
  only if set), or daily rate × days; commission = % of that staff member's net sales (bills they created minus returns);
  minus open advances. `POST /api/salaries` writes `salary_payments` + an expense and marks the advances settled.

## Renewal reminders (daily job)

- A cron job at 09:00 IST: for every active business whose plan ends in ≤ `daysBefore` days (default 7) and not paused,
  send one WhatsApp **per day** from the platform's own WhatsApp number (approved `utility` template) — `reminder_log`
  makes it idempotent if the job re-runs. Failures are logged and retried once. Nothing is sent until Admin → WhatsApp
  is connected, tested and the template is approved (`platform_settings` key `whatsapp`; token in a secrets table,
  encrypted). The admin Renewals page lists expiring / expired customers and can send now or pause per customer.

## Support tickets

- `POST /api/support/tickets` (multipart screenshots; same image pipeline, 1600 px / 200 KB), `POST /…/:id/messages`.
  Read-only (expired) accounts can still create tickets. Notify the support team (email / WhatsApp) on new tickets
  and urgent priority; notify the customer when the team replies.

## Customer data export

- `GET /api/admin/customers/:id/export?format=xlsx|zip` (permission `customers.edit`, audit `export`) and
  `GET /api/export` for the owner. Stream it: one sheet / CSV per table, image files in the ZIP, a README; never include
  password hashes, sessions or WhatsApp tokens. Large exports → a background job that emails a link valid for 24 h.

## Errors & performance

- No health table. Use Catalyst DevOps: **APM** (function errors, response time, slowest calls), **Logs** (7 days in
  development, 14 in production) and **Metrics** (API calls per day by method, rows added per table).

## Printer setup per branch

- `PUT /api/branches/:id/printer` (permission `settings.manage` or `billing.create`, and access to that branch) saves
  `branches.printer`. Printing a bill uses the bill's branch. Which physical printer a device is paired with (WebUSB /
  Web Serial / Bluetooth permission) can only live in that browser, so it stays in localStorage, per branch.
