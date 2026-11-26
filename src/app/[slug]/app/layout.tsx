import { AccessError } from '@/server/context';
import { pageCtx } from './page-ctx';

// Spec 6.20: trial and renewal banners; the shop keeps working in the grace period and turns read-only after it.
const BANNERS: Record<string, string | undefined> = {
  trial: 'Free trial: choose a plan to keep selling when it ends.',
  grace: 'Your subscription has expired. Renew within the grace period to keep selling.',
  read_only: 'Read-only: you can view and export records but not sell. Renew to sell again.',
};

export default async function ShopLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let ctx;
  try {
    ctx = await pageCtx(slug, null);
  } catch (e) {
    if (e instanceof AccessError && e.code === 'suspended') {
      return <main className="p-8">This shop is suspended. Contact support.</main>;
    }
    throw e;
  }
  const notice = BANNERS[ctx.subscription];
  const owner = ctx.permissions.includes('manage_shop_settings');
  return (
    <div className="mx-auto max-w-3xl p-6">
      {notice && (
        <p className="mb-4 rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm" role="status">
          {notice} {owner && <a className="font-semibold underline" href={`/${slug}/app/billing`}>Billing</a>}
        </p>
      )}
      {children}
    </div>
  );
}
