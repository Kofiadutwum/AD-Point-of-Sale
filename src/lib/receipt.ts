import { formatCedis } from './money';

/** branch_code-register_code-counter, e.g. ACC1-T2-000123 (spec 6.0). Codes follow the branch and till code rule. */
export const RECEIPT_NUMBER = /^([A-Z0-9]{1,6})-([A-Z0-9]{1,6})-(\d{6})$/;

export function parseReceiptNumber(s: string): { branchCode: string; registerCode: string; counter: number } | null {
  const m = RECEIPT_NUMBER.exec(s);
  return m ? { branchCode: m[1], registerCode: m[2], counter: Number(m[3]) } : null;
}

export function formatReceiptNumber(branchCode: string, registerCode: string, counter: number): string {
  return `${branchCode}-${registerCode}-${String(counter).padStart(6, '0')}`;
}

export function receiptShareText(r: { shopName: string; receiptNumber: string; totalPesewas: number; url: string }): string {
  return `${r.shopName}\nReceipt ${r.receiptNumber}\nTotal ${formatCedis(r.totalPesewas)}\n${r.url}`;
}

/** A wa.me link that opens WhatsApp with the text ready; to the customer's chat when a 233… phone is known. */
export function whatsappShareUrl(text: string, phone?: string | null): string {
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(text)}`;
}
