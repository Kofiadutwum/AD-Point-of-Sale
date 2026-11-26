import { ActionForm } from '@/components/form';
import { pageCtx } from '../page-ctx';
import { pairAction } from './actions';

/** Spec 4.28: pair a second screen with this till; it shows the cart while selling and promotions in between. */
export default async function DisplayPairPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await pageCtx(slug, 'make_sale');
  return (
    <main className="flex max-w-md flex-col gap-4">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Customer display</h1>
      <p className="text-sm text-gray-700">On the tablet or screen facing the customer, open <strong>/{slug}/display</strong>, then enter the code below. The online sell screen sends each cart to it.</p>
      <ActionForm action={pairAction.bind(null, slug)} submitLabel="Show pairing code"><span /></ActionForm>
    </main>
  );
}
