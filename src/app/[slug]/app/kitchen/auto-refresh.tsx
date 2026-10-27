'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Reloads the server-rendered page every `ms`, so new orders appear without a tap. */
export function AutoRefresh({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), ms);
    return () => clearInterval(timer);
  }, [ms, router]);
  return null;
}
