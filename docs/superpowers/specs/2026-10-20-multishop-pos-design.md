# MULTI-SHOP POINT OF SALE SYSTEM

_System Requirements, Features, and Pseudocode — Version 4_

A cloud-based point of sale (POS) platform for retail shops, pharmacies, and food businesses, from single-phone shops to retailers with several branches. It supports barcode scanners, phone cameras, and manual checkout on computers, tablets, and smartphones, keeps selling when the internet drops, and gives every shop a public mini landing page to market its products.

## What Changed in Version 4

Version 4 shapes the food module around how food businesses sell in Ghana, from fast-food counters such as KFC Ghana and Pizzaman Chickenman to chop bars and sit-down restaurants. All of it ships at launch (Phase 1b). Main changes:

- **Service modes:** Counter (order and pay first, collect by number), Table (pay at the end), and Quick serve (chop bar speed). A branch can mix them (4.24, 6.51).
- **Order numbers and Ready board:** a TV or screen shows which orders are being prepared and which are ready (6.51).
- **Combo meals:** meals with choice slots and upsize prices (6.52).
- **Sell by amount and pot tracking:** cashiers sell rice, stew, or soup by cedi value; stock is tracked by pots cooked and leftovers at closing, with a variance check (6.53, 6.54).
- Sold-out switch, takeaway pack fee, delivery-app and phone orders, and a packing check before handover (6.55–6.58).
- Kitchen printer through the print helper is the default kitchen setup; a kitchen display is optional.
- **Basic food reports:** sales by hour, item sales, profit by channel after commission, wastage and staff meals, and average kitchen time (6.59).
- **Not in scope:** own delivery riders, automatic MoMo confirmation by request-to-pay, head-office tools for chains, and QR or kiosk self-ordering (10.3).

### Version 3 Changes

- **Shop types:** each shop picks Retail, Pharmacy, or Food at onboarding. One shared core; the type switches on modules and default settings (section 4.14).
- **Pricing and units:** price lists (retail, wholesale, customer groups, quantity breaks) and unit conversion, such as buy by the carton and sell by the piece or strip (4.15).
- **Barcodes:** several barcodes per item, and scale barcodes that carry weight or price (4.16).
- **Tracking:** batch and expiry tracking with earliest-expiry-first selling, and serial or IMEI tracking (4.17).
- **Bundles and recipes:** selling one item deducts its parts or ingredients; made-in-advance items are recorded as production (4.18).
- **Purchasing:** stock receiving, purchase orders, suggested reorders, supplier bills and returns, transfers, and stock counts, now with pseudocode (4.19).
- **Customer value:** automatic promotions, coupon codes, loyalty points, store credit, gift cards, exchanges, and returns without a receipt (4.4, 4.20).
- **Orders:** layaway, deposits, special orders, business invoices, and quotes (4.21, 4.22).
- **Pharmacy module:** prescription records, expiry controls, generic-name search, and pack/strip/tablet selling (4.23).
- **Food module:** add-ons, open tickets, tables, split bills, kitchen printing and display, service charge, and ingredient stock (4.24).
- **Also added:** order at one counter and pay at another, cash rounding, staff commissions, marketing SMS, expenses, customer-facing display, plan limits, free trial, platform support access, data import and export, and an API (4.25–4.29).
- **Fix:** Paystack webhook signatures are now compared in constant time (6.11).

### Version 2 Changes

- **Product status:** this is a real commercial product. First market: Ghana (GHS, Paystack, mobile money, Ghanaian tax and data protection rules).
- **Offline checkout:** moved from Phase 5 into Phase 1 (section 4.9, pseudocode 6.10).
- **Data model:** the sellable unit is a variant from day one; quantities can be decimals; money is stored as whole pesewas.
- **Receipt numbers:** branch code + register code + counter, so they work offline and across several tills.
- **Negative stock:** allowed by default, flagged, and alerted to the manager.
- **Tenant isolation:** database Row-Level Security added as a backstop to the application checks.
- **Payments at the counter:** Phase 1 records cash, mobile money, card terminal, and bank transfer manually with a reference. Integrated Paystack payments at the till move to a later phase (section 4.3).
- **New requirements:** camera barcode scanning, tax-inclusive or tax-exclusive pricing, optional shifts, credit sales, receipts and printing, shop storefront (4.12), and 20–30 KB product images (4.13).
- **Billing:** the platform administrator activates subscriptions manually until Paystack billing is automated in Phase 3.
- **Shop addresses:** path-based (example.com/shop-name) first; subdomains and custom domains later.
- **Pseudocode fixes:** sales are saved as pending before payment confirmation and finalised exactly once; returns check quantities already returned; reports use a business-day cutoff and never send twice.
- **Testing:** tenant-isolation, duplicate-sale, and offline-sync tests now run from Phase 1 instead of only at the end.

## 1. Purpose and Overview

The platform will be one central website serving many independent shops. Each shop will have its own shop address, administrator account, products, employees, stock records, sales, reports, settings, subscription, and public storefront page. The platform owner will create and activate the initial shop administrator account after a shop purchases the service. The shop administrator will then manage that shop independently, without access to another shop’s private information.

The system must work for a small shop using only a phone or tablet, as well as a larger shop using a computer, barcode scanner, receipt printer, cash drawer, and multiple staff accounts.

This is a commercial product launching first in Ghana. It must keep selling during internet and power interruptions, and it must work on low-cost Android phones with slow mobile data.

Three shop types launch together: Retail (provisions, supermarkets, cosmetics, fashion, hardware, phones and electronics), Pharmacy (pharmacies and licensed chemical sellers), and Food (restaurants, chop bars, takeaways, cafés, and bakeries).

## 2. User Roles and Access

- **Platform Super Administrator:** Creates shop tenants, activates or suspends subscriptions, sets plans and prices, monitors platform health, manages support, takes down storefronts that break the terms, and views platform-level statistics. Access to shop business data is only through a logged support session that the shop owner can see in the audit log.
- **Shop Owner / Shop Administrator:** Controls the shop profile, storefront, branches, products, prices, stock, staff accounts, manager permissions, subscription, reports, notification recipients, and business settings.
- **Manager:** Views financial and stock dashboards, approves restricted actions, reviews shifts and staff performance, manages stock and suppliers if permitted, and receives daily and weekly SMS reports.
- **Cashier / Salesperson:** Signs in with an individual account or PIN, scans or searches products, completes sales, accepts permitted payment methods, prints or shares receipts, and views only the information allowed by the shop administrator.
- **Stock Clerk:** Receives deliveries, records stock counts and adjustments, prepares purchase orders, and transfers stock where permitted.
- **Accountant / Auditor:** Views permitted sales, expenses, tax, payment reconciliation, refunds, and exportable reports without necessarily having permission to change products or staff.
- **Public Visitor:** Views a shop’s published storefront without an account. Has no access to any business data.
- **Pharmacist:** In pharmacy shops, approves prescription-only medicine sales, records prescription details, and corrects batch and expiry records.
- **Waiter / Server:** In food shops, opens table or customer tickets, adds items and add-ons, sends orders to the kitchen, and passes bills to the cashier.
- **Kitchen Staff:** In food shops, sees orders on the kitchen printer or kitchen display and marks them ready. Has no access to sales totals.

Roles are presets of individual permission flags, so an owner can change one permission without inventing a new role. Phase 1 ships three presets: Owner, Manager, and Cashier. Stock Clerk and Accountant presets follow in later phases.

## 3. Shop Separation, Addresses, and Website Structure

- Each shop is a separate tenant with a unique tenant ID and a unique shop slug (short name).
- **Shop addresses (decided):** public storefront at example.com/<slug>; staff sign-in at example.com/<slug>/login; POS and back office under example.com/<slug>/app. Subdomains (slug.example.com) and custom domains are later add-ons because they need wildcard DNS and certificates.
- **Slug rules:** 3–40 characters, lowercase letters, numbers, and hyphens. Reserved words (admin, api, app, login, help, pricing, terms, privacy, www, static) are blocked. Changing a slug keeps a redirect from the old address.
- Every shop-owned database record must include a tenant ID. The server checks the signed-in user’s tenant and permissions on every request. The tenant always comes from the session, never from the URL or the request body.
- **Database backstop (decided):** PostgreSQL Row-Level Security policies on every tenant table, so a query that forgets a tenant filter returns nothing instead of another shop’s data.
- A shop must never be able to read or change another shop’s products, sales, employees, reports, settings, or customer records.
- The platform administrator creates the first shop administrator account after purchase, sends a secure activation link, and requires the administrator to set a password and enable appropriate account protection.
- A shop administrator can create branches or outlets under the same shop account. Branch-level stock, tills, staff access, and reports must be supported.
- Shop data must remain logically separated even though the shops use the same website and application.

## 4. Main Functional Requirements

### 4.1 Product and Inventory Management

- Create, edit, archive, and search products using product name, SKU, barcode, category, brand, unit, cost price, selling price, tax setting, and supplier.
- Find products three ways: a barcode scanner that types into the active checkout field, the phone or tablet camera, or manual search by name, SKU, category, or barcode.
- **Variants from day one (decided):** the sellable unit is a variant. A simple product has one default variant. Variants such as size, colour, flavour, pack size, or model each have their own SKU, barcode, price, cost, and stock.
- **Units and decimal quantities:** units include piece, kg, g, litre, metre, yard, and pack. Quantities can have up to 3 decimal places when the unit allows fractions (for example 1.250 kg).
- Track stock by branch and variant and show on-hand, reserved, damaged, expired, and reorder quantities where applicable.
- **Negative stock (decided):** a sale is allowed even if recorded stock would go below zero. The item is flagged and the manager is alerted. A shop can switch this to blocking.
- Record stock received, stock sold, returns, damage, expiry, loss, stocktake differences, and transfers between branches.
- Support bulk product import and export through CSV or spreadsheet files, and provide printable barcode labels.
- Set low-stock and out-of-stock thresholds. Notify the relevant manager when a threshold is reached.
- Maintain a stock movement history recording who made each change, when it happened, the quantity, reason, and reference transaction.
- Support suppliers, purchase orders, delivery receiving, partial deliveries, and purchase cost records.
- Each product can have up to 5 photos, each stored at 20–30 KB (section 4.13), and a “Show on storefront” switch that is off by default.
- Every product has a tracking mode: none, batch and expiry, or serial number (section 4.17).
- A product can be a standard item, a bundle, or a recipe whose sale deducts components (section 4.18). Food items can carry add-on groups (section 4.24).
- Prices come from price lists and can differ by unit, quantity, customer group, and branch (section 4.15).

### 4.2 Checkout and Sales

- Start a sale and associate it with the active cashier, branch, and register, plus the open shift when the shop requires shifts.
- Scan, photograph, or search for a product. Add the item, quantity, applicable price, tax, and permitted discount to the cart. Scanning the same barcode again increases the quantity.
- Allow quantity changes, item removal, held or suspended carts, and retrieval of a held sale, subject to staff permissions.
- **Money (decided):** all amounts are stored as whole pesewas (integers), never floating point. Rounding is half up, once per line.
- Calculate subtotal, discounts, taxes, fees if configured, and final amount due. For cash, the cashier enters the amount received and the system shows the change due.
- A sale is saved as pending first and completed only when fully paid or approved as a credit sale. Completing a sale is safe to repeat and reduces stock exactly once.
- **Receipt numbers (decided):** branch code + register code + counter, for example ACC1-T2-000123. Each device is its own register and keeps its own counter, so numbering works offline and across several tills.
- Provide a printed, downloadable, or shareable receipt (section 4.10).
- **Exchanges:** return items and sell replacements in one transaction. The customer pays or receives only the difference (6.32).
- **Order at one counter, pay at another:** a salesperson builds the order and gives the customer an order number; the cashier calls it up, takes payment, and completes it. Unpaid orders expire (6.39).
- **Cash rounding:** a shop can round cash totals to the smallest coin in use, for example 10 pesewas. The rounding difference is recorded on the sale (6.40).
- Automatic promotions and coupons are applied before tax (section 4.20). Layaway, deposits, and special orders are in section 4.21.
- Support customer details as optional fields, with purchase history and loyalty features only where enabled and lawful.

### 4.3 Payments at the Counter

- **Phase 1 (decided):** cash, mobile money sent to the shop’s own merchant number, card on the shop’s own terminal, and bank transfer. Every non-cash payment is recorded with a reference (MoMo transaction ID, terminal slip number, or transfer reference), and the cashier confirms the money arrived.
- Split tender is supported, for example part cash and part mobile money. Only cash can exceed the amount due (to give change).
- Shop sales money never passes through the platform’s Paystack account.
- **Integrated payments (Phase 6):** the till starts a Paystack card or mobile money charge, and the sale completes only after a verified webhook. This needs each shop to have its own Paystack account or a subaccount arrangement. The onboarding (KYC) and settlement model must be chosen before this is built.
- The reconciliation report lists manual payment references so the shop can match them against MoMo and bank statements.
- Store credit, gift cards, and loyalty points are also tenders (section 4.20). Their balances are checked and reduced on the server inside the sale transaction, so they can never go below zero.

### 4.4 Returns, Refunds, Voids, and Discounts

- Find the original receipt and select the items and quantities being returned.
- A return can never exceed the quantity sold minus the quantity already returned on earlier returns.
- Refund amounts use the price the customer actually paid, including any discount.
- Refunds go back by the original payment method by default. Refunding by a different method (for example cash for a MoMo sale) needs permission or approval. Returns on a credit sale reduce the customer’s balance.
- Record a reason for every return, refund, void, or cancelled transaction.
- Restock returned items only after the staff member records whether the items are saleable, damaged, or expired.
- Require manager approval for refunds, large discounts, price overrides, voids after payment, and other sensitive actions according to shop settings. Nobody can approve their own request.
- Never erase completed financial transactions. Use linked reversal, refund, or adjustment records so the audit trail remains intact.
- Record the staff member who requested and approved each restricted action.
- Refunds can be issued as store credit (section 4.20).
- Serial-tracked items can only be returned if the serial was sold on that receipt. Batch-tracked items go back into the batch they were sold from.
- **Returns without a receipt (decided):** allowed only with manager approval and the customer’s name and phone, refunded as store credit (never cash) at the item’s lowest selling price in the last 90 days, and limited per customer per month (proposed: 2) (6.33).
- Loyalty points and staff commission earned on returned items are reversed.

### 4.5 Credit Sales (Customer Accounts)

- Shops can sell on credit (“on book”) to named customers when the feature is enabled.
- Each credit customer has a phone number, a credit limit set by a manager, and a running balance.
- Selling above the credit limit needs manager approval. Credit sales are not available offline.
- Customers can pay off debt in parts by any payment method. Each payment gets a receipt showing the new balance.
- Managers get a weekly list of who owes money, oldest debt first. Optional SMS reminders go only to customers who agreed to receive them.
- The customer ledger is never edited. Corrections are adjustment entries with a reason and approval.

### 4.6 Staff Accounts, Roles, and Shifts

- Allow the shop administrator to create staff accounts, reset access, deactivate former employees, and assign branches and registers.
- Give each salesperson a unique account and, where suitable, a 4–6 digit POS PIN for quick till switching. After 5 wrong PINs the PIN locks for 15 minutes and the manager is notified.
- Use role presets (cashier, senior cashier, stock clerk, manager, accountant, administrator) built from permission flags.
- Allow permissions to be configured for refunds, discounts, price changes, stock adjustments, credit sales, reports, expenses, storefront, and staff management.
- Shifts are a per-shop setting (“Require shifts”). When on, record clock-in, clock-out, register opening, cash paid in or out, shift closing, expected cash, counted cash, and any variance. A one-person phone shop can leave it off.
- Produce sales by employee, shift, branch, payment method, product, and category.
- **Staff commissions (optional):** commission rules by product, category, or staff member, as a percentage or a fixed amount per item. Commissions are calculated on completed sales, reversed on returns, and reported per period (6.41).

### 4.7 Manager Dashboard and Financial Tracking

- Show sales today, gross sales, discounts, refunds, net sales, taxes, payment breakdown, transaction count, and average transaction value.
- **Business day:** each shop sets a business-day cutoff time (default midnight) so shops open past midnight report correctly. Sales count toward the business day in which they happened, even if they synced late.
- Show estimated gross profit and cost of goods sold when product cost data is available. Clearly distinguish revenue from profit and cash collected.
- Track expenses, supplier purchases, cash movements, receivables (credit sales), payables, and cash drawer differences where these modules are enabled.
- Show best-selling and slow-moving products, low-stock and negative-stock items, stock valuation, stock movement, and reorder suggestions.
- Show offline sales waiting to sync and synced sales that need manager review.
- Show storefront page views, product views, and WhatsApp and call clicks.
- Show near-expiry and expired stock (pharmacy and food), money held for customers (deposits, layaway payments, store credit, gift cards), commissions owed, and kitchen waiting times (food).
- Compare current day, week, month, previous period, branch, cashier, product, and category.
- Allow reports to be filtered and exported to CSV or spreadsheet format, and print summaries.
- Show pending, successful, failed, refunded, and unmatched electronic payments for reconciliation.
- Maintain an audit log for important activities, including price changes, permission changes, refunds, stock adjustments, storefront changes, and subscription changes.

