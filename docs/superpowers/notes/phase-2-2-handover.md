# Phase 2-2 hand-over: credit sales and customer accounts

## Migrations
- `0036_credit`: `customers.credit_limit_pesewas`, `balance_pesewas`, `reminder_consent`; table `customer_ledger`; tender `credit`.
- `0037_credit_rls`: tenant isolation; `sell_on_credit` to owners and managers; `receive_debt_payment` to everyone who sells.

## How it works
- **Credit tender** (`completeSaleTx`): needs `sell_on_credit` and a customer; the customer row is locked; over the limit needs a manager's approval (`credit_over_limit`, `<saleId>:<amount>`, `creditApprovalToken`). Offline credit sales are kept and flagged `credit_offline`. A `sale` ledger entry raises the balance.
- **Returns:** refund method `credit` (only for a sale paid on credit) reduces the balance, never below 0 (`credit_refund_exceeds_balance`, `not_credit_sale`). Also available for money given back on an exchange.
- **Accounts** (`src/server/customer-accounts.ts`): `saveCreditTerms` (approve_actions), `recordDebtPayment` (amount up to the balance; non-cash needs a reference; cash at a till joins the open shift and counts in its expected cash), `adjustBalance` (approve_actions, reason), `customerAccount` (latest 100 entries), `listDebtors` (oldest unpaid credit first, first-in-first-out).
- **Screens:** customer account page `/app/customers/[id]` (balance, take a payment, credit terms, corrections, history, print), "Who owes" `/app/customers/owing`, "Account" links on the customers list, and "On credit" as a payment on the web selling screen.

## Checked
- 7 credit tests; sale, return, exchange, shift, dashboard suites pass; type check and build green.

## Not done
- Over-limit approval from the selling screen (the message asks a manager to raise the limit), credit on the offline till, weekly debtor SMS and reminders, opening balances by CSV.
- Build note: OneDrive turned folders under `.next/server` into placeholders that blocked `next build`; deleting `.next/server` fixed it.
