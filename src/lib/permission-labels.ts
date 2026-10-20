import type { Permission } from './permissions';

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
};
