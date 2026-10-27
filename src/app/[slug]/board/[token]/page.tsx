import { ReadyBoard } from './ready-board';

/** A screen facing customers: order numbers being prepared and ready to collect (spec 6.51). */
export default async function BoardPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return <ReadyBoard slug={slug} token={token} />;
}
