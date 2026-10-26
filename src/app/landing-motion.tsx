'use client';
import Image from 'next/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const SLIDE_MS = 5000;

/** Hero photos that crossfade in turn, each slowly zooming while it shows. Holds on the first photo when motion is reduced. */
export function HeroSlides({ slides }: { slides: Array<{ src: string; alt: string }> }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setShown((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => clearInterval(timer);
  }, [slides.length]);
  return (
    <div className="absolute inset-0 overflow-hidden">
      {slides.map((s, i) => (
        <Image
          key={s.src} src={s.src} alt={i === shown ? s.alt : ''} aria-hidden={i !== shown} fill priority={i === 0}
          sizes="(min-width: 1024px) 50vw, 100vw"
          className={`object-cover transition-opacity duration-[1200ms] ${i === shown ? 'opacity-100 landing-kenburns' : 'opacity-0'}`}
        />
      ))}
    </div>
  );
}

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
