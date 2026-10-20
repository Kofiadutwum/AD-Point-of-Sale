export const RESERVED_SLUGS = ['admin', 'api', 'app', 'login', 'help', 'pricing', 'terms', 'privacy', 'www', 'static', 'activate'] as const;
export type SlugProblem = 'too_short' | 'too_long' | 'invalid_chars' | 'reserved';

export function normaliseSlug(input: string): string {
  return input
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function validateSlug(slug: string): SlugProblem | 'ok' {
  if (slug.length < 3) return 'too_short';
  if (slug.length > 40) return 'too_long';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'invalid_chars';
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return 'reserved';
  return 'ok';
}
