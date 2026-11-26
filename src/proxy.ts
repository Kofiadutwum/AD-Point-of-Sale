import { type NextRequest, NextResponse } from 'next/server';
import { cookieOptions, PASSWORD_SESSION_DAYS, SESSION_COOKIE } from '@/lib/cookies';

// Spec 3: slug.ROOT_DOMAIN and verified custom domains serve that shop's pages; links that already start with /<slug> keep working.
const cache = new Map<string, { slug: string | null; until: number }>();

async function slugForHost(request: NextRequest, host: string): Promise<string | null> {
  const hit = cache.get(host);
  if (hit && hit.until > Date.now()) return hit.slug;
  let slug: string | null = null;
  try {
    // the database lives in the app server, so the proxy asks it (shared secret) instead of opening its own connection
    const r = await fetch(new URL(`/api/domains/resolve?host=${encodeURIComponent(host)}`, request.nextUrl.origin), { headers: { 'x-internal': process.env.CRON_SECRET ?? '' }, cache: 'no-store' });
    if (r.ok) slug = ((await r.json()) as { slug: string | null }).slug;
  } catch { /* unknown host: served as the platform site */ }
  cache.set(host, { slug, until: Date.now() + 60_000 });
  return slug;
}

function platformHost(host: string): boolean {
  const root = process.env.ROOT_DOMAIN?.toLowerCase();
  const app = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null;
  return host === 'localhost' || host === '127.0.0.1' || host === app || (!!root && (host === root || host === `www.${root}`)) || (!root && !process.env.CRON_SECRET);
}

/**
 * validateSession slides an active password session to 30 days ahead, so the cookie must not expire first.
 * The database still decides whether the session is valid, so a cookie outliving it (e.g. a 12-hour PIN session) is harmless.
 * Only GETs: a server action such as sign-out sets its own cookie.
 */
function refreshSession(request: NextRequest, response: NextResponse, path: string) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && request.method === 'GET' && /^\/[^/]+\/app(\/|$)/.test(path)) {
    response.cookies.set(SESSION_COOKIE, token, cookieOptions(new Date(Date.now() + PASSWORD_SESSION_DAYS * 86_400_000)));
  }
  return response;
}

export async function proxy(request: NextRequest) {
  const host = request.nextUrl.hostname.toLowerCase(); // Next fills this from the Host header
  const path = request.nextUrl.pathname;
  if (!platformHost(host) && !path.startsWith('/api/')) {
    const slug = await slugForHost(request, host);
    if (slug && path !== `/${slug}` && !path.startsWith(`/${slug}/`)) {
      const url = request.nextUrl.clone();
      url.pathname = `/${slug}${path === '/' ? '' : path}`;
      return refreshSession(request, NextResponse.rewrite(url), url.pathname);
    }
  }
  return refreshSession(request, NextResponse.next(), path);
}

export const config = { matcher: ['/((?!_next/|favicon.ico|.*\.(?:png|jpg|svg|webp|ico|js|css|txt|webmanifest)$).*)'] };
