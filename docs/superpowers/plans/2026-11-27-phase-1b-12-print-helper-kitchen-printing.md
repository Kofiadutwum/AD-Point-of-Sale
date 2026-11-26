# Phase 1b-12: Local print helper and kitchen printing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Kitchen and bar tickets print on thermal printers without a print dialog, and keep printing when the internet is down (spec 4.24, 11, acceptance "Kitchen tickets still print during an internet outage through the print helper").

## Decisions (my call)
- **The helper** is a single Node.js file with no dependencies (`print-helper/print-helper.mjs`), run on the shop's computer (`node print-helper.mjs`). It listens on `http://127.0.0.1:17777` only. Network (LAN) printers on raw port 9100 come first, since most kitchen printers are networked; USB and Bluetooth printers, and an Android build, come later.
- **Security:** the helper accepts jobs only from the shop's own web address (`allowedOrigins` in `config.json`) with the pairing token from `config.json` in a header; it answers the browser's private-network preflight. It never stores jobs or receipt contents.
- **Jobs are ESC/POS bytes built in the browser** (`src/lib/escpos.ts`), so the helper stays dumb and needs no updates when slips change. Text is plain ASCII (cedi sign written as "GHS").
- **Printers per device:** each till keeps its own helper address, token, and station → printer map in the browser (localStorage), set on a "Printers" screen. A kitchen station with no printer is skipped (the kitchen display still shows it).
- **When slips print:** on the till, after a counter or quick-serve sale with kitchen items (online or offline), and on the ticket page after "Send to kitchen" (the lines just sent) and after a void of a sent item (a cancel slip). One slip per station.

## Tasks
1. `src/lib/escpos.ts` (init, text, bold, double size, feed, cut, drawer kick, ASCII folding) and `src/lib/kitchen-slip.ts` (slip lines from an order and station). Tests.
2. `print-helper/print-helper.mjs`, `config.example.json`, README. Tests drive its request handler against a fake printer socket: token and origin checks, preflight headers, bytes delivered, printer offline reported.
3. App: `src/lib/print-client.ts` (settings in localStorage, send a job, status check), "Printers" screen (`/[slug]/till/printers`), kitchen slips from the till after sale, ticket send and void slips. Tests for the slip grouping by station.
4. Verify, hand over, merge.
