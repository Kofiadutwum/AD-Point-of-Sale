// Phase 8 (launch readiness): Next calls register() once when a server starts, and onRequestError for every server error.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { checkEnv } = await import('./server/env');
  const { errors, warnings } = checkEnv();
  for (const w of warnings) console.warn(JSON.stringify({ level: 'warn', event: 'env', message: w }));
  if (errors.length) {
    for (const e of errors) console.error(JSON.stringify({ level: 'error', event: 'env', message: e }));
    throw new Error(`Server not started: ${errors.length} required setting(s) missing. See the log above and docs/launch-checklist.md.`);
  }
}

type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
type ErrorContext = { routerKind: string; routePath: string; routeType: string; renderSource?: string };

/** One JSON line per server error, for the host's log search; no request body, cookies, or query string (they can hold personal data). */
export function logRequestError(err: unknown, request: RequestInfo, context: ErrorContext): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return JSON.stringify({
    level: 'error', event: 'request_error', at: new Date().toISOString(),
    digest: (e as Error & { digest?: string }).digest ?? null, name: e.name, message: e.message.slice(0, 500),
    stack: e.stack?.split('\n').slice(0, 8).join('\n') ?? null,
    method: request.method, path: request.path.split('?')[0], route: context.routePath, routeType: context.routeType, renderSource: context.renderSource ?? null,
  });
}

export async function onRequestError(err: unknown, request: RequestInfo, context: ErrorContext) {
  console.error(logRequestError(err, request, context));
}
