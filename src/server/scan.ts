import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { barcodes, products, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseBarcode, readScaleLabel } from '@/lib/barcode';
import { fromMilli, ratioToQty } from '@/lib/decimal';
import type { Ctx } from './context';
import { scaleLayoutOf } from './products';

export type ScanResult =
  | { found: true; productId: string; variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null; available: boolean }
  | { found: false };

const NOT_FOUND: ScanResult = { found: false };

/** Spec 6.22: scale labels first (a wrong check digit is never retried as a barcode), then the shop's barcodes. Any signed-in member. */
export async function parseScannedCode(db: Db, ctx: Ctx, code: string): Promise<ScanResult> {
  const clean = typeof code === 'string' ? normaliseBarcode(code) : null;
  if (!clean) return NOT_FOUND;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const columns = {
      productId: products.id, variantId: variants.id, basePricePesewas: variants.basePricePesewas,
      productStatus: products.status, variantStatus: variants.status,
    };
    type Row = { productId: string; variantId: string; productStatus: string; variantStatus: string };
    const found = (row: Row, unitId: string, quantity: string, labelPricePesewas: number | null): ScanResult => ({
      found: true, productId: row.productId, variantId: row.variantId, unitId, quantity, labelPricePesewas,
      available: row.productStatus === 'active' && row.variantStatus === 'active',
    });

    const layout = await scaleLayoutOf(tx, ctx.tenantId);
    const label = readScaleLabel(clean, layout);
    if (label === 'bad_check_digit') return NOT_FOUND;
    if (label && layout) {
      const [row] = await tx.select({ ...columns, unitId: variantUnits.id }).from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
        .where(eq(variants.scaleItemCode, label.itemCode));
      if (!row) return NOT_FOUND;
      if (layout.carries === 'weight') return found(row, row.unitId, fromMilli(BigInt(label.value)), null); // grams → kg
      if (row.basePricePesewas <= 0) return NOT_FOUND;
      return found(row, row.unitId, ratioToQty(BigInt(label.value), BigInt(row.basePricePesewas)), label.value);
    }

    const [row] = await tx.select({ ...columns, unitId: barcodes.unitId }).from(barcodes)
      .innerJoin(variants, eq(variants.id, barcodes.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(barcodes.code, clean));
    return row ? found(row, row.unitId, '1.000', null) : NOT_FOUND;
  });
}