### 4.8 SMS and Email Notifications

- At the configured end of each business day, send the manager an SMS summary of sales, refunds, net sales, payment methods, and any cash variance.
- At the configured weekly reporting time, send the manager an SMS stock summary, including low-stock and out-of-stock products, quantities, and suggested reorder items.
- Allow the shop administrator to choose recipients, report time, reporting timezone, branch scope, and whether email reports are also sent.
- Keep SMS messages concise. For long stock reports, send a summary and a secure dashboard link, or split the message into numbered parts if supported.
- Every report has a unique key (shop, branch, report type, date), so a job that runs twice never sends twice. Queue notifications, retry temporary failures, and record delivery status.
- **SMS allowance:** each plan includes a set number of SMS per period. When it runs out, SMS stop and the owner sees a notice; email continues.
- Register the platform’s SMS sender ID with the chosen Ghanaian SMS provider early, because approval takes time.
- Marketing SMS to customers who opted in is covered in section 4.25. Report and receipt SMS are never mixed with marketing.
- Never include passwords, full payment card numbers, or sensitive customer details in SMS messages.

### 4.9 Offline Operation (Phase 1)

- The POS is a Progressive Web App (PWA). Each registered device keeps the catalogue, prices, tax rules, product images, staff PIN hashes, and permissions for its register.
- Offline, the device accepts cash and manually confirmed payments only. Each sale gets a device-generated ID and receipt number and is queued on the device. Receipts are marked “Offline – pending sync”.
- When the connection returns, queued sales sync automatically. Retries are safe because the sale ID is the idempotency key. Problems (such as a deactivated staff member) are held for manager review instead of being dropped.
- A synced sale keeps the price the customer actually paid, even if the price changed in the meantime. Price differences, archived items, and negative stock are flagged.
- **Offline limit (proposed default):** the device must have synced in the last 72 hours. A shop can switch offline mode off.
- Only registered devices can sell offline. A lost device can be deregistered remotely, and its cached PINs are wiped on its next connection.

### 4.10 Receipts, Printing, and Hardware

- **Receipt contents:** shop name and logo, branch address and phone, TIN or VAT number when registered, receipt number, date and time, cashier, items, discounts, tax breakdown, total, payments, change given, return policy text, and the storefront link or QR code.
- Printing uses the browser’s print function to 58 mm and 80 mm thermal printers through the normal printer driver.
- The cash drawer opens through the receipt printer where the printer driver supports it. Direct ESC/POS control through a small local helper app is a later add-on.
- Phone-only shops share receipts as a link by WhatsApp or SMS, or download a PDF.
- Any past receipt can be reprinted. Reprints are logged.
- **Other hardware:** kitchen and bar printers (food), barcode label printers, weighing scales that print barcode labels (section 4.16), and a customer-facing display (section 4.28).
- Printing to kitchen printers and network printers without a print dialog needs the local print helper app (section 11).

### 4.11 Tax

- **Shop setting:** prices are tax-inclusive (the shelf price already includes tax, default) or tax-exclusive (tax is added at the till).
- Tax rules are configurable per shop and per product: name, rate, and whether levies stack. Rates are never hard-coded. Ghana’s VAT and levy structure has changed recently, so current GRA rules must be confirmed before launch.
- Shops that are not VAT-registered can switch tax off.
- **GRA E-VAT (decided 2026-10-26):** not built for launch. VAT-registered shops keep their own GRA process until E-VAT integration is built in a later phase, after GRA API access and certification.

### 4.12 Shop Storefront (Mini Landing Page)

- Every shop gets a public mini landing page at example.com/<slug> to market the shop and show its products. It stays hidden until the owner publishes it.
- **Shop section:** name, logo, cover image, short “about” text, address with map link, opening hours, phone, WhatsApp number, social media links, and a theme colour.
- **Products:** the owner chooses which products appear using the “Show on storefront” switch, picks featured products, and visitors can browse by category, search, and open a product page with photos.
- Prices are shown tax-inclusive, or as “Call for price” if the owner hides prices. Availability can show as “In stock” or “Out of stock”. Exact stock counts, cost prices, suppliers, staff, and sales are never shown.
- **Announcement banner:** a short message such as “New stock arrived” or “Christmas sale”, with an end date.
- **Ordering:** visitors tap “Order on WhatsApp” (a pre-filled message with the product name, price, and link) or “Call”. There is no online checkout in the first storefront release. Online orders with Paystack and pickup or delivery are a later phase.
- **Sharing:** storefront and product links show a photo preview when shared on WhatsApp or Facebook. The owner can download a QR code for flyers, and receipts carry the storefront link or QR code.
- The storefront is built from the POS catalogue. A price, photo, or availability change in the POS reaches the storefront within 10 minutes.
- Pages are server-rendered and cached, and images load as the visitor scrolls, so pages open quickly on slow mobile data.
- Visitor statistics are counts only (page views, product views, WhatsApp and call clicks). No personal data and no tracking cookies are stored.
- The storefront stays live during the subscription grace period and is hidden after it. Its data is kept.
- **Abuse controls:** platform terms list prohibited items, every storefront has a “Report this page” link, and the platform administrator can take a storefront down. Takedowns are logged and the owner is notified.
- Prescription-only medicines never show an order button on the storefront; they show “Ask at the pharmacy” instead (to confirm against Pharmacy Council rules).
- **Online orders (later phase):** visitors place pickup or delivery orders and pay by Paystack, or upload proof of a bank or MoMo transfer for the shop to confirm. Every order records its source (storefront, WhatsApp, Instagram, Facebook, walk-in). Visitors verify their phone number by SMS code before their first order (6.49).

### 4.13 Product Images

- Every product photo is stored at 20–30 KB. The shop logo and cover image use the same process; the cover can be up to 1200 pixels wide.
- The device compresses each photo before upload: resize to at most 800 pixels on the longest side, convert to WebP, and search for the highest quality that fits. This saves the shop’s mobile data.
- 30 KB is a hard maximum. A photo that is already under 20 KB at top quality is kept as it is. If 800 pixels cannot reach 30 KB, the process tries 640 and then 480 pixels.
- The server never trusts the device. It checks every upload and always re-compresses it, so a file that skipped device compression is still stored at 20–30 KB.
- **Accepted files:** JPEG, PNG, and WebP, checked by file content rather than file name, up to 10 MB before compression. iPhone HEIC photos are converted on the device; an unconverted HEIC file is rejected with a clear message.
- All photo metadata is removed, including EXIF data, GPS location, and camera details.
- Up to 5 photos per product; the first photo is the main one. The POS caches photos for offline use.

### 4.14 Shop Types and Modules

- Each shop picks a type at onboarding: Retail, Pharmacy, or Food. The platform administrator can change it later.
- All types share one core: products, sales, payments, stock, staff, reports, storefront, and billing.
- The type sets default settings and switches on modules. Pharmacy: batch and expiry tracking for medicines, prescription records, pack/strip/tablet units. Food: add-ons, open tickets, optional tables, kitchen printing and display, recipes and production. Retail: serial tracking, price lists, and scale barcodes are available.
- A shop can switch individual modules on or off where its plan allows. For example, a supermarket with a bakery counter can use scale barcodes and recipes.
- Modules are set per shop and apply to all its branches (my call; per-branch modules can come later).

### 4.15 Prices, Price Lists, and Units of Measure

- Each variant has a base selling price. Price lists can override it: Retail (default), Wholesale, customer groups (for example staff or clinics), branch-specific lists, and lists that run between start and end dates.
- **Quantity breaks:** for example 1–11 pieces at GHS 5.00 each and 12 or more at GHS 4.50 each.
- Selecting a customer applies their price list automatically. A cashier can switch the cart’s price list only with permission.
- **Units of measure:** each variant has a base unit, the smallest unit sold (tablet, piece, gram). Other units are multiples of it: strip = 10 tablets, pack = 3 strips, carton = 24 pieces.
- Each unit can have its own barcode and price, because a carton price is often less than 24 times the piece price. Each unit can be marked as sellable, purchasable, or both.
- Stock is always stored in base units. Receiving one carton adds 24 pieces; selling one strip removes 10 tablets.
- Cost method (decided): weighted average cost per variant, updated on every receipt of stock.

### 4.16 Barcodes

- A variant can have several barcodes: the manufacturer’s barcode, the shop’s own label, and a carton barcode. Each barcode points to one variant and one unit, and is unique within the shop.
- **Scale barcodes:** weighing scales print labels whose barcode carries an item code and either the weight or the price (EAN-13 codes starting with 2; the layout is set per shop). Scanning one adds the item with that weight or price. The check digit is verified.
- The same scan field also recognises gift cards, coupons, and loyalty cards.
- Shops can print barcode labels for items that have none.

### 4.17 Batch, Expiry, and Serial Tracking

- Each product has a tracking mode: none, batch and expiry, or serial number.
- **Batch and expiry:** every receipt of stock records the batch number, expiry date, and quantity. Stock is held per batch.
- Sales take the earliest-expiring batch first. A cashier can choose a different batch only with permission.
- Expired batches cannot be sold. Batches inside the warning period (default 90 days, set per shop) show a warning, and appear in the near-expiry report and the weekly stock SMS.
- Expired stock is moved to “expired” with a stock movement, then returned to the supplier or disposed of with a reason.
- **Serial or IMEI:** each unit received records its serial number. At sale, the cashier scans or picks the serial; it prints on the receipt and is saved in the customer’s history. An optional warranty end date is stored.
- Recalls: find every sale, customer, and branch for a given batch or serial number.

### 4.18 Bundles, Recipes, and Production

- **Bundle:** a sellable item made of other items, such as a gift hamper or a school pack. Selling it deducts each component.
- **Recipe:** a menu item made from ingredients, for example 1 plate of jollof = 0.25 kg rice + 0.05 L oil + 1 chicken portion. Selling it deducts the ingredients. Ingredients are not sold on their own unless marked sellable.
- **Production:** items made in advance, such as bread and pastries, are recorded as produced. Ingredients go down and finished stock goes up. Selling then deducts the finished item.
- Add-ons can deduct ingredients too, for example extra chicken.
- The cost of a bundle or recipe is the sum of its component costs, so profit reports stay correct. Setup blocks bundles that contain themselves.

### 4.19 Purchasing, Receiving, Transfers, and Stock Counts

- **Suppliers:** name, contact, payment terms, lead time, products supplied, pack sizes, and last cost.
- **Purchase orders:** create, send by email or WhatsApp, receive all or part, and close.
- **Suggested purchase orders:** drafts built from reorder levels and recent sales speed, rounded up to the supplier’s pack size. A person must review a draft before it is sent.
- **Receiving:** with or without a purchase order, in any purchasable unit, recording cost, batch and expiry, or serial numbers as the product requires.
- **Supplier bills:** record what is owed to each supplier, due dates, and payments made.
- **Supplier returns:** send damaged, expired, or wrong items back. Stock goes down and a supplier credit is recorded.
- **Transfers between branches:** sent and received as two steps, with stock “in transit” between them. Differences on arrival are recorded with a reason.
- **Stock counts:** full or partial counts by scanner or by hand. Selling can continue during a count. Differences above a value limit need approval.
- **Stock adjustments:** damage, loss, theft, own use, found stock, and expiry disposal, each with a reason, and approval above a value limit.

### 4.20 Promotions, Loyalty, Store Credit, and Gift Cards

- **Automatic promotions:** percentage or amount off products, categories, or the whole cart; buy X get Y; multi-buy prices (3 for GHS 10); happy hours by day and time; start and end dates; branch and customer-group scope.
- **Coupon codes:** single-use or multi-use, with limits per customer and an expiry date. A coupon is used up only when the sale completes.
- **Promotion rule (my call):** the customer gets the single best automatic promotion per line, unless a promotion is marked as stackable. Manual discounts still follow staff limits and approvals.
- **Loyalty points:** customers are identified by phone number or loyalty card barcode. Points are earned on the amount paid with money, after discounts and before tax, and can be spent as a tender at a value the shop sets. Points are reversed on returns. Points can expire after a set period.
- **Store credit:** a customer balance created by refunds, returns without a receipt, top-ups paid in advance, or goodwill credit with approval. Spent as a tender. Every change is a ledger entry.
- **Gift cards:** sold as items with an unguessable code printed as a barcode or sent by SMS. Spent as a tender, with partial use allowed and a balance check. Expiry is optional and must follow consumer law. Unspent gift card balances are reported as money held for customers, not as revenue.

### 4.21 Layaway, Deposits, and Special Orders

- **Layaway:** the customer pays a deposit (proposed minimum 20%), the items are reserved, the customer pays in parts, and collects when fully paid. Cancellation refunds the payments minus a fee, or gives store credit, according to a shop setting.
- **Special orders:** for items not in stock. The order and deposit are recorded, the items are added to the next draft purchase order, and the customer gets an SMS when the items arrive.
- Deposits and part payments count as money held for customers, not as sales, until the sale completes.
- Reserved stock is excluded from available stock and from the storefront “In stock” badge.

### 4.22 Business Invoices and Quotes

- **Quotes (proforma invoices):** itemised, with a validity date, shared as a PDF or link by WhatsApp or email, and converted into a sale or invoice in one step at the quoted prices.
- **Invoices for business customers:** customer name, address, and TIN; due date; part payments; statement of account; and reminders before and after the due date. Invoices use the same customer ledger as credit sales.
- Invoices from VAT-registered shops follow GRA E-VAT rules once confirmed (section 4.11).

### 4.23 Pharmacy Module

- Medicines use batch and expiry tracking. Selling expired stock is blocked.
- Units such as pack, strip, tablet, and bottle, with stock held in the base unit.
- Product fields: generic name, strength, dosage form, and an optional regulatory registration number. Search works by brand name or generic name.
- Prescription-only medicines are flagged. Selling one needs a user with the pharmacist permission (or their approval) and a prescription record: patient name, prescriber, facility, prescription date, and an optional photo of the prescription, kept in private storage.
- A licensed chemical seller can be limited to over-the-counter medicines by a shop setting.
- Reports: near-expiry stock, expired stock value, and a log of prescription-only sales.
- **Launch scope (decided 2026-10-26):** basic pharmacy rules only: batch and expiry tracking, and a prescription-only flag on products. No reporting to regulators at launch.
- **To confirm (later phase):** Pharmacy Council and FDA Ghana record-keeping rules, including what must be recorded, how long it must be kept, and any extra controls on certain medicines. Prescription fields can be switched on or made required to match.

### 4.24 Food Module

**Service modes (set per branch; a branch can use more than one):**

