import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { proxy } from '@/proxy';

const visit = (method: string, cookie?: string) =>
  proxy(new NextRequest('https://pos.test/shop-a/app/staff', { method, headers: cookie ? { cookie } : {} }));

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') }); vi.stubEnv('APP_URL', 'https://pos.test'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('keeps the session cookie alive 30 days past each page visit, as the database session slides', async () => {
  const cookie = (await visit('GET', 'pos_session=tok-1')).cookies.get('pos_session');
  expect(cookie).toMatchObject({ value: 'tok-1', httpOnly: true, sameSite: 'lax', path: '/' });
  expect(new Date(cookie!.expires!)).toEqual(new Date('2026-11-19T10:00:00Z'));
});

it('sets nothing without a session cookie', async () => {
  expect((await visit('GET')).cookies.get('pos_session')).toBeUndefined();
});

it('leaves server actions alone, so signing out still clears the cookie', async () => {
  expect((await visit('POST', 'pos_session=tok-1')).cookies.get('pos_session')).toBeUndefined();
});

it('serves a shop on its subdomain or verified custom domain, keeping /<slug> links working', async () => {
  vi.stubEnv('ROOT_DOMAIN', 'adsmart.test');
  vi.stubEnv('CRON_SECRET', 'cron-test');
  const fetchMock = vi.fn(async (url: URL, init?: RequestInit) => init && Response.json({ slug: url.searchParams.get('host') === 'unknown.example.com' ? null : 'shop-a' }));
  vi.stubGlobal('fetch', fetchMock);
  const at = (url: string) => proxy(new NextRequest(url));
  expect((await at('https://shop-a.adsmart.test/')).headers.get('x-middleware-rewrite')).toBe('https://shop-a.adsmart.test/shop-a');
  expect((await at('https://shop-a.adsmart.test/p/123')).headers.get('x-middleware-rewrite')).toBe('https://shop-a.adsmart.test/shop-a/p/123');
  expect((await at('https://shop-a.adsmart.test/shop-a/app')).headers.get('x-middleware-rewrite')).toBeNull();
  expect((await at('https://unknown.example.com/')).headers.get('x-middleware-rewrite')).toBeNull();
  expect((await at('https://adsmart.test/')).headers.get('x-middleware-rewrite')).toBeNull(); // the platform site itself
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'x-internal': 'cron-test' } });
});
