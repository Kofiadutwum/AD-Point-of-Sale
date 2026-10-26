'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { normaliseSlug } from '@/lib/slug';

/** Staff type their shop's address and go to that shop's sign-in page. */
export function ShopSignIn({ host }: { host: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const slug = normaliseSlug(value);
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => { e.preventDefault(); if (slug) router.push(`/${slug}/login`); }}
    >
      <label className="flex flex-1 flex-col gap-1 text-sm">
        Your shop address
        <span className="flex items-center rounded-md border border-[#2B0838]/30 bg-white focus-within:border-[#0773B5] focus-within:ring-2 focus-within:ring-[#0773B5]/30">
          <span className="pl-3 text-[#2B0838]/55">{host}/</span>
          <input
            value={value} onChange={(e) => setValue(e.target.value)} required autoComplete="off"
            placeholder="your-shop" className="min-w-0 flex-1 bg-transparent py-2.5 pr-3 outline-none"
          />
        </span>
      </label>
      <button type="submit" className="rounded-md border-2 border-[#2B0838] px-5 py-2.5 font-semibold hover:bg-[#2B0838] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0773B5]">
        Sign in
      </button>
    </form>
  );
}