- **Counter:** the customer orders and pays first, gets an order number, the kitchen prepares the order, and the customer collects when the number shows as ready. This is the fast-food flow customers know from KFC Ghana and Pizzaman Chickenman.
- **Table:** a waiter opens a ticket for a table, sends items to the kitchen, and the bill is paid at the end, with split bills and an optional service charge.
- **Quick serve:** for chop bars and local joints. The customer pays first by cash or MoMo and is served on the spot. Large buttons, sell-by-amount items, and no kitchen step.
- **Order numbers:** short numbers (001–999) that restart each business day per branch. They print on the receipt and kitchen ticket.
- **Ready board:** a TV or spare screen running a browser page shows the branch’s orders in two columns, “Preparing” and “Ready”. An optional SMS tells the customer “Order 0427 is ready”.
- **Combo meals:** a combo has fixed items and choice slots, for example “Meal 2: 2 pieces of chicken, chips, and a drink of your choice”. A slot can offer upgrades at extra cost (upsize drink +GHS 5). Stock is deducted for what the customer actually chose.
- **Sell by amount:** items such as rice, stew, soup, or waakye can be sold by cedi value. The cashier types the amount, above a minimum the shop sets.
- **Pot tracking:** for sell-by-amount items, the kitchen records pots cooked each day; ingredients are deducted by the pot recipe. At closing, staff record what is left (for example a quarter pot). The system compares expected sales with actual sales and flags large differences, which can point to over-serving or missing money.
- **Sold-out switch:** one tap marks an item as finished for the day. It disappears from the POS and the storefront within minutes and comes back at the start of the next business day.
- **Takeaway pack fee:** a pack or container fee is added automatically to takeaway and delivery orders, per item or per order as the shop sets. Eat-in orders do not get it.
- **Delivery-app and phone orders:** orders from Bolt Food, Chowdeck, phone calls, and WhatsApp are entered at the POS with their channel and the platform’s order ID, so they go to the kitchen, reduce stock, and appear in reports. Each channel can have its own prices and commission rate. A platform order ID cannot be entered twice. Direct connection to delivery apps is not in scope (10.3).
- **Packing check:** before a takeaway, delivery, or delivery-app order is handed over, the packer ticks every item on screen or on a printed checklist. The order cannot be marked “handed over” until every item is ticked. This targets wrong and missing orders.
- **Kitchen hardware (decided):** a thermal kitchen printer through the local print helper is the default, because it keeps working when the internet drops. A kitchen display is optional for busy kitchens and needs internet or a local network.
- **Basic food reports:** sales by hour, item sales (best and slowest sellers), sales and profit by channel after commission, wastage and staff meals, pot variance, and average kitchen time per day (6.59). Detailed analysis such as food cost per dish over time is not part of this version.
- **Add-ons (modifiers):** groups such as “Protein” (choose 1: chicken, fish, beef), “Extras” (any number: egg, shito), and “Pepper level”. Each add-on has a price and optional ingredient deductions. Groups can be required, with minimum and maximum choices.
- Notes per item, such as “no onions”.
- **Dining options:** eat in, takeaway, and delivery. A dining option can change the price or tax.
- **Open tickets:** orders saved and added to before payment, named by table, customer name, or number. Lines can be moved between tickets, and tickets can be merged.
- **Tables (optional, for sit-down restaurants):** a list of tables with status: free, ordering, waiting for food, or bill printed.
- **Kitchen:** items go to a kitchen printer or kitchen display by station (food to the kitchen, drinks to the bar). The display shows waiting times, and staff mark orders ready. Voiding an item already sent needs a reason and approval, and prints a cancel slip.
- **Split bills:** by item, by seat, or in equal parts. Each part is paid and receipted separately.
- Service charge (optional shop setting) and tips (optional).
- Ingredient stock through recipes, and daily production for items made in advance (section 4.18).
- **Wastage and staff meals:** recorded with a reason (spoiled, dropped, staff meal), deducting ingredients or finished items, and shown in reports.
- **Offline (my call):** open tickets keep working on the device that holds them. Sharing tickets between devices and sending them to a kitchen display needs internet; printing to a kitchen printer through the local print helper works without internet.

### 4.25 Customer Marketing

- Shops can send promotional SMS campaigns to customers who opted in, choosing a segment: all opted-in customers, recent buyers, customers who have not returned for a while, loyalty members, or birthday month.
- Every marketing SMS includes how to opt out. Opt-outs are recorded and always respected.
- The cost in SMS parts is shown before sending, and campaigns use the shop’s SMS allowance or paid SMS bundles.
- Campaigns can link to the storefront or a product page.
- No marketing SMS between 9 pm and 7 am shop time (my call).

### 4.26 Expenses

- Record expenses by branch and category (rent, utilities, transport, wages, supplies) with amount, payment method, note, and an optional receipt photo kept in private storage.
- Cash expenses paid from the drawer count as paid-out cash in the shift.
- Expenses above a set amount need approval.
- The profit report subtracts expenses: estimated gross profit minus expenses gives estimated net profit.

### 4.27 Plans, Limits, and Free Trial

- Each plan sets limits: branches, registers, staff, products, SMS per month, modules (pharmacy, food, online orders, API), and storage.
- **Monthly prices (decided 2026-10-26, starting point):** Starter GHS 150 (1 branch, 2 tills), Standard GHS 300 (2 branches, 5 tills), Pro GHS 600 (5 branches, 15 tills). Staff, product, SMS and module limits per plan are still open.
- Limits are checked on the server before a record is created. Reaching a limit shows an upgrade notice and never deletes data. After a downgrade, existing records stay but no new ones can be added above the limit.
- **Free trial (proposed: 14 days, no card needed):** full features with a trial banner, a small SMS allowance (proposed: 50), and no online payments. Trial shops are created by the platform administrator in Phase 1 and by self sign-up with phone and email verification from Phase 3.

### 4.28 Customer-Facing Display

- An optional second screen, such as a low-cost tablet or a monitor, shows the cart, discounts, total, change due, and the shop’s MoMo number or payment QR code. Between sales it shows the shop’s promotions.
- It is paired with a register by a short code and can only read that register’s active cart.

### 4.29 Platform Support, Data Import and Export, and Integrations

- **Support access:** platform staff can view a shop only during a time-limited support session granted by the owner, or under emergency access with a written reason that the owner can see. Every action in the session is logged in the shop’s audit log.
- **Import:** products, customers, opening stock, and opening customer balances from CSV templates, so shops can move from another POS or a spreadsheet. Every row is validated before anything is saved.
- **Export:** the owner can export products, customers, sales, stock, and ledgers as CSV at any time, including during read-only expiry.
- **Account closure:** the owner exports first, then the shop is closed. Data is kept for the legal retention period (to confirm) and then deleted, and the deletion is logged.
- **Accounting export:** sales, payments, expenses, and tax summaries in a format accounting software can import.
- **API (later phase):** per-shop API keys with limited scopes, and outgoing webhooks for events such as sale completed, stock low, and order created.

## 5. Subscription and Paystack Billing

The platform will sell annual shop subscriptions through Paystack. Card payment should be the primary option. Mobile money should be offered as an alternative where available. The exact recurring-payment options must be confirmed against the current Paystack account, supported channels, and country configuration.

- **Phase 1 (decided):** the platform administrator activates and renews shops manually, recording payment method, reference, amount, and period. Automated Paystack billing comes in Phase 3, once there are paying shops.
- Subscription payments go to the platform’s Paystack account. They are kept separate from each shop’s sales money.
- After a shop purchases the service, the platform administrator creates the shop tenant and initial administrator account.
- Store subscription start date, end date, plan, payment reference, payment status, renewal preference, and any grace-period rules.
- During checkout, offer card as the main method and mobile money as an alternative when the customer cannot or does not want to use a card.
- For card-based automatic renewal, obtain the customer’s explicit consent, explain the annual amount and renewal date, and use Paystack’s supported authorisation or token mechanism. Never store raw card details.
- Send reminders 30, 7, and 1 day before the scheduled annual deduction, by email and SMS, because many owners rarely check email.
- Verify all payment results on the server with Paystack, and check each webhook’s signature. Do not activate or extend a subscription based only on a browser redirect.
- Use idempotency and unique payment references to prevent duplicate subscription extensions. A renewal extends from the later of the current end date and today.
- If a recurring card charge fails, notify the shop, record the failure, and offer a secure way to update payment details or pay by mobile money.
- Mobile money may require the customer to approve a prompt or complete a payment flow. Do not assume that every mobile money transaction can be automatically charged annually.
- **Grace period (proposed default: 14 days):** the POS works normally with a renewal banner. After the grace period the POS becomes read-only (view and export records, no new sales) and the storefront is hidden.
- On successful renewal, restore access and retain the shop’s products, sales history, staff settings, storefront, and reports.
- Provide clear renewal, cancellation, failed-payment, expiry, and reactivation notices.

## 6. Pseudocode

The pseudocode below describes the main application flow. It is language-independent; section 11 recommends a stack.

### 6.0 Conventions Used Below

```text
MONEY      All amounts are whole pesewas (integers). GHS 12.50 = 1250.
QUANTITY   Decimal with up to 3 places (1.250 kg). Units that do not allow
           fractions reject non-whole quantities.
UNITS      Stock is always stored in base units (tablet, piece, gram).
           base_qty = quantity * unit.factor (1 strip = 10 tablets).
IDS        Records created on a device (sales, payments, returns) use a UUID
           made on the device. The same UUID is the idempotency key.
RECEIPTS   branch_code-register_code-counter, e.g. ACC1-T2-000123. Each device
           is its own register and keeps its own counter, online or offline.
           The server enforces uniqueness and tells a re-installed device
           its last used counter.
TENANT     tenant_id always comes from the signed-in session, never from the
           URL or request body. Row-Level Security enforces it again.
TIME       Stored in UTC. Reports use the shop timezone (Africa/Accra by
           default) and the shop's business-day cutoff.
AUDIT      write_audit(actor, action, record, reason, change_summary) for
           every sensitive action in section 4.
```

### 6.1 Sign-In, PIN Switching, and Tenant Security

```text
FUNCTION sign_in(slug, email, password, ip):
    IF too_many_attempts(ip, email):
        RETURN try_again_later
    shop = find_shop_by_slug(slug)
    IF shop does not exist OR shop.status == "suspended":
        RETURN access_denied
    user = find_user_in_tenant(shop.tenant_id, email)
    IF user does not exist OR NOT verify_password_hash(user, password):
        count_failed_attempt(ip, email)
        record_security_event("failed_sign_in", shop, email, ip)
        RETURN access_denied              // same message for both cases
    IF user.status != "active":
        RETURN account_disabled
    IF user is owner or administrator AND user.mfa_enabled:
        require_second_factor(user)
    create_secure_session(user.id, shop.tenant_id, user.role)
    RETURN role_based_home

FUNCTION switch_cashier_with_pin(device, staff_id, pin):
    REQUIRE device is registered to this shop and branch
    staff = find_user_in_tenant(device.tenant_id, staff_id)
    IF staff.pin_locked_until > now:
        RETURN pin_locked
    IF NOT verify_pin_hash(staff, pin):
        staff.failed_pin_count = staff.failed_pin_count + 1
        IF staff.failed_pin_count >= 5:
            staff.pin_locked_until = now + 15 minutes
            notify_manager("PIN locked", staff, device)
        RETURN wrong_pin
    staff.failed_pin_count = 0
    set_active_cashier(device, staff)

FOR EVERY protected request:
    session = verify_session()
    verify_user_is_active(session.user_id)
    tenant_id = session.tenant_id         // ignore any tenant_id the client sends
    verify_subscription_allows(tenant_id, requested_action)
    verify_permission(session.user_id, requested_action)
    set_database_tenant(tenant_id)        // Row-Level Security reads this
    IF any check fails:
        deny_request()
        record_security_event()
```

### 6.2 Create a Shop After Purchase

```text
FUNCTION onboard_shop(super_admin, purchase):
    require_permission(super_admin, "create_shop")
    verify purchase: a verified Paystack payment OR a manual payment record
        (method, reference, amount, period, recorded_by)
    slug = normalise(purchase.requested_slug)  // lowercase, a-z, 0-9, "-"
    IF slug is reserved OR length(slug) < 3 OR slug already used:
        RETURN choose_another_slug
    BEGIN DATABASE TRANSACTION
        create tenant (tenant_id, slug, name, timezone = "Africa/Accra",
                       currency = "GHS")
        create subscription from the verified payment
        create branch "Main" with a branch_code
        create register "Till 1" with a register_code
        create role presets: owner, manager, cashier
        create storefront record with published = false
        create owner user with status = "pending_activation"
        write_audit(super_admin, "shop_created", tenant)
    COMMIT
    send activation link (single use, expires in 72 hours)
    ON activation:
        owner sets a strong password and can enable MFA
        owner confirms shop name, address, tax mode, manager phone,
            notification preferences, and business-day cutoff
    RETURN owner_dashboard
```

### 6.3 Add a Product

```text
FUNCTION add_product(user, data):
    require_permission(user, "manage_products")
    validate name, unit, tax_rule, price >= 0, cost >= 0   // whole pesewas
    IF data.variants is empty:
        data.variants = [ one default variant using the product's
                          SKU, barcode, price, and cost ]
    FOR each variant:
        ensure SKU and barcode are unique within the tenant
    BEGIN DATABASE TRANSACTION
        save product (show_on_storefront = data.show_on_storefront OR false)
        save each variant
        FOR each branch with opening stock:
            create stock balance for each variant
            record stock movement "opening_stock"
        write_audit(user, "product_created", product)
    COMMIT
    RETURN product            // photos are added with upload_product_image
```

### 6.4 Compress and Upload a Product Image

```text
FUNCTION compress_to_target(image, sizes = [800, 640, 480]):
    // used on the device AND on the server; sizes = longest side in pixels
    // shop cover image uses sizes = [1200, 960, 800]
    FOR max_side IN sizes:
        resized = resize(image, longest side <= max_side)   // never enlarge
        top = encode_webp(resized, quality = 0.85)
        IF top.size <= 30 KB:
            RETURN top                     // fits at best quality
        best = none
        low = 0.40
        high = 0.85
        REPEAT up to 7 times:              // highest quality that fits
            q = (low + high) / 2
            candidate = encode_webp(resized, q)
            IF candidate.size > 30 KB:
                high = q
            ELSE:
                best = candidate
                low = q
                IF candidate.size >= 20 KB:
                    STOP REPEAT
        IF best exists:
            RETURN best
    RETURN error "Photo too detailed. Try a closer or plainer photo."

ON DEVICE, before upload:
FUNCTION prepare_image(file):
    IF file is not an image:
        RETURN "Choose a photo"
    image = decode(file), convert HEIC to JPEG if needed, apply camera rotation
    RETURN compress_to_target(image)

ON SERVER (never trusts the device):
FUNCTION upload_product_image(user, product_id, file):
    require_permission(user, "manage_products")
    product = find_product_in_tenant(session.tenant_id, product_id)
    IF product already has 5 images:
        RETURN image_limit_reached
    IF file.size > 10 MB:
        RETURN too_large
    IF type by file content (not name) NOT IN [JPEG, PNG, WebP]:
        RETURN unsupported_type
    image = safe_decode(file, max_pixels = 40 million)  // stops image bombs
    apply rotation, then strip ALL metadata (EXIF, GPS, camera details)
    output = compress_to_target(image)  // always re-encode; never store as-is
    IF output is an error:
        RETURN could_not_compress
    key = tenant_id + "/" + product_id + "/" + new_uuid() + ".webp"
    store output in object storage at key
    save product_image (key, bytes, width, height, sort_order)
    write_audit(user, "product_image_added", product)
    refresh storefront pages that show this product
    RETURN image_url
```

### 6.5 Scan or Select an Item

```text
FUNCTION add_item_to_cart(user, cart, input, quantity, source):
    // source: "scanner" (types the code + Enter), "camera", or "search"
    // offline, the same lookups run against the device's cached catalogue
    require_permission(user, "make_sale")
    found = parse_scanned_code(input, shop)       // 6.22: barcodes, scale labels
    IF found is not_found AND source == "search":
        show products whose name, generic name, or SKU match;
        cashier picks one and a unit
    IF nothing found:
        show "Product not found"
        offer quick product creation if user has "manage_products"
        RETURN
    variant, unit, quantity = found         // scale labels supply the quantity
    IF variant or its product is archived:
        show "Product unavailable"
        RETURN
    IF quantity <= 0 OR (unit has no fractions AND quantity is not whole):
        show "Enter a valid quantity"
        RETURN
    IF variant.prescription_only:
        run add_prescription_item (6.36); stop if refused
    IF variant has add-on groups:
        show the add-on picker (6.37) and wait for valid choices
    IF variant.tracking == "serial":
        REQUIRE one in-stock serial scanned or picked per unit
    IF variant.tracking == "batch" AND it has stock AND all of it is expired:
        show "Only expired stock left"
        RETURN
    IF the same variant, unit, and add-ons are already in the cart:
        increase that line's quantity
    ELSE:
        add line (variant, unit, quantity, add-ons, tax rule)
    line.unit_price = resolve_price(variant, unit, line.quantity, cart)  // 6.21
                      + sum(chosen add-on prices)
    available = available_base_units(branch, variant) - base units in cart
    IF available < 0:
        IF shop.allow_negative_stock:
            show warning "Stock shows none left. Manager will be alerted."
        ELSE:
            show "Not enough stock" and remove the extra quantity
    cart = calculate_cart_totals(cart, shop.tax_mode)
    show updated cart
```

### 6.6 Calculate Cart Totals

```text
FUNCTION calculate_cart_totals(cart, tax_mode):
    // whole pesewas only; round half up, once per line
    FOR each line:
        IF the line came from a price-carrying scale label:
            line.gross = the label price
        ELSE:
            line.gross = round(line.unit_price * line.quantity)
    IF the ticket has a service charge (food):
        add it as its own line, taxed by its own rule
    apply_pack_fee(cart)                // 6.56: takeaway and delivery packs
    cart = apply_promotions(cart)       // 6.29: sets line.promotion_discount
    spread cart.discount across lines in proportion to line.gross
        (leftover pesewas go to the largest line)
    FOR each line:
        line.net = line.gross - line.promotion_discount - line.discount
                   - line.share_of_cart_discount
        rate = line.tax_rule.rate_basis_points    // 1500 = 15%; the rule
                                                  // defines how levies stack
        IF tax_mode == "inclusive":               // price already has tax
            line.tax = line.net - round(line.net * 10000 / (10000 + rate))
            line.total = line.net
        ELSE:                                     // tax added at the till
            line.tax = round(line.net * rate / 10000)
            line.total = line.net + line.tax
    cart.subtotal = sum(line.gross)
    cart.discount = sum(line.promotion_discount + line.discount
                        + line.share_of_cart_discount)
    cart.tax = sum(line.tax)
    cart.total = sum(line.total)
    RETURN cart
```

