# ADsmartshop print helper

Prints kitchen and bar tickets from your tills to network thermal printers, without a print dialog, and keeps printing when the internet is down.

## Set up (once, on the shop's computer)
1. Install Node.js 18 or newer.
2. Copy `config.example.json` to `config.json` next to `print-helper.mjs` and fill it in:
   - `token`: a long random string (at least 16 characters). You type the same token on each till.
   - `allowedOrigins`: your shop's web address, for example `https://adsmartshop.example`.
   - `printers`: a name for each printer and its network address. Most network thermal printers listen on port 9100; print a self-test page to see the printer's IP address.
3. Start it: `node print-helper.mjs`. Leave the window open (or set it to start with the computer).
4. On each till, open **Printers** (from the selling screen), enter `http://127.0.0.1:17777` and the token, then choose a printer for each kitchen station.

## What it does
- Listens only on this computer (127.0.0.1), so the till that prints must run on the same computer.
- Accepts print jobs only from your shop's web address, with the token.
- Sends the bytes it is given to the printer and keeps nothing.

USB and Bluetooth printers, tills on other devices, and an Android version come later.
