import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { branches, customers, products, registers, taxRules, tenants, type Tracking, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { todayIn } from '@/lib/dates';
import { parseQuantity } from '@/lib/decimal';
import { choosePriceList, resolvePrice } from '@/lib/pricing';
import { chooseTaxRule, effectiveRateBp } from '@/lib/tax';
import { assertPermission, type Ctx } from './context';
import { findDeviceRegister } from './devices';
import { loadPriceRules } from './price-lists';
import { isUuid, itemLabel } from './products';
import { parseScannedCode } from './scan';

export type TillRegister = { registerId: string; registerCode: string; branchId: string; branchCode: string; lastCounter: number };

/** The till a request sells on: a PIN session's register, else the registered device in the cookie when it belongs to the same shop. */
export async function tillRegister(db: Db, ctx: Ctx, deviceToken: string | undefined): Promise<TillRegister | null> {
  let registerId = ctx.registerId;
  if (!registerId) {
    const device = await findDeviceRegister(db, deviceToken);
    registerId = device && device.tenantId === ctx.tenantId ? device.registerId : null;
  }
  if (!registerId) return null;
  return registerById(db, ctx.tenantId, registerId);
}

export type TillItem = {
  variantId: string; unitId: string; name: string; unitName: string; quantity: string; unitPricePesewas: number; taxRateBp: number;
  tracking: Tracking; fractions: boolean; available: boolean;
};

/** A scanned barcode or scale label (6.22), priced for this branch and customer (6.21). */
export async function lookupTillItem(
  db: Db, ctx: Ctx, input: { code: string; branchId: string; customerId: string | null }, now: Date,
): Promise<TillItem | null> {
  assertPermission(ctx, 'make_sale');
  const hit = await parseScannedCode(db, ctx, input.code);
  if (!hit.found) return null;
  return tillItemForVariant(db, ctx, { variantId: hit.variantId, unitId: hit.unitId, quantity: hit.quantity, branchId: input.branchId, customerId: input.customerId }, now);
}

/** Prices one unit of a variant at a quantity (quantity breaks change the unit price); the base unit when none is given. */
export async function tillItemForVariant(
  db: Db, ctx: Ctx, input: { variantId: string; unitId?: string; quantity: string; branchId: string; customerId: string | null }, now: Date,
): Promise<TillItem | null> {
  assertPermission(ctx, 'make_sale');
  const quantity = parseQuantity(input.quantity);
  if (!quantity || !isUuid(input.variantId) || (input.unitId && !isUuid(input.unitId))) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [item] = await tx.select({
      unitId: variantUnits.id, unitName: variantUnits.name, factor: variantUnits.factor, isBase: variantUnits.isBase, unitPrice: variantUnits.pricePesewas,
      variantName: variants.name, basePrice: variants.basePricePesewas, allowsFractions: variants.allowsFractions, variantStatus: variants.status,
      productName: products.name, productStatus: products.status, taxRuleId: products.taxRuleId, tracking: products.tracking,
    }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variantUnits.variantId, input.variantId), input.unitId ? eq(variantUnits.id, input.unitId) : eq(variantUnits.isBase, true)));
    if (!item) return null;
    const [customer] = input.customerId && isUuid(input.customerId)
      ? await tx.select({ priceListId: customers.priceListId }).from(customers).where(eq(customers.id, input.customerId)) : [];
    const [shop] = await tx.select({ taxEnabled: tenants.taxEnabled }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const rule = chooseTaxRule(shop.taxEnabled, item.taxRuleId, await tx.select().from(taxRules).where(eq(taxRules.active, true)));
    const list = choosePriceList(await loadPriceRules(tx), {
      cartListId: null, customerListId: customer?.priceListId ?? null, branchId: input.branchId, today: todayIn(ctx.timezone, now),
    });
    return {
      variantId: input.variantId, unitId: item.unitId, name: itemLabel(item.productName, item.variantName), unitName: item.unitName, quantity,
      unitPricePesewas: resolvePrice(list, { unitId: item.unitId, quantity, unitPricePesewas: item.unitPrice, unitFactor: item.factor, basePricePesewas: item.basePrice }),
      taxRateBp: rule ? effectiveRateBp(rule) : 0, tracking: item.tracking, fractions: item.isBase && item.allowsFractions,
      available: item.productStatus === 'active' && item.variantStatus === 'active',
    };
  });
}

export async function registerById(db: Db, tenantId: string, registerId: string): Promise<TillRegister | null> {
  const [r] = await withTenant(db, tenantId, (tx) => tx.select({
    registerId: registers.id, registerCode: registers.registerCode, branchId: registers.branchId, branchCode: branches.branchCode,
    lastCounter: registers.receiptCounter, status: registers.status,
  }).from(registers).innerJoin(branches, eq(branches.id, registers.branchId)).where(eq(registers.id, registerId)));
  if (!r || r.status !== 'active') return null;
  const { status: _status, ...till } = r;
  return till;
}
