# Kadai Kalanjiyam — shop set-up guide (shop by shop)

For every shop: **Business type**, **Sub type**, **Modules to enable**, and the **set-up steps**, one shop at a time.

Where to choose these: when the shop owner signs in the first time, the set-up screens open —
**Business → Type → Features → Terminology → (Tables) → Categories → Items → Finish**.
- **Business type** and **Sub type** are on the **Type** screen (sub type = "More specifically…").
- **Modules** are on the **Features** screen. They can be changed any time later in **Settings → Modules**.
- **Billing** and **Products** are always on.

---

## 1. Fast food (parotta shop, tiffin centre, biryani shop, mess)

**Business type:** 🍔 Food
**Sub type:** Fast Food

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Payments
- Expenses
- Reports
- Kitchen Display (KOT)
- Staff & Roles
- Customers (if they have credit / regular customers)
- Daily Specials (if they want "today's special")
- QR Ordering (if customers order by QR)

**Keep off:** Table Management, Inventory (unless they track stock of bottles / parcel boxes), Service Jobs

**Set-up steps:**
1. Admin → Customers → **Create customer** (shop name, owner mobile, password, months).
2. Admin → the shop → **Features** → turn on **QR Orders** and **Daily Specials** (if needed), **GST report** (if GST registered).
3. Owner signs in → **Business:** shop name.
4. **Type:** Food → Fast Food.
5. **Features:** turn on the modules above. Order types: **Counter, Takeaway, Delivery** (add **Dine-in** if people sit and eat).
6. **Terminology:** leave as it is ("Menu Items", "Bills").
7. **Categories:** e.g. Tiffin, Parotta, Biryani & Rice, Chicken, Drinks.
8. **Items:** add items with price (unit: plate / pc). "Track stock" off for food made fresh.
9. **Settings → Business Profile:** address, phone, GSTIN, logo.
10. **Settings → Billing & Tax:** GST (default 5 %).
11. **Settings → Printer and bill:** 58 / 80 mm, bill footer.
12. **Settings → Staff:** cashier login, kitchen login.
13. Test: make a bill → print → send a KOT → check it on **Kitchen**.

---

## 2. Hotel (South Indian hotel / meals hotel with tables)

**Business type:** 🍽️ Restaurant
**Sub type:** Hotel

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Payments
- Expenses
- Reports
- Table Management
- Kitchen Display (KOT)
- Mobile Order Taking (waiters take orders on their phone)
- Staff & Roles
- Customers (optional)
- Daily Specials (optional)
- QR Ordering (optional — QR on each table)

**Keep off:** Inventory (unless they track stock), Service Jobs

**Set-up steps:**
1. Admin → Customers → **Create customer**.
2. Admin → the shop → **Features** → **QR Orders**, **Daily Specials** (if needed), **GST report**.
3. Owner signs in → **Business:** hotel name.
4. **Type:** Restaurant → Hotel.
5. **Features:** turn on the modules above. Order types: **Dine-in, Takeaway, Delivery**.
6. **Terminology:** leave as it is ("Menu Items", "Guests", "Tables").
7. **Tables:** add each floor / area (e.g. Ground floor, AC hall) → number of tables → seats.
8. **Categories:** e.g. Tiffin, Meals, Parotta, Biryani, Chicken, Drinks.
9. **Items:** add items with price (unit: plate / pc).
10. **Settings → Business Profile, Billing & Tax (GST 5 %), Printer and bill.**
11. **Settings → Staff:** cashier, waiter (captain), kitchen logins.
12. Test: Tables → pick a table → add items → KOT → Kitchen → bill the table → print.

> Small hotel without table service (counter + token): use **Fast food** (section 1) instead.

---

## 3. Restaurant (family restaurant, dhaba, cafe with tables)

**Business type:** 🍽️ Restaurant
**Sub type:** Restaurant (or Family Restaurant / Dhaba / Cafe)

**Modules to enable:** same as **Hotel** — Orders, Payments, Expenses, Reports, Table Management, Kitchen Display (KOT),
Mobile Order Taking, Staff & Roles; optional Customers, Daily Specials, QR Ordering.

**Keep off:** Inventory (unless they track stock), Service Jobs

**Set-up steps:** same as **Hotel** (steps 1–12), with **Type: Restaurant → Restaurant**.

---

## 4. Cloud kitchen (delivery only)

**Business type:** 🍽️ Restaurant
**Sub type:** Cloud Kitchen

**Modules to enable:** Orders, Payments, Expenses, Reports, Kitchen Display (KOT), Staff & Roles; optional Customers, QR Ordering.

**Keep off:** Table Management, Mobile Order Taking, Inventory, Service Jobs

