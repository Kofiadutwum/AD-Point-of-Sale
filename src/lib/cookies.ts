export const SESSION_COOKIE = 'pos_session';
export const DEVICE_COOKIE = 'pos_device';
export const ADMIN_COOKIE = 'pos_admin';

export function cookieOptions(expires: Date) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', expires };
}
