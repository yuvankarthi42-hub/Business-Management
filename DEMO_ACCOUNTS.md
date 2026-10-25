# Demo accounts (mock data only)

All demo accounts use the password **`demo123`** (set in `src/data/seed.ts`, `src/data/seedRetail.ts` and `src/data/seedPlatform.ts`).
They exist only in the browser's mock database. The real backend must use proper passwords (bcrypt).

There is **no public sign-up**. The product admin creates each customer (business) and its owner login.
Everyone signs in with their **mobile number** (validated, with country code) and password; owners can also use the **username** the admin gave them
(Indian, **+91** — just type the 10 digits). On the login page you can also click any account under
**Try a demo business** instead of typing.

## 🛡️ Product admin — `/admin/login`

| Username | Role | What they can do |
|---|---|---|
| `admin` | Super admin | Everything: customers, create logins, reset passwords, validity, renew / extend, branch limits, activate / deactivate, permanent delete, support view, usage report, **admin team**, **pricing**, audit log |
| `manager` | Manager | Same as super admin **except** delete customers, admin team and pricing |
| `support` | Support | View customers, renew / extend, **View as customer** (read-only support view), usage report, audit log |

**WhatsApp integration** is off for everyone at first. Turn it on in Admin → **Features** (or on a customer's page),
then the customer sees Settings → **Integrations**. FreshMart already has a finished demo setup (connected, both templates
approved); turn the feature on for FreshMart to see the Send buttons straight away.

## Customer (owner) logins

| Business | Username | Subscription in the demo |
|---|---|---|
| Food Corner | `foodcorner` | Active · 1 year · 3 of 3 branches (limit reached) |
| FreshMart Supermarket | `freshmart` | Active · 6 months · 1 of 2 branches |
| Sri Murugan Hardware | `murugan` | Expires in a few days (warning banner) |
| Sweet Spot Bakery | `sweetspot` | **Expired → read-only** (renew it from the admin dashboard) |
| Kanchi Pattu Maaligai | `kanchisilks` | Active · 1 year |

## 🍔 Food Corner — Restaurant & Fast Food (3 branches)

| Name | Mobile (login) | Role | Branch |
|---|---|---|---|
| Karthick | 9876543210 | Owner | All branches |
| Priya | 9876500001 | Manager | T. Nagar, Adyar |
| Ravi | 9876500002 | Cashier | T. Nagar |
| Suresh | 9876500003 | Waiter | T. Nagar |
| Anbu | 9876500005 | Waiter | T. Nagar |
| Murugan | 9876500004 | Kitchen Staff | T. Nagar |
| Selvi | 9876500011 | Cashier | Adyar |
| Mani | 9876500012 | Waiter | Adyar |
| Deepak | 9876500013 | Cashier | Velachery |

Tables, kitchen display (KOT), waiter app, QR ordering, daily specials, multi-branch dashboard.

## 🧁 Sweet Spot Bakery & Café — Food · Bakery

| Name | Mobile (login) | Role |
|---|---|---|
| Anitha Raj | 9876533331 | Owner |
| Vignesh | 9876533332 | Cashier |
| Banu | 9876533333 | Kitchen Staff |

26 menu items — cakes with ½ kg / 1 kg sizes and add-ons (name on cake, candles), pastries, puffs (veg / egg /
chicken), breads with barcodes, sweets by weight box, tea / coffee / shakes. Counter, takeaway and delivery bills,
kitchen display, waiter app, QR ordering, today's specials, 14 days of sales. No tables (counter bakery).

## 🛒 FreshMart Supermarket — Retail · Supermarket

| Name | Mobile (login) | Role |
|---|---|---|
| Lakshmi Narayanan | 9876511111 | Owner |
| Kavya | 9876511112 | Cashier |

34 grocery products with EAN-13 barcodes (loose rice / sugar sold per kg), 0 / 5 / 12 / 18 % GST,
counter + delivery bills, customer credit, 14 days of sales, low-stock items.

## 🔧 Sri Murugan Hardware & Electricals — Retail · Hardware

| Name | Mobile (login) | Role |
|---|---|---|
| Murugan S | 9876522221 | Owner |
| Ramesh | 9876522222 | Cashier |

34 products — switches, MCBs, wires (per metre / coil), PVC pipes (per foot / piece), lights, fans,
tools, paints, plumbing, screws — 18 % GST, contractor customers on credit, 14 days of sales.

## 🥻 Kanchi Pattu Maaligai — Textile · Silk & Sarees

| Name | Mobile (login) | Role |
|---|---|---|
| Senthil Kumar | 9876544441 | Owner |
| Lavanya | 9876544442 | Cashier |
| Meena, Saravanan, Divya | — | Salespeople (no app login; 1–1.5 % commission) |

10 designs in their colours / sizes (one item each, ~25 items): Kanchipuram, Arani and soft silk sarees,
bridal silk, cotton and georgette sarees, blouses (sizes 36–42), dhotis and kids' pattu pavadai.
MRP with 0–20 % discount, in-store codes for QR price stickers (`2000000000015` = first item),
GST 5 % included in MRP, salesperson on most bills, 14 days of sales.

## Try barcode billing

Open **Billing**, keep the cursor in the search box, and scan (or type) a barcode then press Enter.
Scanning the same item again adds +1. Barcodes are shown under **Products → Edit → Barcode**
(e.g. hardware *Modular Switch 6A* = `8905000100007`).

## Reset

**Settings → Audit & Data → Reset demo data** recreates all five businesses with fresh data.