**Set-up steps:** same as **Hotel**, but order types **Takeaway + Delivery** only, and no Tables screen.

---

## 5. Bakery

**Business type:** 🍔 Food
**Sub type:** Bakery

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers (cake orders, regular customers)
- Payments
- Expenses
- Reports
- Inventory (packed items: bread, biscuits, rusk)
- Staff & Roles
- Kitchen Display (KOT) — only if they make tea / coffee / sandwiches to order
- Daily Specials, QR Ordering (optional)

**Keep off:** Table Management, Service Jobs

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report** (and QR Orders / Daily Specials if needed).
2. Owner signs in → **Type:** Food → Bakery.
3. **Features:** modules above. Order types: **Counter, Takeaway, Delivery**.
4. **Categories:** e.g. Cakes, Pastries, Puffs & Snacks, Breads, Cookies, Sweets, Tea & Coffee, Juices.
5. **Items:** cakes with sizes (½ kg / 1 kg) and add-ons (Name on cake, Candles); "Track stock" on for packed items, off for
   items made fresh.
6. **Settings → Price stickers** → Products → **Print labels** for packed items (barcode / QR).
7. **Settings → Printer, scale and bill:** weighing scale for sweets sold by weight.
8. **Settings → Business Profile, Billing & Tax, Staff.**
9. Test: bill a cake with size + add-on → print.

---

## 6. Tea shop / coffee shop / juice shop

**Business type:** 🍔 Food
**Sub type:** Tea Shop / Coffee Shop / Juice Shop

**Modules to enable:** Orders, Payments, Expenses, Reports, Staff & Roles; optional Customers, Kitchen Display (KOT), Daily Specials.

**Keep off:** Table Management, Inventory, Service Jobs

**Set-up steps:**
1. Admin → **Create customer** → Features: **Single device** (if only one counter device), GST report if needed.
2. Owner signs in → **Type:** Food → Tea Shop (or Coffee Shop / Juice Shop).
3. **Features:** modules above. Order types: **Counter, Takeaway**.
4. **Categories:** e.g. Tea & Coffee, Snacks, Juices.
5. **Items:** unit cup / glass; sizes (Regular / Large) as variants.
6. **Settings → Printer and bill**, **Billing & Tax**.

---

## 7. Sweets & snacks stall

**Business type:** 🍔 Food
**Sub type:** Sweets & Snacks

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, Inventory, Staff & Roles

**Keep off:** Table Management, Kitchen Display, Service Jobs

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner → **Type:** Food → Sweets & Snacks → **Features:** modules above.
3. **Items:** unit kg / g / box; sizes (250 g / 500 g) as variants.
4. **Settings → Printer, scale and bill:** weighing scale.
5. **Settings → Price stickers** → Products → **Print labels** for boxes.

---

## 8. Catering

**Business type:** 🍔 Food
**Sub type:** Catering

**Modules to enable:** Orders, Customers (advance / credit), Payments, Expenses, Reports, Staff & Roles

**Keep off:** Table Management, Kitchen Display, QR Ordering, Service Jobs

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner → **Type:** Food → Catering → **Features:** modules above.
3. **Items:** per plate (e.g. "Veg meals per plate").
4. Bill on credit to the customer when needed; collect the balance later in **Payments**.

---

## 9. Silk & saree shop (also textiles & readymade garments)

**Business type:** 🥻 Textile
**Sub type:** Silk & Sarees (or Textiles & Fabrics / Readymade Garments)

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers
- Payments
- Expenses
- Reports
- Inventory
- Staff & Roles
- Customer Orders (only if they do home delivery — off by default)

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials, Service Jobs

**Set automatically:** GST 5 %, prices include GST, QR price stickers (50 × 38 mm), scan-first billing.

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Textile → Silk & Sarees.
3. **Features:** modules above.
4. **Categories:** e.g. Kanchipuram Silk, Soft Silk, Cotton Sarees, Dhotis, Blouse.
5. **Items:** add each design with its colours / sizes, MRP and selling price (a code is made for each piece).
6. **Settings → Price stickers:** size, MRP + discount.
7. Products → **Print stickers** → stick on each piece.
8. **Staff:** add salespeople (with commission); pick the salesperson on each bill.
9. Test: scan a sticker on the billing screen → the saree is added → bill → print.

---

## 10. Mobile shop (new mobiles, accessories, repair)

**Business type:** 🛒 Retail
**Sub type:** Electronics

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers
- Payments
- Expenses
- Reports
- Inventory
- **Service Jobs** ⚠️ (off by default — turn it on for repairs)
- Staff & Roles

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Retail → Electronics.
3. **Features:** modules above — **turn on Service Jobs**.
4. **Categories:** e.g. New Mobiles, Accessories, Chargers & Cables, Mobile Parts, Repair & Service.
5. **Items:** phones, accessories, parts (with stock). Repair labour (e.g. "Screen replacement labour") as a **service**
   item (no stock).
