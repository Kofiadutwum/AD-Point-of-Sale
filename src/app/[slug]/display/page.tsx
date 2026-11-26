import type { Metadata } from 'next';
import { CustomerDisplay } from './customer-display';

export const metadata: Metadata = { title: 'Customer display', robots: { index: false } };

/** Spec 4.28: the second screen facing the customer. */
export default async function DisplayPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CustomerDisplay slug={slug} />;
}