### 6.7 Manager Approval

```text
FUNCTION request_approval(requester, action, context, approver_id, approver_pin):
    // used only when the requester lacks the permission themselves
    // actions: refund, large_discount, price_override, void_after_payment,
    //          cash_variance, credit_over_limit, refund_other_method
    approver = find_user_in_tenant(session.tenant_id, approver_id)
    IF approver == requester:
        RETURN self_approval_not_allowed
    IF approver is inactive OR NOT has_permission(approver, "approve_" + action):
        RETURN not_authorised
    IF NOT verify_pin_hash(approver, approver_pin):  // same lockout as 6.1
        RETURN wrong_pin
    save approval (requester, approver, action, context, reason, time)
    write_audit(approver, "approved_" + action, context)
    RETURN approval token: single use, valid for 2 minutes, bound to this
        context (sale ID + amount); a changed amount needs a new approval
```

### 6.8 Complete a Sale

```text
FUNCTION complete_sale(user, device, cart, tenders, sale_id, receipt_number,
                       from_offline_outbox = false):
    // sale_id and receipt_number were created on the device
    require_permission(user, "make_sale")
    existing = find_sale_in_tenant(session.tenant_id, sale_id)
    IF existing exists:
        RETURN existing                    // repeated request: no second sale
    IF shop.require_shifts AND no open shift for (user, device.register):
        RETURN open_shift_first
    re-check every line on the server: variant belongs to tenant, quantity
        valid, price equals current price unless a price_override approval
        is attached
    IF a price differs AND from_offline_outbox:
        accept the price the customer paid; flag sale for review (6.10)
    ELSE IF a price differs:
        RETURN price_changed
    IF a discount or override exceeds the user's limit:
        REQUIRE a valid approval token for this sale and amount (6.7)
    totals = calculate_cart_totals(cart, shop.tax_mode)  // server result wins
    IF non-cash tenders add up to more than totals.total:
        RETURN reduce_non_cash_amount      // only cash can produce change
    rounding = 0
    IF cash pays what is left after non-cash tenders:
        rounding = round_cash(cash part, shop).difference           // 6.40
    amount_due = totals.total + rounding
    change_due = max(0, sum(tender amounts) - amount_due)
    BEGIN DATABASE TRANSACTION
        create sale (id = sale_id, receipt_number, status = "pending",
                     totals, rounding, change_due, cashier,
                     salesperson (6.39), branch, register, shift,
                     coupon, ticket or order link, device_created_at)
        create sale lines with name, price, discount, and tax snapshots
        FOR each tender:
            IF tender.method == "cash":
                status = "confirmed"
            ELSE IF tender.method IN ["momo_manual", "card_terminal",
                                      "bank_transfer"]:
                REQUIRE tender.reference   // MoMo ID, slip number, etc.
                status = "confirmed", confirmed_by = user
            ELSE IF tender.method == "credit":
                REQUIRE credit_sale_check passes (6.13)
                status = "confirmed"
            ELSE IF tender.method IN ["store_credit", "gift_card"]:
                redeem_balance(tender)     // 6.31: locks balance, fails if low
                status = "confirmed"
            ELSE IF tender.method == "loyalty_points":
                redeem_points(tender)      // 6.30
                status = "confirmed"
            ELSE IF tender.method == "exchange_credit":
                status = "confirmed"       // value of returned items (6.32)
            ELSE IF tender.method == "order_payments":
                status = "confirmed"       // deposits already paid (6.34)
            ELSE IF tender.method == "channel_settlement":
                status = "confirmed"       // delivery app pays later (6.57)
            ELSE:                          // integrated provider payment
                status = "pending"         // only 6.11 can confirm it
            create payment (id = tender.id, sale_id, method, amount,
                            reference, status)
    COMMIT                                 // unique receipt_number per tenant
    IF any payment is "pending":
        start provider charge with reference = payment.id
        RETURN awaiting_payment            // 6.11 calls finalise_sale later
    result = finalise_sale(sale_id)
    IF result == sale_completed:
        show change_due; print or share receipt
    RETURN result
```

### 6.9 Finalise a Sale

```text
FUNCTION finalise_sale(sale_id):
    // safe to call many times, from the till or from a webhook
    BEGIN DATABASE TRANSACTION
        sale = lock sale row (SELECT ... FOR UPDATE)
        IF sale.status == "completed":
            COMMIT
            RETURN sale_completed          // no second stock deduction
        paid = sum of confirmed payments for the sale
        IF paid < sale.total + sale.rounding:
            COMMIT
            RETURN payment_incomplete      // sale stays "pending"
        FOR each line:
            deduct_stock_for_line(sale, line)   // 6.28: units, bundles,
                                                // recipes, batches, serials
        IF sale has a credit tender:
            add ledger entry (customer, "credit_sale", +amount, sale.id)
            customer.balance = customer.balance + amount
        FOR each gift card sold on the sale:
            sell_gift_card(line)                // 6.31
        IF sale has a coupon:
            mark the coupon use as "used"
        award_loyalty_points(sale)              // 6.30
        record_commission(sale)                 // 6.41
        sale.status = "completed"
        sale.completed_at = now
        write_audit(sale.cashier, "sale_completed", sale)
    COMMIT
    queue receipt delivery (print, link, WhatsApp, SMS) and dashboard refresh
    RETURN sale_completed
    // pending sales never count in sales totals and never reduce stock
    // a pending sale that is cancelled returns any store credit, gift card,
    // or points it redeemed, and releases its coupon
```

### 6.10 Offline Sales and Sync

```text
ON DEVICE:
EVERY 15 minutes while online, and after any catalogue change:
    refresh local cache: variants, prices, tax rules, images, shop settings,
        permissions, and PIN hashes of staff assigned to this register
    last_successful_sync = now

FUNCTION complete_sale_offline(user, cart, tenders):
    IF NOT shop.offline_enabled OR now - last_successful_sync > 72 hours:
        RETURN "Connect to the internet to continue"
    IF any tender is not cash or a manually confirmed payment:
        RETURN "Only cash and manually confirmed payments work offline"
    sale_id = new_uuid()
    receipt_number = next local counter for this register
    totals = calculate_cart_totals(cart, cached tax_mode)
    save sale in the device outbox (IndexedDB) with status "queued"
    reduce cached stock for display only
    print or share receipt marked "Offline - pending sync"

WHEN the connection returns, and every minute while sales are queued:
    FOR each queued sale, oldest first:
        response = complete_sale(..., from_offline_outbox = true)
        IF response is success OR the sale already exists:
            remove it from the outbox
        ELSE IF response is a temporary failure:
            keep it; retry with backoff
        ELSE:                              // e.g. staff deactivated
            keep it; mark "needs manager review"; show on dashboard

ON SERVER, for a sale from the outbox:
    store device_created_at (when it happened) and received_at (when it arrived)
    reports use device_created_at to pick the business day
    flag the sale if the price differed, the item was archived, or stock
        went negative
```

### 6.11 Payment Provider Webhook

```text
FUNCTION paystack_webhook(request):
    // platform account key for subscriptions; the shop's own account key
    // for integrated sale payments (Phase 6)
    expected = hex(HMAC_SHA512(raw request body bytes, Paystack secret key))
    IF NOT constant_time_equal(expected, request.header["x-paystack-signature"]):
        RETURN 401                         // forged or corrupted event
    // hash the raw bytes before parsing JSON; constant-time compare stops
    // timing attacks
    event = parse(request body)
    IF processed_event exists for ("paystack", event.type, event.data.reference):
        RETURN 200                         // duplicate delivery
    queue process_payment_event(event)
    RETURN 200                             // reply fast; work runs in the queue

FUNCTION process_payment_event(event):
    result = Paystack verify-transaction endpoint (event.data.reference)
    IF result.status != "success" OR amount or currency differ from expected:
        mark payment "failed" or "mismatch"; alert platform administrator
        RETURN
    BEGIN DATABASE TRANSACTION
        insert processed_event               // unique key blocks a second run
        IF reference belongs to a sale payment:
            payment.status = "confirmed"; payment.verified_at = now
        ELSE IF reference belongs to a subscription payment:
            extend_subscription(reference)   // 6.20
    COMMIT
    IF it was a sale payment:
        finalise_sale(payment.sale_id)
```

### 6.12 Returns and Refunds

```text
FUNCTION process_return(user, receipt_number, items, reason, refund_method):
    require_permission(user, "process_return")
    sale = find completed sale by receipt_number in session.tenant_id
    IF sale not found:
        RETURN receipt_not_found
    FOR each item:
        REQUIRE item.condition IN ["saleable", "damaged", "expired"]
        IF the product is serial-tracked:
            REQUIRE item.serial was sold on this sale line
        IF the item is a used gift card:
            RETURN "Gift cards cannot be returned once used"
        item.refund = round(line.total * item.quantity / line.quantity)
    refund_total = sum(item.refund)
    IF refund_method != original method AND user lacks "refund_other_method":
        REQUIRE approval (6.7)
    IF refund_total > shop.refund_limit OR user lacks "refund_without_approval":
        REQUIRE approval (6.7)
    BEGIN DATABASE TRANSACTION
        lock sale row                      // stops two returns at once
        FOR each item:
            already_returned = quantity on earlier returns for this line
            IF item.quantity > line.quantity - already_returned:
                ROLLBACK
                RETURN "Cannot return more than was sold"
        create return record (sale, reason, requester, approver)
        IF the original sale was on credit:
            add ledger entry (customer, "return", -refund_total)
        ELSE IF refund_method == "store_credit":
            issue_store_credit(customer, refund_total, "refund")    // 6.31
        ELSE IF refund_method == "exchange_credit":
            no money leaves; the value pays for the new items (6.32)
        ELSE:
            create refund payment (refund_method, -refund_total, reference)
        FOR each item:
            base_qty = item.quantity * line.unit.factor
            IF item.condition == "saleable":
                on_hand = on_hand + base_qty; movement "return_restock"
            ELSE:
                damaged or expired quantity increases;
                movement "return_" + item.condition
            batch-tracked: back into the batch it was sold from
            serial-tracked: serial status = "in_stock" or "damaged"
            bundles and recipes: restock components only if saleable
        reverse loyalty points and commission for the returned part
        write_audit(user, "return_processed", return)
    COMMIT
    print or share return receipt
    RETURN return_completed
```

### 6.13 Credit Sales and Debt Payments

```text
FUNCTION credit_sale_check(user, customer, amount):
    require_permission(user, "sell_on_credit")
    IF device is offline:
        RETURN "Credit sales need an internet connection"
    IF customer is none:
        RETURN "Select or add the customer"
    IF customer.balance + amount > customer.credit_limit:
        REQUIRE approval ("credit_over_limit", 6.7)
    RETURN ok          // finalise_sale (6.9) records the ledger entry

FUNCTION record_debt_payment(user, customer, amount, method, reference):
    require_permission(user, "receive_debt_payment")
    IF amount <= 0 OR amount > customer.balance:
        RETURN invalid_amount
    BEGIN DATABASE TRANSACTION
        create payment (method, amount, reference, customer, shift)
        add ledger entry (customer, "payment", -amount)
        customer.balance = customer.balance - amount
        write_audit(user, "debt_payment", customer)
    COMMIT
    print or share payment receipt showing the new balance

SCHEDULED JOB weekly:
    FOR each shop with credit sales enabled:
        send managers the list of customers who owe money, oldest debt first
        FOR each customer who consented to reminders:
            queue a polite SMS reminder (amount owed, shop phone)
```

### 6.14 Open and Close a Shift

```text
FUNCTION open_shift(user, register, opening_cash):
    IF register already has an open shift:
        RETURN shift_already_open
    create shift (user, register, opening_cash, opened_at = now)

FUNCTION cash_movement(user, shift, type, amount, reason):
    // type: "paid_in" or "paid_out"
    require_permission(user, "cash_movement")
    REQUIRE reason
    record movement in shift
    write_audit(user, type, shift)

FUNCTION close_shift(user, shift, counted_cash):
    cash_kept = cash tendered on completed sales - change given
    expected = shift.opening_cash + cash_kept + cash debt payments
               + paid_in - cash refunds - paid_out
    variance = counted_cash - expected
    IF abs(variance) > shop.variance_limit:
        REQUIRE reason AND approval ("cash_variance", 6.7)
    save expected, counted_cash, variance, closed_at = now
    print shift summary
```

### 6.15 End-of-Day SMS Report

```text
SCHEDULED JOB every 15 minutes:
    FOR each active shop whose daily report time has just passed
            (shop timezone; report time must be after the business-day cutoff):
        business_date = the business day that ended at the shop's cutoff
        FOR each branch in the report scope:
            key = (tenant, branch, "daily_sales", business_date)
            IF a report with this key was already queued:
                SKIP                       // job retries never double-send
            summary = completed sales with device_created_at in that day:
                gross sales, discounts, refunds, net sales, payment-method
                totals, transaction count, cash variance, sales still
                waiting to sync, and late-synced sales from earlier days
            message = format_concise_sms(summary)   // aim for 1-2 SMS parts
            FOR each authorised manager recipient:
                queue notification (key + recipient, "sms", message)
```

### 6.16 Weekly Stock SMS

```text
SCHEDULED JOB every 15 minutes:
    FOR each active shop whose weekly report time has just passed:
        key = (tenant, "weekly_stock", week_start_date)
        IF already queued:
            SKIP
        low_items = variants with 0 < on_hand <= reorder_level
        out_items = variants with on_hand <= 0       // includes negative stock
        near_expiry = batches expiring within the shop's warning period
        message = counts + top 5 priority items (fastest sellers first)
                  + near-expiry count and value
        IF there are more items than fit:
            add a secure dashboard link (sign-in required; no data in the URL)
        queue notification to authorised manager recipients
```

### 6.17 Notification Worker

```text
NOTIFICATION WORKER (runs continuously):
    FOR each queued notification, oldest first:
        IF channel == "sms" AND shop has used its SMS allowance:
            mark "blocked_quota"; show notice to owner
            CONTINUE
        result = send through provider (registered SMS sender ID, or email)
        store provider_message_id and delivery status
        IF temporary failure AND attempts < 5:
            retry later (1 min, 5 min, 30 min, 2 h, 6 h)
        ELSE IF permanent failure:
            mark "failed"; do not retry
    // unique key (report key + recipient) stops duplicate messages
    // messages never contain passwords, card numbers, or customer details
```

### 6.18 Publish and Show the Storefront

```text
FUNCTION publish_storefront(user, settings):
    require_permission(user, "manage_storefront")
    validate shop name, WhatsApp number in international format (233...),
        about text <= 500 characters, theme colour
    logo and cover go through compress_to_target (6.4)
    REQUIRE at least one product with show_on_storefront = true
    storefront.published = true
    write_audit(user, "storefront_published")
    refresh cached storefront pages

FUNCTION show_storefront(slug):            // public, no sign-in
    shop = find_shop_by_slug(slug)
    IF shop missing OR shop suspended OR storefront not published
       OR subscription past grace period OR storefront taken down:
        RETURN "This page is not available"       // HTTP 404
    products = public_catalogue(shop.tenant_id)
        // a database view that exposes only: name, description, public
        // price (or "Call for price"), images, category, and "In stock" /
        // "Out of stock" when enabled; active products marked
        // show_on_storefront only
        // never: cost price, exact stock, suppliers, staff, sales
    page = server-rendered page: shop details, announcement, featured
        products, category filter, search, and Open Graph tags (title,
        description, image) so shared links show a preview
    cache page for up to 10 minutes; refresh on product, price, or photo change
    count page view (date and count only; no personal data, no cookies)
    RETURN page

FUNCTION show_storefront_product(slug, product_slug):
    same checks as show_storefront
    RETURN product page with photos, price, availability,
        "Order on WhatsApp" and "Call" buttons
```

### 6.19 Storefront WhatsApp Order Link

```text
FUNCTION whatsapp_order_link(shop, product, product_url):
    text = "Hello " + shop.name + ", I would like to order " + product.name
           + " (" + format_ghs(product.public_price) + "). " + product_url
    count WhatsApp click for (shop, product, date)
    RETURN "https://wa.me/" + shop.whatsapp_number + "?text=" + url_encode(text)
    // the chat goes straight to the shop; the platform stores no messages
```