6. **Settings → Price stickers:** QR code, 50 × 38 mm (default).
7. Products → **Print labels** → items without a code → **Create codes** → print → stick on chargers, covers, phones.
8. Billing: scan the sticker (2D QR / barcode scanner) → item added.
9. **Service Jobs:** New job (customer, model, IMEI / serial, problem, advance) → Received → Waiting for parts →
   Repairing → Ready → bill at delivery (parts + labour on one bill).
10. **Settings → Business Profile, Billing & Tax, Printer and bill, Staff.**

---

## 11. Electronics shop (TV, fridge, fans, appliances)

**Business type:** 🛒 Retail
**Sub type:** Electronics

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, Inventory, Staff & Roles; **Service Jobs** only if
they also repair.

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set-up steps:** same as **Mobile shop** (steps 1–10). Categories e.g. TV & Audio, Kitchen Appliances, Fans & Lights,
Cables & Chargers.

---

## 12. Vegetable & fruit shop

**Business type:** 🛒 Retail
**Sub type:** Vegetables & Fruits

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Payments
- Expenses
- Reports
- Staff & Roles
- Customers (if hotels / regular customers buy on credit)

**Keep off:** Inventory (loose stock is usually not tracked), Kitchen Display, Table Management, QR Ordering, Daily Specials,
Service Jobs

**Set automatically:** GST 0 %, tile billing (tap the item, enter the weight).

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner signs in → **Type:** Retail → Vegetables & Fruits.
3. **Features:** modules above.
4. **Categories:** e.g. Vegetables, Leafy Greens, Fruits.
5. **Items:** unit **kg** (or bunch / pc / dozen) with today's price.
6. **Settings → Printer, scale and bill:** connect the weighing scale (the weight comes into the bill by itself).
7. Test: tap Tomato → weight → bill → print.

---

## 13. Maligai kadai (grocery / provision store)

**Business type:** 🛒 Retail
**Sub type:** Grocery / Maligai

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers (credit / monthly accounts)
- Payments
- Expenses
- Reports
- Inventory
- Staff & Roles
- Customer Orders (phone / WhatsApp orders + home delivery)

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set automatically:** prices include GST (MRP), scan-first billing.

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Retail → Grocery / Maligai.
3. **Features:** modules above.
4. **Categories:** e.g. Rice & Atta, Dal & Pulses, Oil & Ghee, Masala, Snacks, Tea & Coffee, Dairy, Household.
5. **Items:** scan each packet's barcode into the item (or **Import** from Excel); loose items in kg.
6. **Settings → Printer, scale and bill:** weighing scale for loose rice / dal / sugar.
7. **Settings → Price stickers** → Products → **Print labels** for loose / own-packed items.
8. Milk, curd, bread: in the item, turn on **Track batch & expiry**.
9. **Settings → Loyalty points** (optional).
10. Test: scan a packet → weigh loose sugar → bill → print.

---

## 14. Supermarket

**Business type:** 🛒 Retail
**Sub type:** Supermarket

**Modules to enable:** same as **Maligai kadai** — Orders, Customers, Payments, Expenses, Reports, Inventory, Staff & Roles,
Customer Orders.

**Set-up steps:** same as **Maligai kadai** (steps 1–10), with **Type: Retail → Supermarket**, and one cashier login per counter.

---

## 15. Hardware / electricals shop

**Business type:** 🛒 Retail
**Sub type:** Hardware

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers (contractors, credit)
- Payments
- Expenses
- Reports
- Inventory
- Customer Orders (turned on by itself)
- Mobile Order Taking (turned on by itself — staff take orders on the shop floor)
- Staff & Roles

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set automatically:** GST 18 %, scan-first billing.

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Retail → Hardware.
3. **Features:** modules above.
4. **Categories:** e.g. Wires & Cables, Switches, Lights & Fans, Plumbing, Paints, Tools, Fasteners.
5. **Items:** units pc / mtr / ft / coil / roll / box; barcode where there is one.
6. **Settings → Billing & Tax → Second price list:** "Contractor rate" (lower price for electricians / plumbers).
7. Products → **Print labels** for items without a barcode.
8. Test: scan → bill at contractor rate → print.

---

## 16. Automobiles — spare parts shop (two-wheeler / car parts, tyres, accessories)

