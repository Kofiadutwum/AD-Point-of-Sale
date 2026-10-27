'use client';
import { useEffect, useState } from 'react';

type Board = { branchName: string; preparing: string[]; ready: string[] };
const POLL_MS = 5000;

export function ReadyBoard({ slug, token }: { slug: string; token: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/${slug}/board/${token}`, { cache: 'no-store' });
        if (!live) return;
        if (res.status === 404) setGone(true);
        else if (res.ok) { setGone(false); setBoard(await res.json()); }
      } catch {
        // keep showing the last board while the network is down
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [slug, token]);

  if (gone) return <main className="grid min-h-screen place-items-center p-8 text-2xl">This board link no longer works. Ask the manager for a new one.</main>;
  return (
    <main className="flex min-h-screen flex-col bg-black p-6 text-white">
      <h1 className="text-xl text-white/70">{board?.branchName ?? ''}</h1>
      <div className="mt-4 grid flex-1 grid-cols-2 gap-6">
        <section aria-labelledby="preparing">
          <h2 id="preparing" className="border-b border-white/30 pb-2 text-4xl font-bold">Preparing</h2>
          <ul className="mt-4 flex flex-wrap gap-4 text-6xl font-bold text-white/80">{board?.preparing.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
        <section aria-labelledby="ready" aria-live="polite">
          <h2 id="ready" className="border-b border-green-400 pb-2 text-4xl font-bold text-green-400">Ready</h2>
          <ul className="mt-4 flex flex-wrap gap-4 text-7xl font-extrabold text-green-300">{board?.ready.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      </div>
    </main>
  );
}