### 6.20 Annual Subscription and Renewal

```text
FUNCTION activate_subscription_manually(super_admin, tenant, payment):
    // Phase 1, before Paystack billing is automated
    require_permission(super_admin, "manage_subscriptions")
    REQUIRE payment.method, payment.reference, payment.amount, payment.period
    IF a subscription payment with this reference already exists:
        RETURN duplicate_reference
    extend subscription from max(end_date, today) by payment.period
    record payment
    write_audit(super_admin, "subscription_activated", tenant)

FUNCTION start_subscription(shop, chosen_method, consent):     // Phase 3
    show annual price, renewal date, terms, and how to cancel
    IF chosen_method == "card" AND consent.auto_renew:
        record consent (who, when, amount, exact wording shown)
    reference = new unique reference saved as "pending"
    open Paystack checkout (card first, mobile money as alternative)
    // never activate from the browser redirect; wait for 6.11

FUNCTION extend_subscription(reference):          // called by 6.11
    payment = find subscription payment by reference
    IF payment.status == "applied":
        RETURN                                    // already extended
    subscription.end_date = max(subscription.end_date, today) + 1 year
    subscription.status = "active"
    IF Paystack returned a reusable card authorisation AND consent.auto_renew:
        store the authorisation code (never card numbers)
    payment.status = "applied"
    email and SMS receipt

SCHEDULED JOB daily:
    FOR each subscription:
        days_left = end_date - today
        IF days_left IN [30, 7, 1]:
            email and SMS reminder (amount, date, method, how to cancel)
        IF days_left == 0 AND auto_renew AND a card authorisation exists:
            charge the authorisation with a new unique reference
            // the result arrives through 6.11
        IF the latest renewal charge failed (notify once per failure):
            notify owner; offer card update or a mobile money payment link
        IF days_left < 0 AND within grace period (proposed 14 days):
            POS works normally; show renewal banner
        IF past grace period:
            POS becomes read-only: view and export records, no new sales
            storefront hidden; all data kept according to retention policy
```

### 6.21 Resolve the Price

```text
FUNCTION resolve_price(variant, unit, quantity, cart):
    // unit = the unit being sold (piece, strip, carton);
    // unit.factor = base units in one of it
    list = cart.price_list
        OR cart.customer.price_list
        OR the branch's default price list
        OR "Retail"
    candidates = items on that list for (variant, unit) that are active,
        inside their start and end dates, with quantity >= min_quantity
    IF candidates exist:
        RETURN the candidate with the highest min_quantity   // quantity breaks
    IF unit has its own price:
        RETURN unit.price
    RETURN variant.base_price * unit.factor
    // whole pesewas per unit sold, before promotions and manual discounts
```

### 6.22 Read a Scanned Code

```text
FUNCTION parse_scanned_code(code, shop):
    IF code matches shop.scale_barcode_layout:     // EAN-13 starting with "2"
        IF check digit is wrong:
            RETURN not_found
        item_code = digits at the layout's item position
        value = digits at the layout's value position
        variant = find variant by scale item code in session.tenant_id
        IF layout carries weight:                  // value in grams
            RETURN (variant, variant.base_unit, quantity = value / 1000)
        ELSE:                                      // value in pesewas
            RETURN (variant, variant.base_unit,
                    quantity = round_3dp(value / variant.base_price),
                    label_price = value)
    barcode = find barcode record (code) in session.tenant_id
    IF barcode found:
        RETURN (barcode.variant, barcode.unit, quantity = 1)
    IF code is a gift card, coupon, or loyalty card number:
        hand it to the matching flow (6.29, 6.30, 6.31)
    RETURN not_found
```

### 6.23 Receive Stock

```text
FUNCTION receive_stock(user, branch, supplier, lines, purchase_order = none):
    require_permission(user, "receive_stock")
    BEGIN DATABASE TRANSACTION
        FOR each line:
            REQUIRE line.unit is purchasable for the variant
            base_qty = line.quantity * line.unit.factor
            IF product.tracking == "batch":
                REQUIRE line.batch_number AND line.expiry_date
                IF line.expiry_date <= today:
                    ROLLBACK
                    RETURN "Cannot receive expired stock"
                add base_qty to batch (variant, branch, batch_number, expiry_date)
            ELSE IF product.tracking == "serial":
                REQUIRE number of line.serials == base_qty
                REQUIRE each serial is new for this shop
                create serial records (status "in_stock", branch)
            unit_cost = line.total_cost / base_qty
            IF on_hand <= 0:
                variant.average_cost = unit_cost
            ELSE:
                variant.average_cost = (on_hand * average_cost + base_qty * unit_cost)
                                       / (on_hand + base_qty)   // weighted average
            on_hand = on_hand + base_qty
            create stock movement ("received", +base_qty, batch or serials,
                                   reference = receipt)
            IF purchase_order:
                purchase_order line.received = line.received + line.quantity
            assign any of these items reserved for special orders (6.34)
        IF purchase_order:
            status = "received" if every line is complete ELSE "partly_received"
        IF not paid now:
            record supplier bill (amount, due date from supplier terms)
        write_audit(user, "stock_received", receipt)
    COMMIT
```

### 6.24 Suggest Purchase Orders and Return to Supplier

```text
SCHEDULED JOB daily, and on demand:
    FOR each branch:
        FOR each variant with a reorder level or recent sales:
            daily_sales = average base units sold per day, last 28 days
            cover_days = supplier.lead_time_days + shop.reorder_cover_days
            target = max(reorder_level, daily_sales * cover_days)
            on_order = base units on open purchase orders
            need = target - (available + on_order)
            IF need > 0:
                round need up to whole supplier packs (e.g. whole cartons)
                add to a draft purchase order for the main supplier
    notify manager "Draft purchase orders ready for review"
    // a draft is never sent until a person reviews and approves it

FUNCTION return_to_supplier(user, supplier, lines, reason):
    require_permission(user, "supplier_returns")
    BEGIN DATABASE TRANSACTION
        FOR each line:
            REQUIRE quantity <= stock in the chosen bucket (saleable,
                damaged, expired), naming the batch or serials when tracked
            reduce that stock; movement "supplier_return"
        record supplier credit (refund or replacement expected)
        write_audit(user, "supplier_return", supplier)
    COMMIT
```

### 6.25 Transfer Stock Between Branches

```text
FUNCTION send_transfer(user, from_branch, to_branch, lines):
    require_permission(user, "transfer_stock")
    BEGIN DATABASE TRANSACTION
        FOR each line (batch or serials named when tracked):
            from_branch on_hand = on_hand - base_qty; movement "transfer_out"
            transfer in_transit = in_transit + base_qty
        transfer.status = "sent"; transfer.sent_by = user
    COMMIT

FUNCTION receive_transfer(user, transfer, received_lines):
    require_permission(user, "receive_stock") at transfer.to_branch
    BEGIN DATABASE TRANSACTION
        FOR each line:
            to_branch on_hand = on_hand + received; movement "transfer_in"
            in_transit = in_transit - sent
            IF received != sent:
                record difference with a reason; alert both branch managers
        transfer.status = "received"; transfer.received_by = user
    COMMIT
```

### 6.26 Stock Count and Adjustment

```text
FUNCTION start_stock_count(user, branch, scope):   // all, category, shelf, list
    require_permission(user, "stock_count")
    count = create stock count (branch, scope, started_at = now)
    save expected on_hand for every variant and batch in scope (snapshot)

FUNCTION record_count(count, variant, batch, counted_quantity):
    save counted quantity and counted_at = now     // repeat scans add up

FUNCTION finish_stock_count(user, count):
    FOR each counted item:
        expected = snapshot + net stock movements between count start
                   and the moment the item was counted   // selling continues
        difference = counted - expected
    value = sum(abs(difference) * average_cost)
    IF value > shop.count_approval_limit:
        REQUIRE approval ("stock_count", 6.7)
    BEGIN DATABASE TRANSACTION
        FOR each item with difference != 0:
            adjust on_hand; movement "count_adjustment"
        count.status = "completed"
        write_audit(user, "stock_count_completed", count)
    COMMIT
    report items counted, items not counted (left unchanged), and total value

FUNCTION adjust_stock(user, variant, batch, quantity, reason):
    // reason: damage, loss, theft, own_use, found, expiry_disposal
    require_permission(user, "adjust_stock")
    IF abs(quantity) * average_cost > shop.adjustment_approval_limit:
        REQUIRE approval ("stock_adjustment", 6.7)
    change the right bucket (on_hand, damaged, expired); movement with reason
    write_audit(user, "stock_adjusted", variant, reason)
```

### 6.27 Production (Items Made in Advance)

```text
FUNCTION record_production(user, branch, variant, quantity):
    // e.g. 40 loaves baked this morning
    require_permission(user, "record_production")
    BEGIN DATABASE TRANSACTION
        cost = 0
        FOR each ingredient in variant.recipe:
            used = ingredient.quantity * quantity
            ingredient on_hand = on_hand - used; movement "used_in_production"
            cost = cost + used * ingredient.average_cost
        variant on_hand = on_hand + quantity; movement "produced"
        update variant.average_cost with cost / quantity (weighted, as in 6.23)
        write_audit(user, "production_recorded", variant)
    COMMIT
```

### 6.28 Deduct Stock for a Sale Line

```text
FUNCTION deduct_stock_for_line(sale, line, from_reserved = false):
    // runs inside finalise_sale's transaction (6.9)
    base_qty = line.quantity * line.unit.factor
    IF line.variant.kind IN ["bundle", "recipe", "combo"]:
        FOR each component of the line (a combo uses the customer's choices):
            deduct_stock_for_line(sale, component line with
                quantity = component.quantity * base_qty)
        FOR each chosen add-on with ingredients:
            deduct those ingredients the same way
        RETURN                            // bundles and recipes hold no stock
    IF line.variant.tracking == "batch":
        batches = line.chosen_batch, OR this branch's batches with stock > 0
                  that are not expired, earliest expiry first
        take base_qty across batches in that order; save the batches on the line
        IF batched stock runs out:
            take the rest from the first batch (it goes negative) and flag it
    ELSE IF line.variant.tracking == "serial":
        REQUIRE each serial on the line is "in_stock" in this branch
        mark each serial "sold"; link it to the sale and customer
    IF from_reserved:                     // layaway, special, online orders
        reserved = reserved - base_qty
    on_hand = on_hand - base_qty
    create stock movement ("sale", -base_qty, batch or serial, reference = sale.id)
    IF on_hand < 0:
        queue "negative stock" alert to manager
```

### 6.29 Apply Promotions and Coupons

```text
FUNCTION apply_promotions(cart):
    // called by calculate_cart_totals (6.6) before tax and manual discounts
    clear automatic discounts on the cart
    active = promotions running now (date, day, time) for this branch and
             the cart customer's group
    FOR each line:
        options = active promotions matching the line's product or category
        best = the option giving the largest discount (tie: oldest promotion)
        apply best, plus any options marked stackable
    FOR each "buy X get Y" or "N for a price" promotion:
        group matching units; apply to complete groups only;
        the cheapest units in each group are the discounted ones
    FOR each cart-level promotion (e.g. 10% off above GHS 200):
        apply if the cart still qualifies after line promotions
    IF a coupon code is on the cart:
        coupon = find coupon in session.tenant_id
        REQUIRE coupon active, not expired, uses left, and the customer's
                own limit not reached
        apply its promotion; hold the use as "pending" on the sale
        // the use becomes "used" only when the sale completes (6.9)
    RETURN cart
```

### 6.30 Loyalty Points

```text
FUNCTION award_loyalty_points(sale):            // inside finalise_sale (6.9)
    IF NOT shop.loyalty_enabled OR sale.customer is none:
        RETURN
    eligible = amount paid with money tenders (not store credit, gift card,
               or points), after discounts, minus tax
    points = floor(eligible / shop.pesewas_per_point)
    add loyalty entry (customer, "earned", +points, sale)
    customer.points = customer.points + points

FUNCTION redeem_points(tender):                 // tender in complete_sale (6.8)
    customer = lock customer row
    REQUIRE tender.points <= customer.points AND tender.points >= shop.min_redeem
    tender.amount = tender.points * shop.point_value_pesewas
    add loyalty entry (customer, "redeemed", -tender.points, sale)
    customer.points = customer.points - tender.points

ON a return from a sale that earned points:
    remove the points earned on the returned amount
    // the balance may go negative; future purchases pay it back

SCHEDULED JOB monthly, if the shop sets points to expire:
    expire points older than shop.points_expiry_months; record entries
    SMS customers 14 days before their points expire (if they consented)
```

### 6.31 Store Credit and Gift Cards

```text
FUNCTION issue_store_credit(customer, amount, source, approval = none):
    // source: refund, no_receipt_return, top_up (paid), goodwill
    REQUIRE customer is identified (name and phone)
    IF source == "goodwill":
        REQUIRE approval ("goodwill_credit", 6.7)
    add ledger entry (customer, "credit_issued", +amount, source)
    customer.store_credit = customer.store_credit + amount

FUNCTION sell_gift_card(line):                  // inside finalise_sale (6.9)
    code = new random 16-character code          // unguessable, not sequential
    create gift card (hash of code, balance = line amount, expiry if the
                      shop sets one, sold on sale)
    print the code as a barcode on the receipt, or send it by SMS
    // reported as money held for customers until it is spent

FUNCTION redeem_balance(tender):                // inside complete_sale (6.8)
    IF tender.method == "store_credit":
        account = lock the customer's store credit
    ELSE:                                       // gift card
        IF this device entered 5 wrong gift card codes in 10 minutes:
            RETURN try_again_later
        account = lock gift card found by hash of tender.code
        REQUIRE account is active AND not expired
    REQUIRE account.balance >= tender.amount
    account.balance = account.balance - tender.amount
    add ledger entry ("redeemed", -tender.amount, sale)

FUNCTION check_gift_card_balance(code):          // rate-limited
    RETURN balance and expiry only
```

### 6.32 Exchange

```text
FUNCTION process_exchange(user, receipt_number, returned_items, new_cart, tenders):
    // a linked return and a new sale, inside ONE database transaction
    return_value = refund value of returned_items, calculated as in 6.12
    new_total = calculate_cart_totals(new_cart, shop.tax_mode).total
    difference = new_total - return_value
    BEGIN DATABASE TRANSACTION
        run the return steps of 6.12 with refund_method = "exchange_credit"
        run the sale steps of 6.8 for new_cart, with an "exchange_credit"
            tender of min(return_value, new_total)
        IF difference > 0:
            customer pays the difference with tenders (normal rules)
        IF difference < 0:
            refund -difference by the original method or as store credit,
            using the approval rules of 6.12
        link the return and the new sale to each other
    COMMIT
    finalise_sale(new sale)
    print one receipt showing returned items, new items, and the difference
```

### 6.33 Return Without a Receipt

```text
FUNCTION return_without_receipt(user, customer, items, reason):
    REQUIRE shop.allow_no_receipt_returns
    REQUIRE customer name and phone
    IF customer's no-receipt returns this month >= shop.no_receipt_monthly_limit:
        RETURN monthly_limit_reached
    REQUIRE approval ("no_receipt_return", 6.7)
    FOR each item:
        item.value = lowest price the item sold for in the last 90 days
    BEGIN DATABASE TRANSACTION
        create return record (no receipt, reason, requester, approver)
        issue_store_credit(customer, sum(item.value), "no_receipt_return")
        restock by condition as in 6.12           // never pays out cash
        write_audit(user, "no_receipt_return", customer)
    COMMIT
```

### 6.34 Layaway, Deposits, and Special Orders

```text
FUNCTION create_layaway(user, customer, cart, deposit):
    require_permission(user, "layaway")
    totals = calculate_cart_totals(cart, shop.tax_mode)
    REQUIRE deposit >= totals.total * shop.layaway_min_deposit_percent / 100
    BEGIN DATABASE TRANSACTION
        create order (type "layaway", status "open", customer, lines with
                      price snapshots, total, due date)
        move items from available to reserved (batch or serials named)
        record the deposit payment against the order
    COMMIT
    print a layaway slip showing the balance and due date

FUNCTION pay_order(user, order, tender):
    record part payment against the order
    IF payments >= order.total:
        order.status = "ready"; SMS customer "Ready to collect"

FUNCTION collect_order(user, order):
    REQUIRE payments >= order.total
    create sale from the order with an "order_payments" tender (6.8)
    finalise_sale with deduct_stock_for_line(..., from_reserved = true)
    order.status = "collected"

FUNCTION cancel_order(user, order, reason):
    REQUIRE approval ("cancel_order", 6.7)
    return reserved items to available stock
    refund payments minus shop.cancellation_fee by the original method,
        or as store credit, according to the shop setting
    order.status = "cancelled"

FUNCTION create_special_order(user, customer, items, deposit):
    create order (type "special", status "waiting_for_stock", deposit)
    add items to the next draft purchase order (6.24), marked for this order
    WHEN the items are received (6.23):
        reserve them for the order; SMS customer "Your order has arrived"

SCHEDULED JOB daily:
    remind customers of layaway due dates (3 days before and on the day)
    alert managers about overdue layaways
```

