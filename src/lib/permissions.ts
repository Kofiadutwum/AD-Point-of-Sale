export const PERMISSIONS = [
  'manage_shop_settings', 'manage_staff', 'manage_devices', 'manage_products', 'receive_stock',
  'make_sale', 'give_discount', 'approve_actions', 'view_dashboard', 'view_reports', 'export_data',
  'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders', 'manage_channels',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export type RolePreset = 'owner' | 'manager' | 'cashier';

export const ROLE_PRESETS: Record<RolePreset, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: PERMISSIONS.filter((p) => p !== 'manage_shop_settings'),
  cashier: ['make_sale', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders'],
};

/** What a shop whose subscription is past its grace period may still do. */
export const READ_ONLY_PERMISSIONS: readonly Permission[] = ['view_dashboard', 'view_reports', 'export_data'];

/** A PIN unlocks only selling: a 4-6 digit PIN must never carry staff, settings, or device control. */
export const TILL_PERMISSIONS: readonly Permission[] = ['make_sale', 'give_discount', 'approve_actions', 'mark_sold_out', 'run_kitchen', 'record_kitchen_stock', 'enter_channel_orders'];

export type ShopType = 'retail' | 'pharmacy' | 'food';
export const SHOP_TYPES: readonly ShopType[] = ['retail', 'pharmacy', 'food'];

export const MODULES = [
  'batches', 'serials', 'price_lists', 'scale_barcodes', 'units', 'recipes', 'prescriptions', 'addons', 'tickets', 'kitchen',
] as const;
export type Module = (typeof MODULES)[number];

export const DEFAULT_MODULES: Record<ShopType, readonly Module[]> = {
  retail: ['serials', 'price_lists', 'scale_barcodes'],
  pharmacy: ['batches', 'prescriptions', 'units'],
  food: ['addons', 'tickets', 'kitchen', 'recipes'],
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
