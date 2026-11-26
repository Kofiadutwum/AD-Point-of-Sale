# Phase 5 hand-over: customer growth

Spec 4.20, 4.21, 4.28, 6.29–6.34, 6.41, 6.50.

## What was built

- **Schema** (migrations 0050, 0051), with RLS:
  - new file `src/db/schema/growth.ts`: `promotions`, `coupons`, `coupon_uses`, `loyalty_entries`, `gift_cards` (code hash plus sealed code), `gift_card_entries`, `customer_orders` and `order_payments` (layaway and special orders; money held), `commission_rules`, `commission_entries`, `customer_displays`, `cart_snapshots`, `display_pairings`;
  - columns: `customers.loyalty_points` and `loyalty_code`; `sale_lines.promotion_discount_pesewas`; `sales.coupon_id`; `variants.is_gift_card`; `stock_balances.reserved`;
  - tenant settings for loyalty, gift card expiry, layaway deposit, cancellation fee and refund method, and the MoMo number;
  - tenders `points`, `gift_card`, and `deposit` (the last is server only);
  - permissions `manage_promotions`, `layaway` (also allowed on a till PIN), `manage_commissions`;
  - approval action `cancel_order`.
- **Promotions** (`src/lib/promotions.ts`, pure and shared):
  - kinds: percent or amount off items; buy X get Y (the cheapest units); N for a price; percent or amount off the cart above a minimum;
  - limits: date range, days, happy-hour times, branches, and coupon-only;
  - each line gets its best promotion, plus any marked as adding on.
  - The server (`completeSaleTx`) applies them on top of manual discounts and checks the figure the till sent (`promotionDiscountPesewas`). A mismatch is refused online (`price_changed`); offline, the till's figure is kept and the sale is flagged `promotion_changed`.
  - The offline till (device cache now carries promotions and product categories) and the online sell screen both compute the same discounts. Coupons are checked on the sell screen (`previewCoupon`) and used up when the sale completes.
- **Loyalty** (`src/server/rewards.ts`):
  - points are earned on money tenders, after discounts and without tax;
  - spending points is a tender with a minimum; a return takes points back in proportion;
  - `expirePoints` is a monthly job, and the loyalty-card code finds a customer.
- **Gift cards**:
  - a gift-card product issues a 16-character code per unit sold; no stock moves for it;
  - the code is shown after the sale and on the signed-in receipt with a barcode, never on the public receipt link;
  - a card is spent in parts as a tender (the payment stores only the last 4 characters);
  - balance check; unspent balances are reported as money held.
- **Commissions**: the most specific rule wins (product, then category, then person, then shop default), as a percent of the line after discounts or a fixed amount per item. Returns reverse commission; the report runs per person, and the owner marks a period paid.
- **Layaway and special orders** (`src/server/customer-orders.ts`):
  - layaway: a deposit of at least the shop minimum; items are reserved (available = on hand − reserved; the storefront uses this); part payments; ready and SMS when fully paid; collected as a sale whose tender is the order's payments; cancelling needs a manager, and refunds less the fee go back as store credit or cash;
  - special orders: added to suggested purchase orders; when stock arrives (`order-arrivals.ts`, called from both receive paths) they become ready and the customer gets an SMS (kind `order`, which counts against the shop's allowance).
- **Customer display**: a 6-digit pairing code (10 minutes) links a screen at `/[slug]/display` to one register. The online sell screen pushes its cart, and the display polls every 2 s. Between sales it shows the promotions running at that branch and the MoMo number.
- **Screens**: `/app/promotions` (promotions, coupons, loyalty, gift cards), `/app/orders` and `/app/orders/[id]`, `/app/commissions`, `/app/display`, public `/[slug]/display`; settings "Layaway and customer display"; home links.

## Tests

`tests/server/growth.test.ts` (11): the engine, server checking of promotions, coupons, loyalty, gift cards, commissions, layaway, special orders, and the display.

## Not done / notes

- Gift card sales count as sales in reports; the liability figure is shown separately.
- There is no per-till limit on wrong gift-card codes: sale transactions cannot write the platform rate-limit table. Codes have 80 bits, so they cannot be guessed.
- Customer-group scope for promotions is not built (there are no customer groups yet).
- Points expiry runs on demand (`expirePoints`); there is no scheduled job, and no SMS warning before points expire.
- The offline till does not push its cart to the customer display, and it cannot take points or gift-card tenders (they need the server).
- Promotions on scale-label lines use the label amount on the till; the server works from the unit price.
- Selling does not block reserved (layaway) stock at the till.