### 6.35 Quotes and Business Invoices

```text
FUNCTION create_quote(user, customer, cart, valid_days):
    totals = calculate_cart_totals(cart, shop.tax_mode)
    quote = save quote (number, customer, lines with prices, totals,
                        valid_until = today + valid_days)
    RETURN PDF and link to share by WhatsApp or email

FUNCTION convert_quote(user, quote, target):      // target: sale or invoice
    IF quote.valid_until < today:
        REQUIRE approval ("honour_expired_quote", 6.7)
    create the sale or invoice at the quoted prices (the quote counts as
        the price override approval)
    quote.status = "converted"

FUNCTION create_invoice(user, business_customer, cart, due_date):
    require_permission(user, "issue_invoices")
    REQUIRE customer name, address, and TIN when the shop requires it
    run the checks of complete_sale (6.8) with an "invoice" (unpaid) tender
    finalise as a credit sale: stock deducted, ledger entry for the amount owed
    IF shop is VAT-registered AND E-VAT applies:
        submit the invoice to GRA E-VAT and print the returned
        verification details (once confirmed, section 4.11)
    send invoice PDF; reminders 3 days before, on, and 7 days after the due date
```

### 6.36 Prescription-Only Medicine Sale

```text
FUNCTION add_prescription_item(user, cart, variant):
    IF shop.otc_only:                              // licensed chemical seller
        RETURN "This medicine cannot be sold here"
    IF user lacks "dispense_prescription":
        REQUIRE approval by a pharmacist ("dispense_prescription", 6.7)
    REQUIRE patient name, prescriber name, facility, prescription date
    optional: photo of the prescription (compress_to_target, private storage)
    attach the prescription record to the cart line
    IF no unexpired batch has stock:
        RETURN "Only expired stock left"
    // prescription records are health data: pharmacist-only access,
    // never in SMS, never on the storefront
```

### 6.37 Food Orders: Tickets, Add-Ons, and Kitchen

```text
FUNCTION open_ticket(user, label, table = none, dining_option):
    ticket = create open ticket (label or table, waiter = user,
                                 dining_option, status "open")
    IF table:
        table.status = "ordering"

FUNCTION add_food_item(ticket, variant, quantity, add_on_choices, note):
    FOR each add-on group on the item:
        REQUIRE number chosen between group.min and group.max
    add line (variant, quantity, add-ons, note, kitchen_status "new")
    line.unit_price = resolve_price(...) + sum(add-on prices)

FUNCTION send_to_kitchen(ticket):
    new_lines = lines with kitchen_status "new"
    FOR each kitchen station (kitchen, bar, grill) with lines in new_lines:
        print a kitchen ticket or show it on the kitchen display:
            ticket label or table, waiter, time, items, add-ons, notes
    mark those lines kitchen_status "sent", sent_at = now
    IF table: table.status = "waiting_for_food"

KITCHEN DISPLAY (browser screen per station):
    show sent lines grouped by ticket, oldest first, coloured by waiting time
    staff tap "Ready"; the waiter's device shows "Ready: Table 5"

FUNCTION void_sent_item(user, ticket, line, reason):
    REQUIRE reason AND approval ("void_sent_item", 6.7)
    print a cancel slip at the station; line.kitchen_status = "void"
    IF the kitchen says it was already prepared:
        record the ingredients as waste (movement "waste")

FUNCTION move_lines(user, from_ticket, to_ticket, lines):
    move the lines; merge tickets if all lines move; write_audit

FUNCTION close_ticket(ticket):
    cart = ticket lines (+ service charge if the shop uses one)
    pay with complete_sale (6.8) or split_bill (6.38)
    IF table: table.status = "free"
```

### 6.38 Split a Bill

```text
FUNCTION split_bill(ticket, mode, parts):
    // mode: "by_item", "by_seat", or "equal"
    IF mode == "equal":
        each part = ticket total / parts, in whole pesewas;
        leftover pesewas go to the first part
    ELSE:
        each part = the lines chosen for it
        (a shared line can be split into fractions of its quantity)
    FOR each part:
        complete_sale(part as its own sale, own tenders, own receipt)
    the ticket closes when every part is paid
    // the parts always add up exactly to the ticket total
```

### 6.39 Order at One Counter, Pay at Another

```text
FUNCTION send_order_to_cashier(salesperson, cart):
    order = save cart as type "counter", status "awaiting_payment",
            with a short order number (e.g. 0427)
    print or show an order slip with the number and items
    // stock is not deducted until payment

FUNCTION collect_counter_order(cashier, order_number):
    order = find open counter order in session.tenant_id and branch
    cart = order lines (the cashier cannot change prices)
    complete_sale(cashier, cart, ...) with sale.salesperson = order creator
    order.status = "paid"; the customer collects goods with the receipt

SCHEDULED JOB every 15 minutes:
    cancel counter orders unpaid for longer than shop.counter_order_expiry
    (proposed: 2 hours)
```

### 6.40 Cash Rounding

```text
FUNCTION round_cash(amount, shop):
    // used only when cash pays what is left of the sale
    step = shop.cash_rounding_step        // e.g. 10 pesewas; 0 = switched off
    IF step == 0:
        RETURN (amount, difference = 0)
    rounded = round_half_up(amount / step) * step
    RETURN (rounded, difference = rounded - amount)
    // the difference is saved on the sale and shown in reports
```

### 6.41 Staff Commission

```text
FUNCTION record_commission(sale):               // inside finalise_sale (6.9)
    person = sale.salesperson OR sale.cashier
    FOR each line:
        rule = the most specific active rule: product, then category,
               then the person's default
        IF rule is a percentage:
            amount = round(rule.percent * line.net / 100)  // after discounts,
                                                           // before tax
        ELSE:
            amount = rule.fixed_amount * line.quantity
        add commission entry (person, sale, line, amount)

ON a return:
    add negative commission entries for the returned part

REPORT: commission per person per period; the owner marks a period as paid
```

### 6.42 Marketing SMS Campaign

```text
FUNCTION send_campaign(user, segment, message, send_at):
    require_permission(user, "marketing")
    recipients = customers in segment WITH marketing_consent = true
                 AND not opted out
    message = message + shop's opt-out text (e.g. "Reply STOP to opt out"
              where the SMS provider supports replies, otherwise a short
              opt-out link)
    cost = number of recipients * SMS parts
    show cost and remaining allowance; REQUIRE the user to confirm
    IF send_at is between 21:00 and 07:00 shop time:
        move send_at to 07:00
    queue one notification per recipient, key = (campaign, recipient)

ON an opt-out (reply "STOP" or the opt-out link):
    mark that phone number opted out for that shop
    never send it marketing SMS again; receipts and reminders still allowed
```

### 6.43 Record an Expense

```text
FUNCTION record_expense(user, branch, category, amount, method, note, photo):
    require_permission(user, "record_expenses")
    IF amount > shop.expense_approval_limit:
        REQUIRE approval ("expense", 6.7)
    IF method == "cash" AND there is an open shift:
        record it as paid_out in the shift (6.14)
    IF photo:
        store compress_to_target(photo) in private storage
    save expense; write_audit(user, "expense_recorded", expense)
```

### 6.44 Add and Deactivate Staff

```text
FUNCTION add_staff(owner, details):
    require_permission(owner, "manage_staff")
    REQUIRE check_plan_limit(tenant, "staff") == ok          // 6.48
    create user (role preset, branches, registers, status "invited")
    send invite by SMS or email; the staff member sets their own password
        and PIN at first sign-in (the owner never sees them)

FUNCTION deactivate_staff(owner, staff, reason):
    require_permission(owner, "manage_staff")
    staff.status = "inactive"
    end the staff member's sessions on every device
    remove their PIN hash from device caches at the next sync
    IF they have an open shift:
        a manager must close it (6.14)
    write_audit(owner, "staff_deactivated", staff, reason)
    // past sales keep the staff member's name
```

### 6.45 Import Data from CSV

```text
FUNCTION import_csv(user, type, file):
    // type: products, customers, opening_stock, opening_balances
    require_permission(user, "import_data")
    REQUIRE file <= 5 MB and <= 10,000 rows (proposed)
    parse with the published template for that type
    validate every row; show errors with row numbers
    IF any row fails:
        let the user fix the file, or skip the failing rows explicitly
    show a preview of the first 20 rows; REQUIRE confirmation
    BEGIN DATABASE TRANSACTION
        create records; opening stock as "opening_stock" movements;
        opening customer balances as "opening_balance" ledger entries
        write_audit(user, "import", type, row count)
    COMMIT
```

### 6.46 Export Data and Close an Account

```text
FUNCTION export_data(owner, datasets):
    require_permission(owner, "export_data")   // works in read-only expiry too
    build CSV files in the background
    prefix any cell starting with = + - or @ with an apostrophe
        (stops spreadsheet formula attacks)
    send a download link valid for 24 hours; sign-in required to download
    write_audit(owner, "data_exported", datasets)

FUNCTION close_account(owner):
    REQUIRE password again, plus second factor if enabled
    offer export first
    shop.status = "closed"; storefront removed; all staff signed out
    keep data for the retention period (to confirm), then delete it
    log the deletion
```

### 6.47 Platform Support Access

```text
FUNCTION grant_support_access(owner, hours, reason):
    REQUIRE hours <= 72
    create support session (shop, granted_by = owner, reason,
                            expires_at = now + hours)

FUNCTION platform_support_view(platform_user, shop):
    IF no active support session for shop:
        REQUIRE emergency access with a written reason
        notify the owner immediately
    every page viewed and every action is written to the shop's audit log
        as "platform support: <name>"
    support staff never see password hashes, PIN hashes, or full card data
```

### 6.48 Plan Limits and Free Trial

```text
FUNCTION check_plan_limit(tenant, resource):
    // resource: branch, register, staff, product, sms, or a module
    used = number of active records of that resource
    IF used >= plan.limit(resource):
        RETURN limit_reached               // UI shows an upgrade notice
    RETURN ok
    // called on the server before creating a record;
    // a downgrade never deletes data

FUNCTION start_trial(created_by, details):
    // Phase 1: created_by = platform administrator
    // Phase 3: self sign-up after phone and email verification
    create shop as in 6.2 with subscription status "trial",
        end_date = today + 14 days (proposed)
    trial limits: SMS capped (proposed 50), online payments off
    reminders 3 days and 1 day before the trial ends
    at trial end without payment: the read-only rules of 6.20 apply
```

### 6.49 Storefront Online Order (Later Phase)

```text
FUNCTION place_online_order(visitor, slug, cart, fulfilment, contact, source):
    // fulfilment: pickup or delivery; source from the link tag
    // (storefront, whatsapp, instagram, facebook)
    REQUIRE the visitor verified their phone by SMS code (first order only)
    rate-limit orders per phone number and per IP address
    re-check each item is published and available; prices from the public
        catalogue only
    order = create order (type "online", status "awaiting_payment",
                          contact, fulfilment, source)
    reserve stock
    IF paying by Paystack:
        open checkout on the shop's own Paystack account; 6.11 confirms it
    ELSE IF paying by transfer:
        visitor uploads proof (compress_to_target, private storage)
        status = "proof_uploaded"; shop staff confirm the money arrived
            and enter the reference
    SMS the shop about the new order; SMS the customer at each status
        change (confirmed, ready, out for delivery)
    unpaid orders expire after shop.online_order_expiry; reservations released
```

### 6.50 Customer-Facing Display

```text
FUNCTION pair_customer_display(register):
    show a 6-digit pairing code on the register (valid 10 minutes)
    the display page enters the code and is linked to that register only

CUSTOMER DISPLAY:
    follow the register's active cart (read-only): items, discounts, total,
        change due, and the shop's MoMo number or payment QR code
    between sales: show the shop's promotions
    never show staff details, other carts, or reports
```

### 6.51 Counter Orders, Order Numbers, and the Ready Board

```text
// Counter mode: pay first, collect by number.
// Quick serve mode: pay first, served on the spot, no kitchen order.
// Table mode: tickets, pay at the end (6.37, 6.38).

FUNCTION next_order_number(branch, device):
    // online: one counter per branch, restarts each business day
    IF branch.order_counter_date != current business date:
        branch.order_counter = 0
        branch.order_counter_date = current business date
    branch.order_counter = branch.order_counter + 1
    RETURN zero_pad(((branch.order_counter - 1) MOD 999) + 1, 3)   // 001-999
    // offline: the device uses its register prefix and a local counter
    // (e.g. "T2-047") so two tills never give out the same number

FUNCTION complete_counter_order(user, device, cart, tenders):
    result = complete_sale(user, device, cart, tenders, ...)        // 6.8
    IF result == sale_completed:
        number = next_order_number(device.branch, device)
        create kitchen order (sale, number, dining_option, status "preparing")
        send_to_kitchen (6.37)
        print the receipt with the order number in large type
    RETURN result

FUNCTION mark_order_ready(kitchen_user, kitchen_order):
    kitchen_order.status = "ready"; kitchen_order.ready_at = now
    IF the customer gave a phone number AND the shop sends ready SMS:
        queue SMS "Order 047 is ready"
    // takeaway and delivery orders also pass the packing check (6.58)

FUNCTION mark_order_collected(user, kitchen_order):
    IF the order is takeaway, delivery, phone, or delivery-app:
        REQUIRE the packing check passed (6.58)
    kitchen_order.status = "collected"; kitchen_order.collected_at = now

READY BOARD (browser page on a TV, paired like the customer display, 6.50):
    show this branch's orders for today in two columns: "Preparing", "Ready"
    a ready number stays for 10 minutes or until collected
    show numbers only: never names, phone numbers, or items
```

### 6.52 Combo Meals

```text
// a combo is a sellable variant of kind "combo" with:
//   fixed items   (e.g. 2 pieces of chicken, regular chips)
//   choice slots  (e.g. "Drink": Coke, Fanta, Sprite, water; choose 1)
//   upgrades      (e.g. "Large drink" +GHS 5 inside the Drink slot)

FUNCTION add_combo_to_cart(cart, combo, choices):
    FOR each slot in combo.slots:
        REQUIRE number chosen between slot.min and slot.max
        REQUIRE every choice is allowed in that slot and not sold out (6.55)
    line.unit_price = combo.price + sum(upgrade prices of the choices)
    line.components = combo.fixed_items + choices
    add line to cart

FOR REPORTS:
    split the combo's net price across its components in proportion to each
    component's normal price, so item sales and food cost stay correct
    (tax uses the combo's own tax rule)

STOCK:
    finalise_sale deducts every fixed item and every chosen item (6.28);
    recipe items deduct their ingredients
```

### 6.53 Sell by Amount

```text
FUNCTION add_amount_item(user, cart, variant, amount):
    // e.g. "GHS 10 rice", "GHS 5 stew", "GHS 15 waakye"
    REQUIRE variant.sell_by_amount
    REQUIRE amount >= variant.min_amount
    IF variant is sold out today (6.55):
        RETURN "Sold out"
    add line (variant, quantity = 1, unit_price = amount, by_amount = true)
    // a plate of "GHS 10 rice + GHS 5 stew + chicken" is three lines
    // (or one line with add-ons); proteins can be normal priced items
    // by-amount lines do not deduct stock per sale; pots do (6.54)
```

### 6.54 Pot Tracking and Closing Count

```text
// each sell-by-amount item has a pot recipe (ingredients for one pot) and
// an expected sales value per pot set by the owner (e.g. GHS 600 of jollof)

FUNCTION record_pots(user, branch, variant, pots):          // e.g. 3 pots
    deduct the pot recipe's ingredients * pots (as in 6.27)
    today's pot record for (branch, variant): cooked = cooked + pots

FUNCTION record_closing_leftover(user, branch, variant, leftover_pots):
    // e.g. 0.25 = a quarter pot left
    REQUIRE 0 <= leftover_pots <= cooked
    expected = (cooked - leftover_pots) * variant.value_per_pot
    actual = completed by-amount sales of the variant today - their refunds
    variance = actual - expected
    save pot record (cooked, leftover, expected, actual, variance)
    IF expected > 0 AND abs(variance) / expected * 100 > shop.pot_variance_limit:
        // proposed limit: 10%
        alert manager, e.g. "Jollof: sold GHS 1,560, expected GHS 1,800 (-13%)"
    IF the shop keeps leftovers for tomorrow:
        tomorrow's record starts with cooked = leftover_pots
    ELSE:
        record the leftover as waste (movement "waste")

SCHEDULED JOB at the business-day cutoff:
    remind staff to record leftovers for every item with pots cooked today
```

