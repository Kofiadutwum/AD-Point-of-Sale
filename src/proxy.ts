import { type NextRequest, NextResponse } from 'next/server';
import { cookieOptions, PASSWORD_SESSION_DAYS, SESSION_COOKIE } from '@/lib/cookies';

/**
 * validateSession slides an active password session to 30 days ahead, so the cookie must not expire first.
 * The database still decides whether the session is valid, so a cookie outliving it (e.g. a 12-hour PIN session) is harmless.
 * Only GETs: a server action such as sign-out sets its own cookie.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && request.method === 'GET') {
    response.cookies.set(SESSION_COOKIE, token, cookieOptions(new Date(Date.now() + PASSWORD_SESSION_DAYS * 86_400_000)));
  }
  return response;
}

export const config = { matcher: '/:slug/app/:path*' };
