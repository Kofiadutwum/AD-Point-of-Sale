import { getDb } from '@/db/client';
import { getHomeSummary } from '@/server/home';
import { ActionForm, Field } from '@/components/form';
import { formatCedis } from '@/lib/money';
import { listHeldSales } from '@/server/held-sales';
import { resolveHeldAction, signOutAction } from './actions';
import { pageCtx } from './page-ctx';

export default async function ShopHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, null);
  const home = await getHomeSummary(getDb(), ctx, new Date());
  const held = ctx.permissions.includes('view_dashboard') ? await listHeldSales(getDb(), ctx) : [];
  const links = [
    { href: `/${slug}/app/sell`, label: 'Sell', allowed: ctx.permissions.includes('make_sale') },
    { href: `/${slug}/app/dashboard`, label: 'Dashboard', allowed: ctx.permissions.includes('view_dashboard') },
    { href: `/${slug}/app/sales`, label: 'Sales', allowed: ctx.permissions.includes('view_dashboard') },
    { href: `/${slug}/app/stock/receive`, label: 'Receive stock', allowed: ctx.permissions.includes('receive_stock') },
    { href: `/${slug}/app/customers`, label: 'Customers', allowed: ctx.permissions.includes('make_sale') },
    { href: `/${slug}/app/products`, label: 'Products', allowed: ctx.permissions.includes('manage_products') },
    { href: `/${slug}/app/price-lists`, label: 'Price lists', allowed: ctx.permissions.includes('manage_products') },
    { href: `/${slug}/app/settings`, label: 'Settings', allowed: ctx.permissions.includes('manage_shop_settings') },
    { href: `/${slug}/app/staff`, label: 'Staff', allowed: ctx.permissions.includes('manage_staff') },
    { href: `/${slug}/app/devices`, label: 'Devices', allowed: ctx.permissions.includes('manage_devices') },
    { href: `/${slug}/app/kitchen`, label: 'Kitchen', allowed: ctx.permissions.includes('run_kitchen') },
    { href: `/${slug}/app/settings/food`, label: 'Food settings', allowed: ctx.permissions.includes('manage_shop_settings') },
    { href: `/${slug}/till`, label: 'Till PIN screen', allowed: true },
    { href: `/${slug}/till/sell`, label: 'Selling screen', allowed: ctx.permissions.includes('make_sale') },
    { href: `/${slug}/app/security`, label: 'Two-step sign-in', allowed: ctx.sessionKind === 'password' },
  ].filter((l) => l.allowed);
  return (
    <main className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{home.shopName}</h1>
          <p className="text-sm text-gray-700">{home.userName} · {home.rolePreset}</p>
        </div>
        <form action={signOutAction.bind(null, slug)}>
          <button type="submit" className="rounded border px-3 py-1 text-sm">Sign out</button>
        </form>
      </header>
      {home.banner && <p role="status" className="rounded bg-amber-100 p-3 text-sm">{home.banner}</p>}
      <nav className="flex flex-wrap gap-3">
        {links.map((l) => <a key={l.href} href={l.href} className="rounded border px-3 py-2 text-blue-800">{l.label}</a>)}
      </nav>
      {held.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-semibold">Sales waiting for review</h2>
          <p className="text-sm text-gray-700">Offline sales the server could not accept. Check each one, then mark it resolved.</p>
          {held.map((h) => (
            <div key={h.id} className="rounded border p-3 text-sm">
              <p>{h.receiptNumber} · {h.registerName} · {h.cashierName ?? 'unknown cashier'} · {formatCedis(h.totalPesewas)}</p>
              <p className="text-gray-700">{h.deviceCreatedAt.toISOString().slice(0, 16).replace('T', ' ')} · {h.error.replaceAll('_', ' ')}</p>
              {ctx.permissions.includes('approve_actions') && (
                <ActionForm action={resolveHeldAction.bind(null, slug, h.id)} submitLabel="Mark resolved">
                  <Field label="Note" name="note" required={false} />
                </ActionForm>
              )}
            </div>
          ))}
        </section>
      )}
      {home.securityEvents.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Recent security events</h2>
          <ul className="text-sm">
            {home.securityEvents.map((e, i) => (
              <li key={i}>{e.at.toISOString().slice(0, 16).replace('T', ' ')} · {e.action.replaceAll('_', ' ')} · {e.detail}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
