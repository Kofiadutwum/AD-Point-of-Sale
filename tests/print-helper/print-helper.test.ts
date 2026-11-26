import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHandler } from '../../print-helper/print-helper.mjs';

const ORIGIN = 'https://shop.example';
const TOKEN = 'a-long-pairing-token-123';
let printer: net.Server;
let received: Buffer[];
let helper: http.Server;
let url: string;

beforeEach(async () => {
  received = [];
  printer = net.createServer((s) => { const parts: Buffer[] = []; s.on('data', (d) => parts.push(d)); s.on('end', () => received.push(Buffer.concat(parts))); });
  await new Promise<void>((r) => printer.listen(0, '127.0.0.1', r));
  const printerPort = (printer.address() as AddressInfo).port;
  helper = http.createServer(createHandler({
    token: TOKEN, allowedOrigins: [ORIGIN], printers: { kitchen: { host: '127.0.0.1', port: printerPort }, dead: { host: '127.0.0.1', port: 1 } },
  }));
  await new Promise<void>((r) => helper.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => helper.close(r));
  await new Promise((r) => printer.close(r));
});

const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/print`, {
  method: 'POST', headers: { origin: ORIGIN, 'x-print-token': TOKEN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

it('sends the job bytes to the printer', async () => {
  const bytes = Buffer.from([0x1b, 0x40, 0x48, 0x69, 0x0a]);
  const r = await post({ printer: 'kitchen', data: bytes.toString('base64') });
  expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
  await new Promise((done) => setTimeout(done, 50));
  expect(received).toEqual([bytes]);
  expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
});

it('answers the private-network preflight for the shop only', async () => {
  const ok = await fetch(`${url}/print`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
  expect(ok.status).toBe(204);
  expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
  expect((await fetch(`${url}/print`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
});

it('refuses other origins, a wrong token, and unknown printers; reports an offline printer', async () => {
  expect((await post({ printer: 'kitchen', data: 'AA==' }, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await post({ printer: 'kitchen', data: 'AA==' }, { 'x-print-token': 'wrong' })).status).toBe(401);
  expect((await post({ printer: 'nope', data: 'AA==' })).status).toBe(404);
  const dead = await post({ printer: 'dead', data: 'AA==' });
  expect([dead.status, await dead.json()]).toEqual([502, { ok: false, error: 'printer_offline' }]);
  const status = await fetch(`${url}/status`, { headers: { origin: ORIGIN, 'x-print-token': TOKEN } });
  expect(await status.json()).toEqual({ ok: true, printers: ['kitchen', 'dead'] });
  expect(received).toEqual([]);
});
