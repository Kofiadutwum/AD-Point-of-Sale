/** Ghana numbers are stored as 233 followed by 9 digits. */
export function normaliseGhanaPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '').replace(/^(?:\+|00(?=233))/, '');
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  const international = /^2330?(\d{9})$/.exec(digits); // +233 (0)24… keeps the trunk 0
  return international ? `233${international[1]}` : null;
}

export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