**Business type:** 🛒 Retail
**Sub type:** Auto Spare Parts

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers (mechanics, credit)
- Payments
- Expenses
- Reports
- Inventory
- Customer Orders (turned on by itself)
- Mobile Order Taking (turned on by itself)
- Staff & Roles

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set automatically:** GST 18 %, prices include GST, scan-first billing.

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Retail → Auto Spare Parts.
3. **Features:** modules above.
4. **Categories:** e.g. Engine Parts, Brakes, Electricals, Tyres, Oils & Lubricants, Accessories, Labour.
5. **Items:** parts with stock; "Fitting charge" as a **service** item (parts + labour on one bill).
6. **Settings → Billing & Tax → Second price list:** "Mechanic rate" (optional).
7. Products → **Print labels** for parts without a barcode.

---

## 17. Automobiles — service centre / garage (two-wheeler / car service)

**Business type:** 🛠️ Service
**Sub type:** Vehicle Service / Garage

**Modules to enable:**
- Billing, Products (always on)
- Orders
- Customers
- Payments
- Expenses
- Reports
- **Service Jobs** ⚠️ (off by default — turn it on)
- Staff & Roles
- Inventory (if they keep spare parts stock)

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set automatically:** GST 18 %; items are called "Services", buyers "Clients".

**Set-up steps:**
1. Admin → **Create customer** → Features: **GST report**.
2. Owner signs in → **Type:** Service → Vehicle Service / Garage.
3. **Features:** modules above — **turn on Service Jobs**.
4. **Categories:** e.g. General Service, Repairs, Spare Parts, Washing.
5. **Items:** services (e.g. "Bike general service") and parts.
6. **Service Jobs:** vehicle in → job card (vehicle no. in IMEI / serial, problem, advance) → stages → bill at delivery.

---

## 18. Repair shop (mobile / laptop / TV repair only, no sales)

**Business type:** 🛠️ Service
**Sub type:** Repair

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, **Service Jobs** ⚠️ (turn it on), Staff & Roles;
Inventory if they keep spare parts.

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set-up steps:** steps 1–6 of the **garage** (section 17), with **Type: Service → Repair**. Products → **Print labels** for
parts.

---

## 19. Salon / beauty parlour / spa

**Business type:** 🛠️ Service
**Sub type:** Salon (or Spa)

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, Staff & Roles

**Keep off:** Inventory, Kitchen Display, Table Management, QR Ordering, Daily Specials, Service Jobs

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner → **Type:** Service → Salon → **Features:** modules above.
3. **Categories:** e.g. Hair, Skin, Bridal, Spa.
4. **Items:** services with price (e.g. Haircut, Facial).
5. **Staff:** a login for each stylist with their commission % (commission is worked out on the bills each person makes).

---

## 20. Laundry / dry cleaning

**Business type:** 🛠️ Service
**Sub type:** Laundry

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, **Service Jobs** ⚠️ (turn it on), Staff & Roles

**Keep off:** Inventory, Kitchen Display, Table Management, QR Ordering, Daily Specials

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner → **Type:** Service → Laundry → **Features:** modules above — **turn on Service Jobs**.
3. **Items:** e.g. "Shirt — wash & iron", "Saree — dry clean" (unit pc / kg).
4. **Service Jobs:** clothes in → job card → stages → bill at delivery.

---

## 21. Tailoring / alteration

**Business type:** 🛠️ Service
**Sub type:** Other Services

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, **Service Jobs** ⚠️ (turn it on), Staff & Roles

**Set-up steps:** same as **Laundry** (section 20), with **Type: Service → Other Services**; one job card per garment, advance
at drop-off, bill at delivery.

---

## 22. Fancy store / gift shop

**Business type:** 🛒 Retail
**Sub type:** Fancy Store

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, Inventory, Staff & Roles

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials, Service Jobs

**Set-up steps:**
1. Admin → **Create customer**.
2. Owner → **Type:** Retail → Fancy Store → **Features:** modules above.
3. **Items:** with stock; barcode where there is one (scan it in the billing search box).

---

## 23. Stationery / book shop

**Business type:** 🛒 Retail
**Sub type:** Stationery

**Modules to enable:** Orders, Customers, Payments, Expenses, Reports, Inventory, Staff & Roles

**Keep off:** Kitchen Display, Table Management, QR Ordering, Daily Specials, Service Jobs

**Set-up steps:** same as **Fancy store** (section 22), with **Type: Retail → Stationery**. Units: pc, box, pack, set.

---

## After set-up — check every shop

1. Make one bill and **print** it.
2. Food / hotel / restaurant: send a **KOT** → it shows on **Kitchen**.
3. Maligai, supermarket, hardware, auto spares, textile, mobile shop: **scan** a barcode / QR sticker → item added.
4. Mobile / repair / garage / laundry / tailoring: one **Service Job** → Ready → bill it.
5. **Cashier** login: billing works; Reports and Expenses are hidden.
6. **Reports → Today:** the bill shows in today's sales.
