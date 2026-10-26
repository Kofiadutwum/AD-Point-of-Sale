'use client';
import Image from 'next/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Picture } from './landing-pictures';

/** Slides its content in the first time it scrolls into view. */
export function Reveal({ children, from = 'below', className = '' }: { children: ReactNode; from?: 'below' | 'left' | 'right'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); io.disconnect(); }
    }, { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} data-from={from} data-visible={visible} className={`landing-reveal ${className}`}>{children}</div>;
}

const arrowButton = 'grid h-11 w-11 place-items-center rounded-full border-2 border-current transition-colors hover:bg-[#C9430D] hover:border-[#C9430D] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-current disabled:hover:text-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F26A21]';

/** Every picture of one shop type in a row that scrolls sideways, by swipe, trackpad or the arrow buttons. */
export function PictureRow({ label, pictures }: { label: string; pictures: Picture[] }) {
  const row = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const update = () => {
    const el = row.current;
    if (el) setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(update, []);
  const move = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <div>
      <div className="mb-4 flex justify-end gap-3">
        <button type="button" className={arrowButton} onClick={() => move(-1)} disabled={edge.start} aria-label={`Previous ${label} pictures`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button type="button" className={arrowButton} onClick={() => move(1)} disabled={edge.end} aria-label={`Next ${label} pictures`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      </div>
      <ul
        ref={row} onScroll={update} aria-label={`${label} pictures`}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pictures.map((p) => (
          <li key={p.src} className="w-[62%] shrink-0 snap-start sm:w-[34%] lg:w-[23%]">
            <figure className="group overflow-hidden rounded-xl">
              <Image src={p.src} alt={p.alt} width={480} height={600} sizes="(min-width: 1024px) 23vw, (min-width: 640px) 34vw, 62vw"
                className="aspect-[4/5] w-full object-cover transition-transform duration-700 group-hover:scale-105 motion-reduce:transition-none" />
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Plan = { name: string; price: number; branches: number; tills: number };

/** Plan details above, with the plan picker as a tab bar like the one on the reference layout. */
export function PlanTabs({ plans, action }: { plans: Plan[]; action: ReactNode }) {
  const [current, setCurrent] = useState(1);
  const plan = plans[current];
  const pick = (i: number) => {
    const next = (i + plans.length) % plans.length;
    setCurrent(next);
    document.getElementById(`plan-tab-${next}`)?.focus();
  };
  return (
    <div>
      <div id="plan-panel" role="tabpanel" aria-labelledby={`plan-tab-${current}`} className="min-h-[13rem]">
        <p className="text-lg text-white/70">{plan.name}</p>
        <p className="mt-1 text-6xl font-extrabold tracking-tight">GHS {plan.price}<span className="text-2xl font-semibold text-white/70"> a month</span></p>
        <p className="mt-4 text-lg text-white/85">
          {plan.branches} {plan.branches === 1 ? 'branch' : 'branches'}, up to {plan.tills} tills. Free trial first, and we set up your shop for you.
        </p>
        <div className="mt-6">{action}</div>
      </div>
      <div role="tablist" aria-label="Plans" className="mt-10 grid grid-cols-3 gap-1 rounded-full bg-white p-1.5 shadow-[0_12px_30px_-10px_rgba(0,0,0,0.5)]"
        onKeyDown={(e) => { if (e.key === 'ArrowRight') pick(current + 1); if (e.key === 'ArrowLeft') pick(current - 1); }}>
        {plans.map((p, i) => (
          <button
            key={p.name} id={`plan-tab-${i}`} type="button" role="tab" aria-selected={i === current} aria-controls="plan-panel" tabIndex={i === current ? 0 : -1}
            onClick={() => setCurrent(i)}
            className={`rounded-full px-3 py-3 text-sm font-semibold transition-colors sm:text-base ${i === current ? 'bg-[#C9430D] text-white' : 'text-[#17141A] hover:bg-[#F4F2F1]'} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F26A21]`}
          >
            {p.name} · GHS {p.price}
          </button>
        ))}
      </div>
    </div>
  );
}