### 6.55 Sold-Out Switch

```text
FUNCTION mark_sold_out(user, variant, branch):
    require_permission(user, "mark_sold_out")   // cashier and kitchen by default
    set sold_out for (variant, branch, current business date)
    push the change to every device in the branch, open tickets, and the
        storefront cache
    write_audit(user, "sold_out", variant)
    // delivery-app menus are updated by staff on the platform's own tablet

FUNCTION mark_available_again(user, variant, branch):
    clear the flag; push the change the same way

WHEN a cashier or waiter adds a sold-out item:
    show "Sold out today"; do not add it
WHEN a combo slot choice is sold out:
    hide that choice
AT the start of the next business day:
    every sold-out flag clears automatically
```

### 6.56 Takeaway Pack Fee

```text
FUNCTION apply_pack_fee(cart):              // called by calculate_cart_totals (6.6)
    IF cart.dining_option IN ["takeaway", "delivery"]
       OR cart.channel is a delivery app or phone delivery:
        IF shop.pack_fee_mode == "per_item":
            packs = units in the cart of items marked needs_pack
                    // bottled drinks, for example, are not marked
        ELSE:                               // "per_order"
            packs = 1
        set a "Takeaway pack" line: packs * shop.pack_fee, its own tax rule
        // container stock is deducted at finalise if the shop tracks packs
    ELSE:
        remove any "Takeaway pack" line
```

### 6.57 Delivery-App and Phone Orders

```text
// channels: walk_in (default), bolt_food, chowdeck, phone, whatsapp
// each channel has: optional price list, commission percent, and who
// collects the customer's money (the app, or the shop)

FUNCTION enter_channel_order(user, channel, external_order_id, cart, customer):
    require_permission(user, "enter_channel_orders")
    IF channel is a delivery app:
        REQUIRE external_order_id
        IF a sale with (channel, external_order_id) exists in this tenant:
            RETURN "This order was already entered"
        cart.price_list = channel.price_list, if set
        tenders = ["channel_settlement" for the full total]   // app pays later
        complete_counter_order(...) with sale.channel and external_order_id
        commission = round(sale.total * channel.commission_percent / 100)
        save commission on the sale
        add receivable (channel, sale.total - commission, expected payout)
    ELSE:                                   // phone or WhatsApp
        REQUIRE customer name and phone
        record pickup time, or delivery address (GhanaPostGPS digital
            address or landmark) when the shop delivers by its own means
        IF paid in advance (MoMo reference):
            complete_counter_order(...) with sale.channel
        ELSE:                               // pay at pickup or on delivery
            open a ticket named after the customer (6.37), send it to the
            kitchen, and take payment when it is collected

FUNCTION record_channel_payout(user, channel, amount, reference, period):
    match the payout to that channel's open receivables for the period
    show differences (missing orders, extra deductions) to the manager
```

### 6.58 Packing Check

```text
FUNCTION start_packing(packer, order):
    // for takeaway, delivery, phone, and delivery-app orders
    show on screen or print the checklist: every item, quantity, add-on,
        note, and pack line

FUNCTION tick_item(packer, order, line):    // tap on screen, or scan the item
    mark the line packed (packer, time)

FUNCTION hand_over(user, order, handed_to):  // customer, or rider name and app
    IF any line is not ticked:
        RETURN "Pack every item before handing over"
    order.status = "handed_over"; order.handed_over_at = now
    order.handed_to = handed_to
    save packing record (packer, items, times)
    // a later complaint can be checked against who packed what, and when
```

### 6.59 Basic Food Reports

```text
REPORT food_daily(branch, business_date or date range):
    sales by hour (orders and value), to show rush hours
    item sales: quantity and value per item; best 10 and slowest 10
    by channel: orders, sales, commission, sales after commission
    wastage and staff meals: quantity and cost by reason
    pot variance per sell-by-amount item (6.54)
    average kitchen time: sent to kitchen -> ready
    average counter wait: paid -> collected
    // filters: branch, dates, service mode; export to CSV (6.46)
```

## 7. Recommended Data Records

Money fields are whole pesewas. Quantity fields are decimals with up to 3 places. Every record below that belongs to a shop carries tenant_id and is protected by Row-Level Security.

| Record | Important fields |
| --- | --- |
| Tenant / Shop | tenant_id, shop name, slug, shop type (retail, pharmacy, food), enabled modules, plan, contact details, timezone, currency, status, tax mode, business-day cutoff, report times, settings (require shifts, allow negative stock, offline enabled, refund limit, variance limit, cash rounding step, expiry warning days, OTC only, service charge, loyalty rates, no-receipt return limit), SMS allowance |
| Branch / Location | branch_id, tenant_id, branch_code, address, contact, operating hours, food service modes (counter, table, quick serve), order counter and its business date |
| Register / Device | register_id, tenant_id, branch_id, register_code, device registration, last receipt counter, last sync time, status |
| User / Staff | user_id, tenant_id, role preset, permission flags, assigned branches, status, PIN hash, failed PIN count, PIN locked until, MFA setting |
| Product | product_id, tenant_id, name, description, category, brand, tax rule, tracking mode (none, batch, serial), status, show on storefront, featured; pharmacy: generic name, strength, dosage form, registration number, prescription only |
| Variant | variant_id, product_id, tenant_id, kind (standard, bundle, recipe), option values (size, colour), SKU, base unit, allows fractions, base price, average cost, reorder level, scale item code, sellable, status; food: sell by amount, minimum amount, pot recipe, value per pot, needs pack |
| Combo Slot | combo variant, slot name, min and max choices, allowed choices with upgrade prices; plus the combo’s fixed items |
| Kitchen Order | kitchen_order_id, sale or ticket, order number, dining option, status (preparing, ready, collected, handed over), sent, ready, and collected times, handed to |
| Packing Record | kitchen_order_id, lines ticked, packer, times |
| Pot Record | branch_id, variant_id, business date, pots cooked, leftover, expected sales, actual sales, variance |
| Sold Out | branch_id, variant_id, business date, set by, set at |
| Channel | channel_id, tenant_id, name (walk-in, Bolt Food, Chowdeck, phone, WhatsApp), price list, commission percent, who collects payment |
| Channel Receivable / Payout | channel, sale, amount expected after commission, payout reference, payout amount, matched status |
| Unit | unit_id, variant_id, name (strip, pack, carton), factor in base units, own price, sellable, purchasable |
| Barcode | code (unique per tenant), tenant_id, variant_id, unit_id |
| Price List / Price List Item | price_list_id, tenant_id, name, type (retail, wholesale, customer group, branch), start and end dates; items: variant_id, unit_id, min quantity, price |
| Batch | batch_id, tenant_id, branch_id, variant_id, batch number, expiry date, on-hand, received date, supplier |
| Serial Number | serial, tenant_id, variant_id, branch_id, status (in stock, sold, returned, damaged), sale_id, customer_id, warranty end |
| Component | parent variant, component variant, quantity in base units (bundles and recipes) |
| Production | production_id, branch_id, variant_id, quantity, ingredients used, cost, user, timestamp |
| Add-on Group / Add-on | group: name, min and max choices, required; add-on: name, price, ingredient deductions |
| Product Image | image_id, tenant_id, product_id, storage key, bytes, width, height, sort order |
| Tax Rule | tax_rule_id, tenant_id, name, rate in basis points, how levies stack, active |
| Stock Balance | tenant_id, branch_id, variant_id, on-hand, reserved, damaged, expired, in transit, updated_at (all in base units) |
| Stock Movement | movement_id, tenant_id, branch_id, variant_id, batch or serial, movement type, quantity in base units, reason, user, timestamp, reference |
| Sale | sale_id (device UUID), tenant_id, branch_id, register_id, cashier_id, salesperson_id, shift_id, customer_id, ticket or order link, coupon, receipt number, totals, cash rounding, change given, status (pending, completed, voided), from offline, needs review, device_created_at, received_at, completed_at; food: channel, external order ID, commission, dining option, order number |
| Sale Line | sale_id, variant_id, unit_id, name snapshot, quantity, unit price, add-ons, note, promotion discount, manual discount, share of cart discount, tax, line total, batches or serials taken, prescription_id |
| Payment | payment_id, sale_id or order_id, method (cash, momo_manual, card_terminal, bank_transfer, credit, store_credit, gift_card, loyalty_points, exchange_credit, order_payments, provider), amount, provider, reference, status (pending, confirmed, failed, refunded), confirmation type, confirmed_by, verified_at |
| Return / Refund | return_id, original sale, items, condition per item, reason, refund amount, refund method, restock status, requester, approver |
| Customer | customer_id, tenant_id, name, phone, business name and TIN, customer group, price list, consent flags (marketing, reminders), opted out, credit limit, balance, store credit, loyalty points, birthday month |
| Loyalty Entry | entry_id, customer_id, type (earned, redeemed, reversed, expired), points, sale_id, timestamp |
| Store Credit / Gift Card | account: customer_id or gift card code hash, balance, expiry, status; ledger entries: type, amount, source, sale_id, user, timestamp |
| Promotion / Coupon | promotion: type, rules, products or categories, branches, customer groups, schedule, stackable; coupon: code, promotion, total uses, uses per customer, expiry, uses so far |
| Order | order_id, tenant_id, type (layaway, special, counter, online), status, customer, lines with price snapshots, total, payments, due date, source, fulfilment, proof of payment |
| Quote / Invoice | number, customer, TIN, lines, totals, valid until or due date, status, payments, E-VAT reference |
| Prescription | prescription_id, tenant_id, sale line, patient name, prescriber, facility, prescription date, photo key (private), pharmacist |
| Open Ticket / Table / Kitchen Station | ticket: label or table, waiter, dining option, status, lines with kitchen status and sent time; table: name, seats, status; station: name, printer or display, categories |
| Customer Ledger | entry_id, customer_id, type (credit sale, payment, return, adjustment), amount, reference, user, timestamp |
| Approval | approval_id, tenant_id, requester, approver, action, context, reason, timestamp, token used |
| Shift / Cash Drawer | shift_id, cashier_id, register_id, opening cash, paid in and out lines, expected cash, counted cash, variance, opened_at, closed_at |
| Expense | expense_id, tenant_id, branch_id, category, amount, payment method, note, entered_by, date |
| Supplier / Purchase Order | supplier details, payment terms, lead time, pack sizes; order lines, units, expected and received quantities, costs, status |
| Supplier Bill / Supplier Return | supplier, amount owed, due date, payments; return lines, reason, credit expected |
| Transfer | transfer_id, from branch, to branch, lines, status, sent_by, received_by, differences |
| Stock Count | count_id, branch, scope, started_at, lines (snapshot, counted, counted_at, difference), status, approver |
| Commission Rule / Entry | rule: scope (product, category, staff), percent or fixed amount; entry: person, sale, line, amount, paid period |
| Campaign | campaign_id, tenant_id, segment, message, recipients, cost, send time, status |
| Plan | plan name, price, limits per resource, modules included |
| Support Session | tenant_id, granted_by, platform user, reason, emergency flag, start, expiry |
| Storefront | tenant_id, published, logo, cover, about text, address, map link, hours, phone, WhatsApp number, social links, theme colour, show prices, show availability, announcement and end date, taken down by platform |
| Storefront Statistics | tenant_id, date, product_id (optional), page views, product views, WhatsApp clicks, call clicks |
| Subscription | tenant_id, plan, start date, end date, status, renewal consent, card authorisation code, payment references, grace period, manual payment records |
| Processed Event | provider, event type, reference, processed_at, result (unique key) |
| Notification Log | tenant_id, report key, recipient, channel, message type, queued time, attempts, provider ID, delivery status |
| Audit Log | tenant_id, actor, action, record type, record ID, timestamp, reason, relevant change summary |

## 8. Additional Features Recommended from Established POS Products

Version 3 compared this specification with Loyverse, Square, Shopify POS, Lightspeed Retail, Odoo Point of Sale, Bumpa, and Hubtel. The features they document are now part of this specification. Product names are listed only as reference points, not as claims that every feature is available in every country or on every plan.

- **Offline selling with later sync (Loyverse, Odoo):** section 4.9, pseudocode 6.10.
- **Camera scanning, scale and weight barcodes, several barcodes per item (Loyverse, Odoo):** sections 4.1 and 4.16, pseudocode 6.22.
- **Variants, units of measure, and price lists with quantity pricing (Odoo, Lightspeed):** section 4.15, pseudocode 6.21.
- **Composite items, ingredients, and production (Loyverse):** section 4.18, pseudocode 6.27 and 6.28.
- **Serial numbers and batch/expiry tracking (Lightspeed, Hubtel):** section 4.17, pseudocode 6.23 and 6.28.
- **Purchase orders, suggested reorders, transfers, stock counts, adjustments, inventory history and valuation (Loyverse, Square, Lightspeed):** section 4.19, pseudocode 6.23–6.26.
- **Exchanges, refunds to store credit, gift cards, eWallet top-ups (Square, Shopify, Odoo):** sections 4.4 and 4.20, pseudocode 6.31–6.33.
- **Loyalty points, loyalty cards, customer discounts (Loyverse, Odoo):** section 4.20, pseudocode 6.29 and 6.30.
- **Layaway and special orders (Lightspeed):** section 4.21, pseudocode 6.34.
- **Business invoices with customer VAT/TIN numbers, credit limits (Odoo):** sections 4.5 and 4.22, pseudocode 6.13 and 6.35.
- **Modifiers, open tickets, dining options, kitchen printers, kitchen display, bill splitting, tips (Loyverse, Odoo):** section 4.24, pseudocode 6.37 and 6.38.
- **Counter ordering with order numbers and combo meals (KFC Ghana, Pizzaman Chickenman); delivery-app orders (Bolt Food, Chowdeck):** section 4.24, pseudocode 6.51, 6.52, and 6.57.
- **Order at one point of sale, pay at another (Odoo):** pseudocode 6.39.
- **Cash rounding (Odoo):** pseudocode 6.40.
- **Staff PINs, permissions, sales attribution for commissions, time clock (Shopify, Loyverse):** sections 4.6 and 2, pseudocode 6.1, 6.7, and 6.41.
- **Customer-facing display (Loyverse):** section 4.28, pseudocode 6.50.
- **Online store tied to the POS, order source tracking, proof-of-payment upload (Bumpa):** section 4.12, pseudocode 6.49.
- **SMS receipts, bulk SMS to customers, settlement of mobile money and card payments (Hubtel):** sections 4.10, 4.25, and 4.3, pseudocode 6.42.
- **Cash management and shift discrepancies (Loyverse, Odoo):** section 4.6, pseudocode 6.14.
- **Reports export and API (Loyverse):** section 4.29.

## 9. Security, Reliability, and Data Protection

- Enforce tenant isolation in every API endpoint, background job, report, export, and database query. Do not rely on hidden buttons or front-end checks for security.
- Back tenant isolation with PostgreSQL Row-Level Security on every tenant table, and run automated cross-tenant tests in every phase.
- The public storefront reads only from a database view that exposes approved public fields. It can never reach cost prices, stock counts, staff, customers, or sales.
- Use HTTPS, secure password hashing, session protection, rate limits (sign-in, PIN, storefront), account recovery verification, and optional multi-factor authentication for owners and administrators.
- Only registered devices can use the POS offline. Devices can be deregistered remotely. Cached PIN hashes use a slow hashing method.
- Image uploads are checked by content type, size, and pixel count, re-encoded on the server, and stripped of all metadata, including GPS location.
- Prescription records are health data, which Act 843 treats as special personal data: private storage, pharmacist-only access, never in SMS, exports only by the owner, and never on the storefront.
- Gift card codes are random, stored only as hashes, and rate-limited on entry and balance checks. Store credit, gift card, and points balances are changed only inside locked database transactions.
- CSV exports neutralise cells starting with =, +, -, or @ so spreadsheets do not run them as formulas.
- Platform support sees a shop only through a logged support session (section 4.29).
- Store payment provider references and status only. Never store raw card numbers or CVV values.
- Verify Paystack webhooks, validate their signatures according to current documentation, and verify transaction status server-side.
- Use database transactions for sale completion and stock changes. Add unique constraints and idempotency keys to prevent duplicate processing.
- Back up data regularly, test restoration, monitor failures, and keep an audit trail for important actions.
- **Data Protection Act, 2012 (Act 843):** register the platform with Ghana’s Data Protection Commission, limit access to customer data, document retention rules, and check the rules for storing personal data on servers outside Ghana.
- Comply with applicable Ghanaian tax requirements, including GRA invoicing rules for VAT-registered shops (section 4.11).
- Use a queue for SMS, email, reports, and payment events so temporary service failures do not block checkout.
- Make the interface responsive and accessible on small phone screens, tablets, laptops, and desktop computers.
- Provide clear error messages and a safe recovery process for interrupted sales, printer failures, and failed payment requests.

