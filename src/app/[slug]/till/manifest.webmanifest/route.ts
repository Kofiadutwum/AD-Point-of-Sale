/** Per-shop web app manifest, so an installed till opens straight on that shop's selling screen (spec 4.9). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(JSON.stringify({
    name: `Till – ${slug}`, short_name: 'Till', start_url: `/${slug}/till/sell`, scope: `/${slug}/till/`,
    display: 'standalone', background_color: '#ffffff', theme_color: '#1e40af',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }), { headers: { 'Content-Type': 'application/manifest+json' } });
}
