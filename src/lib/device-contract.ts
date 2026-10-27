// Shapes shared by the server and the device till. Types only: the browser imports this file.
import type { CatalogueStatus, Tracking } from '@/db/schema';
import type { ScaleLayout } from './barcode';
import type { DiningOption } from './food';
import type { Permission } from './permissions';
import type { PriceRule } from './pricing';

export type TenderMethod = 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit';

/** POST /api/[slug]/sales, agreed with Plan 3 (selling). */
export type SaleRequest = {
  saleId: string; receiptNumber: string;
  lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number; discountPesewas: number; serials?: string[] }>;
  tenders: Array<{ id: string; method: TenderMethod; amountPesewas: number; reference?: string }>;
  customerId?: string; cashierId?: string; deviceCreatedAt: string; fromOfflineOutbox?: boolean;
  food?: { serviceMode: 'counter' | 'quick'; diningOption: DiningOption; orderNumber?: string };
};
export type SaleResponse =
  | { ok: true; saleId: string; status: 'completed' | 'pending'; changeDuePesewas: number; alreadyExisted: boolean; orderNumber: string | null }
  | { ok: false; error: string };

export type CachedStaff = { id: string; name: string; permissions: Permission[]; pinHash: string | null; pinLockedUntil: string | null };

/** GET /api/[slug]/device/cache: everything a till needs to sell offline (spec 6.10). */
export type DeviceCache = {
  version: number; generatedAt: string;
  shop: {
    name: string; timezone: string; taxMode: 'inclusive' | 'exclusive'; taxEnabled: boolean; scaleLayout: ScaleLayout | null;
    offlineEnabled: boolean; canSell: boolean; businessDayCutoff: string;
  };
  register: { id: string; name: string; registerCode: string; branchId: string; branchCode: string; branchName: string };
  staff: CachedStaff[];
  taxRules: Array<{ id: string; isDefault: boolean; rateBp: number }>; // rateBp = effectiveRateBp(rule)
  priceRules: PriceRule[];
  products: Array<{ id: string; name: string; genericName: string | null; taxRuleId: string | null; tracking: Tracking; status: CatalogueStatus; imageId: string | null }>;
  variants: Array<{
    id: string; productId: string; name: string; sku: string | null; allowsFractions: boolean; basePricePesewas: number;
    scaleItemCode: number | null; sellable: boolean; status: CatalogueStatus; needsPack: boolean;
  }>;
  units: Array<{ id: string; variantId: string; name: string; factor: string; pricePesewas: number | null; sellable: boolean; isBase: boolean }>;
  barcodes: Array<{ code: string; variantId: string; unitId: string }>;
  resolvedHeldSaleIds: string[];
  /** Null when the kitchen module is off. Sold-out ids are for businessDate only; a till ignores them on another date. */
  food: {
    serviceModes: Array<'counter' | 'quick'>; packVariantId: string | null; packFeeMode: 'per_item' | 'per_order';
    businessDate: string; soldOutVariantIds: string[];
  } | null;
};

/** POST /api/[slug]/device/held-sales: a sale the server refused, or one held earlier that has now synced. */
export type HeldSaleReport = {
  saleId: string; receiptNumber: string; cashierId: string | null; totalPesewas: number; error: string;
  sale: SaleRequest; deviceCreatedAt: string; status: 'held' | 'synced';
};
