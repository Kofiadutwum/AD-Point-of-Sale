import { AccessError } from '@/server/context';
import { pageCtx } from './page-ctx';

export default async function ShopLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    await pageCtx(slug, null);
  } catch (e) {
    if (e instanceof AccessError && e.code === 'suspended') {
      return <main className="p-8">This shop is suspended. Contact support.</main>;
    }
    throw e;
  }
  return <div className="mx-auto max-w-3xl p-6">{children}</div>;
}
