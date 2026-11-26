# Phase 1b-12 hand-over: local print helper and kitchen printing

No database migrations.

## How it works
- **ESC/POS** (`src/lib/escpos.ts`): initialise, styled lines (bold, double size, centred), wrapping to 32 (58 mm) or 48 (80 mm) characters, feed, partial cut, optional cash drawer kick. Text is folded to ASCII (cedi sign as "GHS").
- **Kitchen slips** (`src/lib/kitchen-slip.ts`): one slip per station (kitchen, bar, grill) with only that station's items: order number or table/ticket label, dining option and time, quantity × item, add-ons, notes, who sent it; a cancel slip variant.
- **Print helper** (`print-helper/`): one Node.js file, no dependencies (`node print-helper.mjs`, Node 18+), with `config.example.json` and a README. Listens on 127.0.0.1:17777; accepts jobs only from `allowedOrigins` with the token header (timing-safe compare); answers the private-network preflight; `GET /status` lists printers; `POST /print { printer, data: base64 }` sends the bytes to the printer's raw port (9100) and reports `printer_offline` when it cannot. Stores nothing. `print-helper/config.json` is git-ignored (it holds the token).
- **App:** `src/lib/print-client.ts` keeps each device's helper address, token, paper width, and station → printer map in localStorage (`pos-printers-<slug>`). Screen `/[slug]/till/printers` (link "Printers" in the till header): find the helper, choose printers, save, print a test slip.
  - The till prints kitchen slips after every food sale (counter or quick serve), online or offline; the takeaway pack is left off. A failed print shows a message; the kitchen display still has the order.
  - The ticket page prints the latest "Send to kitchen" batch once (remembered per tab) and has "Print last kitchen send again".
  - The device cache now carries each product's kitchen station; ticket lines carry `sentAt`.

## Checked
- Tests: slips and ESC/POS (3), the helper against a fake printer socket (3). Type check and build green.
- End to end on this machine: the real helper with a fake network printer; the Printers page found the helper, saved the kitchen printer, and printed a test slip, and the fake printer received the ESC/POS bytes.

## Not done
- Cancel slips when a sent item is voided (the slip builder supports them; nothing calls it yet).
- Receipts and the cash drawer through the helper (receipts still use the browser's print).
- USB and Bluetooth printers, tills on other devices reaching the helper over the network, and an Android helper.
- Printing on a real thermal printer was not tried.