## 10. Billing and Operational Decisions

### 10.1 Decided in Version 2

- Shop addresses are path-based (example.com/<slug>); subdomains and custom domains come later.
- Negative stock is allowed by default, flagged, and alerted; shops can switch to blocking.
- Phase 1 payments at the counter are recorded manually with a reference; integrated payments come in Phase 6.
- Subscriptions are activated manually in Phase 1; Paystack billing is automated in Phase 3.
- Offline checkout, variants, decimal quantities, and whole-pesewa money are part of Phase 1.
- Two devices selling the last unit at the same moment both complete; stock goes negative and the manager is alerted.
- Product images are stored at 20–30 KB WebP with metadata removed.
- Retail, pharmacy, and food shops are all supported at launch, on one shared core with modules.
- Stock is valued at weighted average cost; batches sell earliest expiry first; expired batches cannot be sold.
- The customer gets the best single automatic promotion per line unless promotions are marked stackable.
- Returns without a receipt give store credit only, with approval.
- Food open tickets work offline on the device that holds them; sharing them between devices needs internet.
- Food businesses use three service modes (Counter, Table, Quick serve), mixable per branch.
- Sell-by-amount items are tracked by pots cooked and leftovers at closing, not per plate.
- Delivery-app orders are entered by hand at the POS at launch, with the platform’s order ID and commission rate.
- A thermal kitchen printer through the print helper is the default kitchen setup.

### 10.1a Decided on 2026-10-26

- GRA E-VAT integration is a later phase, not a launch requirement (section 4.11).
- Pharmacies launch with basic rules: batch and expiry tracking and a prescription-only flag, with no regulator reporting (section 4.23).
- Monthly plan prices start at GHS 150 / 300 / 600 for Starter / Standard / Pro (section 4.27).
- The production database is PostgreSQL on Neon instead of Supabase (section 11). Product photo storage and the live-screen channel need a non-Supabase choice.

### 10.2 Still Open

- Pharmacy Council and FDA Ghana rules for prescription records, retention, and controlled medicines; whether prescription-only medicines may appear on the storefront at all.
- Food businesses: check sell by amount and pot tracking with 3–5 local eateries before building; confirm the pot variance limit (proposed: 10%) and whether service charge and tips are needed.
- Commission rates for Bolt Food and Chowdeck are entered by each shop from its own contract; published rates were not verified.
- Free trial length and SMS cap (proposed: 14 days, 50 SMS), and when self sign-up opens.
- Which modules each plan includes, and staff, product and SMS limits per plan (prices and branch/till limits are decided, section 4.27).
- Where product photos are stored now that Supabase Storage is not used (for example Cloudflare R2 or Vercel Blob), and which real-time channel drives live screens.
- Loyalty earn and spend rates, points expiry, gift card expiry under consumer law, and store credit expiry.
- No-receipt return limit (proposed: 2 per customer per month), layaway minimum deposit (proposed: 20%), and cancellation fee.
- Data retention period after account closure.
- Annual subscription prices, taxes, currency, renewal term, and cancellation policy.
- Grace period length and expired-shop access (proposed: 14 days, then read-only with export, storefront hidden).
- Whether Paystack recurring card charges are enabled for the merchant account and market. Automatic recurring mobile money must not be promised unless the channel supports it.
- SMS allowance per plan, charges for extra SMS, recipient verification, retry policy, message language, and report delivery times.
- Offline limit (proposed: 72 hours since last sync).
- The onboarding (KYC) and settlement model for integrated payments at the till: each shop’s own Paystack account or platform subaccounts.
- When the storefront gains online orders, and whether the platform also offers a public directory of all shops.
- Give the shop owner advance notice of the exact renewal amount and date, a clear way to cancel future automatic renewal, and a receipt for each successful charge.

### 10.3 Not in Scope (Decided)

These were considered for food businesses and deliberately left out of this specification. Adding any of them later is a new decision.

- Own delivery management: delivery zones and fees, rider assignment, rider tracking, and rider cash reconciliation.
- Automatic MoMo confirmation by request-to-pay prompts at the till (manual MoMo references remain; integrated Paystack payments in Phase 6 are unchanged).
- Head-office tools for restaurant chains: central menu control, price zones, and chain-wide promotion management.
- QR code ordering at the table and self-order kiosks.
- Direct connections to delivery apps (Bolt Food, Chowdeck); their orders are entered by hand.
- Detailed food analytics beyond the basic reports in 6.59.

## 11. Recommended Technology

Recommended stack (a builder may adjust it with reason):

- **Application:** Next.js with TypeScript for the POS, back office, and server-rendered storefront.
- **Database:** PostgreSQL on Neon (pooled connection, no prepared statements) with Row-Level Security. Authentication is the app's own (section 6.1). Product photo storage is still to choose (section 10.2).
- **Offline:** PWA with a service worker and IndexedDB for the cached catalogue and the sale outbox.
- **Hosting and jobs:** Vercel for the application; scheduled jobs trigger report and renewal work; a queue table in PostgreSQL feeds the notification and payment workers.
- **Images:** browser canvas compression on the device; the sharp library on the server.
- **Camera scanning:** the browser’s built-in BarcodeDetector where available, with the ZXing library as fallback (for example on iPhones).
- **SMS and email:** a Ghanaian SMS provider (such as Hubtel, Arkesel, or mNotify) chosen on price and sender-ID approval time, plus a transactional email service.
- **Live screens:** a real-time channel (to choose; for example server-sent events or a hosted pub/sub service) for kitchen displays, customer displays, and open tickets shared between devices.
- **Local print helper:** a small app on the shop’s computer or Android device that prints to receipt, kitchen, and label printers over USB, Bluetooth, or the network using ESC/POS, and opens the cash drawer, without print dialogs.

## 12. Implementation Phases

Retail, pharmacy, and food launch together, so the first release is split into Phase 1a and Phase 1b. The platform launches at the end of Phase 1b.

- **Phase 1a: Core platform and full data model.** Tenants and shop addresses, shop types and modules, manual onboarding and subscription activation, sign-in and staff PINs, role presets, products with variants, units and conversions, several barcodes and scale barcodes, price lists, batch/expiry/serial tracking, bundles and recipes, compressed images, scanner/camera/search checkout, cash and manually confirmed payments, store credit, receipts (print, link, WhatsApp), stock deduction with movement history, stock receiving, offline sale queue, plan limits, basic dashboard, audit log, Row-Level Security, and tests for tenant isolation, duplicate sales, and offline sync.
- **Phase 1b: Pharmacy and food modules, returns, and controls (launch).** Earliest-expiry-first selling, expiry blocks and reports, prescription records, generic-name search; food service modes (Counter, Table, Quick serve), order numbers and Ready board, combo meals, sell by amount and pot tracking, sold-out switch, takeaway pack fee, delivery-app and phone orders, packing check, basic food reports, add-ons, open tickets, tables, kitchen printing and display, split bills, service charge, production, wastage; returns, exchanges, returns without receipt, manager approvals, order at one counter and pay at another, cash rounding, staff management, CSV import, the local print helper, and the free trial.
- **Phase 2: Storefront and business controls.** Storefront with WhatsApp ordering, shifts and cash reconciliation, credit sales, quotes and business invoices, expenses, daily and weekly SMS, report and data exports, marketing SMS, and platform support sessions.
- **Phase 3: Billing automation.** Paystack card and mobile money checkout for subscriptions, webhook and server-side verification, renewal reminders, recurring card renewal where supported, failed-payment handling, expiry, reactivation, and self sign-up for trials.
- **Phase 4: Advanced inventory.** Purchase orders, suggested reorders, supplier bills and returns, transfers, stock counts and adjustments, barcode labels, inventory valuation, and low-stock alerts.
- **Phase 5: Customer growth.** Automatic promotions and coupons, loyalty points, gift cards, layaway and special orders, staff commissions, and the customer-facing display.
- **Phase 6: Larger retailers, online orders, and integrations.** Many registers per branch, integrated Paystack payments at the till, storefront online orders, accounting exports, API and outgoing webhooks, and subdomains or custom domains.

GRA E-VAT integration moves into Phase 1b if VAT-registered shops are among the first customers (section 4.11).

Testing and launch readiness run in every phase, not only at the end: tenant-isolation tests, payment-webhook tests, duplicate-event tests, stock concurrency tests, offline sync tests, backup restoration, security review, SMS delivery tests, and usability tests on phones, tablets, scanners, and printers.

## 13. Acceptance Tests

- A shop administrator cannot access another shop’s URL data, products, sales, reports, or employees by changing an ID or URL.
- A database query run without a tenant filter returns no rows belonging to other shops (Row-Level Security test).
- A cashier can complete a sale by scanning a barcode, by scanning with a phone camera, and by searching manually on a phone without a scanner.
- A successful sale reduces stock exactly once, even if a request or payment webhook is delivered more than once.
- A sale sent twice with the same sale ID creates one sale, one receipt number, and one stock deduction.
- A sale made offline syncs exactly once after reconnecting, counts toward the business day in which it happened, and keeps the price actually paid.
- A failed or unverified electronic payment does not mark the sale as paid. A pending sale does not appear in sales totals and does not reduce stock.
- Cart totals are correct to the pesewa for tax-inclusive and tax-exclusive shops, including cart-level discounts.
- A manager receives the configured daily sales SMS and weekly stock SMS once per period, even if the job runs twice, with delivery attempts recorded.
- A staff member cannot perform a refund, large discount, or stock adjustment without the required permission or approval, and cannot approve their own request.
- A return larger than the remaining unreturned quantity is refused, including across several returns.
- A returned product updates stock only according to its recorded condition and restocking decision.
- A credit sale above the customer’s limit needs approval. A debt payment reduces the balance and the receipt shows the new balance.
- The system records opening cash, expected closing cash, counted cash, and any variance for a shift.
- Every stored product image is WebP, no larger than 30 KB, and has no EXIF or GPS metadata, even when the device skipped compression.
- A storefront shows only active products marked “Show on storefront”, and never shows cost prices or exact stock counts.
- An unpublished, suspended, taken-down, or past-grace storefront shows “not available”.
- A storefront product link shared on WhatsApp shows the product photo and name in the preview, and the WhatsApp button opens a chat with the shop’s number and a pre-filled message.
- A verified annual payment activates or extends the subscription exactly once.
- A failed renewal does not falsely extend the subscription and triggers the configured notice.
- A shop can renew after expiry and recover access to its retained records and storefront.
- A wholesale customer gets the wholesale price, and buying at or above a quantity break gets the break price.
- Selling one strip of 10 tablets reduces stock by 10 tablets; receiving one carton of 24 adds 24 pieces.
- A scale label adds the right weight or price; a label with a wrong check digit is rejected.
- An expired batch cannot be sold, and the earliest-expiring unexpired batch is used first.
- A serial number can be sold only once, and a return must name a serial sold on that receipt.
- Selling a recipe item reduces each ingredient by the recipe amount, including add-on ingredients. Recording production reduces ingredients and adds finished stock.
- Weighted average cost is correct after receiving stock at a new cost.
- A prescription-only medicine cannot be sold without pharmacist permission or approval and a prescription record. An OTC-only shop cannot sell it at all.
- Kitchen tickets reach the right station once per item. Voiding a sent item needs approval and prints a cancel slip.
- The parts of a split bill add up exactly to the ticket total.
- The best promotion is applied. A coupon cannot be used beyond its limits, and a coupon on an abandoned sale is not used up.
- Store credit, gift card, and loyalty balances never go below zero, even when two sales use the same balance at the same moment.
- An exchange charges or refunds only the difference.
- A return without a receipt gives store credit only, needs approval, and respects the monthly limit.
- Layaway stock is reserved and cannot be sold to someone else; cancelling returns it to available stock.
- A stock count taken while selling continues adjusts only the real differences.
- Loyalty points and commission earned on a sale are removed when the sale is returned.
- Cash rounding never changes a non-cash payment, and the rounding difference appears in reports.
- A shop at its plan limit cannot add another staff member, product, or branch, and no data is deleted after a downgrade.
- Marketing SMS go only to customers who opted in, never after an opt-out, and never between 9 pm and 7 am.
- Platform support cannot view a shop without a support session, and every support action appears in the shop’s audit log.
- Exported CSV cells starting with =, +, -, or @ are neutralised.
- Order numbers restart each business day per branch, never repeat within a day (including two tills offline), and the Ready board shows only numbers.
- A combo deducts stock for the items the customer chose, and an upgrade adds its price.
- A sell-by-amount sale below the minimum is refused. When actual sales differ from expected pot sales by more than the limit, the manager is alerted.
- A sold-out item cannot be added at any till in the branch, disappears from the storefront within minutes, and is available again the next business day.
- Takeaway and delivery orders get the pack fee automatically; eat-in orders do not.
- A delivery-app order cannot be entered twice with the same platform order ID, and channel reports show sales minus commission.
- A takeaway, delivery, phone, or delivery-app order cannot be marked handed over until every item is ticked on the packing check.
- Kitchen tickets still print during an internet outage through the print helper.
- The interface is usable on common phone, tablet, and desktop screen sizes.

## 14. Reference Products and Further Reading

- **Loyverse Back Office and analytics:** Sales reports, inventory, employee management, and customer tools. https://loyverse.com/en-us/back-office
- **Loyverse inventory features:** Purchase orders, stock transfers, stock adjustments, inventory counts, and inventory history. https://loyverse.com/features
- **Shopify POS staff management:** Staff PINs, roles, location access, and manager approvals. https://help.shopify.com/en/manual/sell-in-person/shopify-pos/staff-management/understanding-pos-staff-management
- **Shopify POS permissions:** Permission controls for refunds, discounts, sales, and other restricted actions. https://help.shopify.com/en/manual/your-account/users/roles/permissions/pos-permissions
- **Square POS features:** Sales reporting, inventory alerts, and downloadable reports. https://squareup.com/gb/en/point-of-sale/features
- **Paystack documentation:** Use current Paystack documentation to confirm supported checkout methods, recurring charges, transaction verification, and webhooks before implementation. https://paystack.com/docs/
- **Loyverse restaurants and kitchen display:** Modifiers, open tickets, composite items, kitchen display. https://loyverse.com/restaurants-pos and https://loyverse.com/kitchen-display-system
- **Odoo Point of Sale features:** Offline mode, pricelists, units of measure, cash rounding, invoicing, eWallet, gift cards, multi-step checkout. https://www.odoo.com/app/point-of-sale-features
- **Square for Retail:** Purchase orders, vendor management, exchanges, store credit, cross-location returns. https://square.com/us/en/point-of-sale/retail/pricing
- **Lightspeed Retail:** Serial numbers, special orders, layaways, purchase orders. https://www.lightspeedhq.com/au/pos/retail/features/
- **Bumpa:** Online store linked to POS, order source tracking, proof-of-payment checks. https://www.getbumpa.com/blog/bumpa-pos-for-businesses-in-nigeria
- **Hubtel retail features:** Mobile money and card collection, inventory with expiry alerts, SMS receipts, bulk SMS. https://news.hubtel.com/hubtel-introduces-new-features-for-retailers-their-customers/
- **GRA E-VAT:** Electronic VAT invoicing for VAT-registered businesses. https://gra.gov.gh/e-vat/
- **KFC Ghana app:** Delivery or pickup ordering, online deals. https://apps.apple.com/qa/app/kfc-ghana/id6444767085
- **Pizzaman-Chickenman:** Ghanaian fast-food chain, 89+ branches. https://en.wikipedia.org/wiki/Pizzaman-Chickenman
- **Chowdeck in Ghana:** Food delivery in Accra since May 2025. https://techcabal.com/2025/07/31/chowdeck-hits-1000-daily-orders-ghana/
- **Bolt Food merchants (Ghana):** Orders managed from a tablet, phone, or POS integration. https://bolt.eu/en-gh/_legacy/food/merchant/

## 15. Final Note

This document is a functional blueprint and pseudocode specification. Before production development it should be converted into detailed database schemas, API contracts, interface designs, security rules, and test cases. Payment behaviour, especially recurring card billing and mobile money, must be validated against the current Paystack merchant account and documentation. Tax and E-VAT obligations must be confirmed with GRA, and data protection registration with the Data Protection Commission.
