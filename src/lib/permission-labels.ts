import type { Module, Permission } from './permissions';

export const MODULE_LABELS: Record<Module, string> = {
  batches: 'Batch and expiry tracking',
  serials: 'Serial and IMEI numbers',
  price_lists: 'Price lists',
  scale_barcodes: 'Scale labels',
  units: 'Pharmacy units (pack, strip, tablet)',
  recipes: 'Recipes',
  prescriptions: 'Prescriptions',
  addons: 'Add-ons',
  tickets: 'Open tickets',
  kitchen: 'Kitchen printing',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_shop_settings: 'Change shop settings, branches, and tills',
  manage_staff: 'Add and manage staff',
  manage_devices: 'Register till devices',
  manage_products: 'Manage products',
  receive_stock: 'Receive stock',
  make_sale: 'Sell',
  give_discount: 'Give discounts',
  approve_actions: 'Approve refunds and other restricted actions',
  view_dashboard: 'See the dashboard',
  view_reports: 'See reports',
  export_data: 'Export data',
  mark_sold_out: 'Mark items sold out',
  run_kitchen: 'Run the kitchen screen and packing check',
};
