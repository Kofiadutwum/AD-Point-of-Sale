import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { proxy } from '@/proxy';

const visit = (method: string, cookie?: string) =>
  proxy(new NextRequest('https://pos.test/shop-a/app/staff', { method, headers: cookie ? { cookie } : {} }));

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

it('keeps the session cookie alive 30 days past each page visit, as the database session slides', () => {
  const cookie = visit('GET', 'pos_session=tok-1').cookies.get('pos_session');
  expect(cookie).toMatchObject({ value: 'tok-1', httpOnly: true, sameSite: 'lax', path: '/' });
  expect(new Date(cookie!.expires!)).toEqual(new Date('2026-11-19T10:00:00Z'));
});

it('sets nothing without a session cookie', () => {
  expect(visit('GET').cookies.get('pos_session')).toBeUndefined();
});

it('leaves server actions alone, so signing out still clears the cookie', () => {
  expect(visit('POST', 'pos_session=tok-1').cookies.get('pos_session')).toBeUndefined();
});
