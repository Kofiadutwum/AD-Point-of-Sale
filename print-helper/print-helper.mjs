// ADsmartshop local print helper (spec section 11): prints ESC/POS jobs from the shop's tills to network printers, no print dialog.
// Run on the shop's computer: `node print-helper.mjs` (Node 18 or newer), next to a config.json (see config.example.json).
// Listens on 127.0.0.1 only; accepts jobs only from the shop's own web address with the pairing token. Never stores jobs.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_JOB_BYTES = 512 * 1024;

/** Sends raw bytes to a network printer's raw port (usually 9100); rejects when it cannot be reached in time. */
export function sendToPrinter(printer, bytes, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: printer.host, port: printer.port ?? 9100 });
    const fail = (e) => { socket.destroy(); reject(e); };
    socket.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(Buffer.from(bytes), () => resolve()));
  });
}

const same = (a, b) => {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The HTTP handler: CORS and private-network preflight for allowed origins, GET /status, POST /print { printer, data: base64 }. */
export function createHandler(config, send = sendToPrinter) {
  const allowed = new Set(config.allowedOrigins ?? []);
  return (req, res) => {
    const origin = req.headers.origin;
    const reply = (status, body) => {
      const headers = { 'content-type': 'application/json', vary: 'Origin' };
      if (origin && allowed.has(origin)) headers['access-control-allow-origin'] = origin;
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (!origin || !allowed.has(origin)) return reply(403, { ok: false, error: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-print-token',
        'access-control-allow-private-network': 'true', 'access-control-max-age': '600', vary: 'Origin',
      });
      return res.end();
    }
    if (!same(req.headers['x-print-token'], config.token)) return reply(401, { ok: false, error: 'wrong_token' });
    if (req.method === 'GET' && req.url === '/status') return reply(200, { ok: true, printers: Object.keys(config.printers ?? {}) });
    if (req.method !== 'POST' || req.url !== '/print') return reply(404, { ok: false, error: 'not_found' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JOB_BYTES) { reply(413, { ok: false, error: 'too_large' }); req.destroy(); } else chunks.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_JOB_BYTES) return;
      let job;
      try { job = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { ok: false, error: 'invalid_job' }); }
      const printer = config.printers?.[job?.printer];
      if (!printer) return reply(404, { ok: false, error: 'unknown_printer' });
      if (typeof job.data !== 'string' || !job.data) return reply(400, { ok: false, error: 'invalid_job' });
      try {
        await send(printer, Buffer.from(job.data, 'base64'));
        reply(200, { ok: true });
      } catch {
        reply(502, { ok: false, error: 'printer_offline' });
      }
    });
  };
}

/** Starts the helper on 127.0.0.1 from a config object; resolves with the server once listening. */
export function startHelper(config) {
  const server = http.createServer(createHandler(config));
  return new Promise((resolve) => server.listen(config.port ?? 17777, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!config.token || String(config.token).length < 16) throw new Error('config.json needs a "token" of at least 16 characters');
  startHelper(config).then((s) => {
    const { port } = s.address();
    console.log(`ADsmartshop print helper on http://127.0.0.1:${port} - printers: ${Object.keys(config.printers ?? {}).join(', ') || 'none'}`);
  });
}
