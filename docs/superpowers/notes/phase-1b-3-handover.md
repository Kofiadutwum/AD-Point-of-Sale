# Phase 1b-3 hand-over: channels, phone orders, payouts, food report

## Migrations
- `0014_food_channels` (generated): `sales_channels`; `sales.channel_id`, `external_order_id`, `commission_pesewas` with the partial unique index `sales_channel_order`; tender `channel_settlement`; kitchen order channel, customer, pickup, address, `pay_on_collect`, `pending_lines`; `channel_receivables`, `channel_payouts`.
- `0015_food_channels_rls` (custom): tenant isolation on the three tables, cache trigger on `sales_channels`, `enter_channel_orders` for sellers in kitchen-module shops, `manage_channels` for owners and managers.

## Sale contract
`food` gains `channelId`, `externalOrderId`, `customer`, `pickupAt`, `deliveryAddress`, `kitchenOrderId`.
- Channel orders are Counter mode, takeaway or delivery, and need `enter_channel_orders` for both the signed-in user and the recorded cashier.
- Delivery app: order ID 1–64 characters, unique per channel. A duplicate is refused from the outbox too (`channel_order_exists`). Two tills racing: the unique index decides, and the loser gets the same error.
- App collects the money: exactly one `channel_settlement` tender for the total. A settlement tender anywhere else is `invalid_tender`. A receivable of total minus commission is saved.
- Phone or WhatsApp: name, Ghana phone (stored `233XXXXXXXXX`), and a pickup time or address.
- Collecting a phone order (`kitchenOrderId`): the order's lines first and in order, then only pack lines (`order_changed`), priced at today's prices. The kitchen order keeps its number and gets the sale.

## Services
- `phone-orders.ts`: create (online only, next order number, kitchen order unpaid), find today's open order by number, cancel with a reason.
- `channel-payouts.ts`: open receivables per app; a payout matches the period's open receivables (locked) and saves the difference.
- `food-reports.ts`: completed sales by business date (at most 92 days); hours in the shop timezone; combos split over their parts by current price; channels after commission; wastage; pots; kitchen and counter times; CSV through `toCsv`.

## Device
`DeviceCache.channels` (active only); `priceCart(…, { priceListId })`; `channel_settlement` on the device; `outboxHasChannelOrder` stops a second entry of an app order still waiting to send.

## Screens
- Till: Channel picker (Walk-in first) in Counter mode; app order ID; "Paid by the app"; phone customer fields; "Pay on collection" (online) prints a kitchen slip; "Collect phone order" loads a locked cart.
- Kitchen: channel, customer, pickup or address, "Not paid", and Cancel with a reason.
- `/[slug]/app/settings/channels`, `/[slug]/app/channels/payouts`, `/[slug]/app/reports/food` with "Download CSV".

## Shortcuts
- Pickup times and the report's default date are read as Ghana time (UTC+0). Use the shop timezone when other countries join.

## Not checked by hand
The screens build and type-check, and services are covered by tests (509). The browser walk-through in plan Task 9 Step 1 has not been done yet.

## Review fixes
- A phone order is paid for even after its item sold out (it was cooked already).
- A pack scanned by hand is dropped from a phone order; the pack is added at collection.

## Deferred
- Expiry of unpaid phone orders (no job runner), refunds in channel and item figures (returns do not exist yet), direct Bolt or Chowdeck connections.
- Review minors: two payouts saved at once with one reference: the second gets `nothing_to_match` instead of `duplicate_reference` (data stays right). The till does not check phone customer details offline, and an app settlement that no longer matches the total after a tax change is refused, not held for review. Deactivating a channel strands its unpaid phone orders (cancel only). A phone order can be taken at a branch without counter service.
