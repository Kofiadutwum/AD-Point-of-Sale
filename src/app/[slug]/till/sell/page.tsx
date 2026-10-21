import type { Metadata } from 'next';
import { SellScreen } from './sell-screen';

// Reads no cookies or data: the service worker can serve this shell offline, and the client loads everything from IndexedDB.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: 'Till', manifest: `/${slug}/till/manifest.webmanifest` };
}

export default async function SellPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <SellScreen slug={slug} />;
}
