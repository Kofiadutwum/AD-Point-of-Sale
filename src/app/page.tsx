import '@fontsource-variable/bricolage-grotesque';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PictureRow, PlanTabs, Reveal } from './landing-motion';
import { FOOD_PICTURES, PHARMACY_PICTURES, SHOPS_PICTURES, type Picture } from './landing-pictures';
import { ShopSignIn } from './shop-sign-in';

export const metadata: Metadata = {
  title: 'ADsmartshop: point of sale for shops, pharmacies and food businesses in Ghana',
  description: 'Sell, track stock and print receipts in cedis. Keeps selling when the internet is down.',
};

// shortcut: no contact number yet, so the trial button is hidden; set it (e.g. '233241234567') before launch
const WHATSAPP_NUMBER = '';

const PLANS = [
  { name: 'Starter', price: 150, branches: 1, tills: 2 },
  { name: 'Standard', price: 300, branches: 2, tills: 5 },
  { name: 'Pro', price: 600, branches: 5, tills: 15 },
];

const CATEGORIES: Array<{ id: string; title: string; points: string[]; pictures: Picture[]; dark: boolean }> = [
  {
    id: 'shops', title: 'Shops and supermarkets', pictures: SHOPS_PICTURES, dark: false,
    points: ['Scan with a barcode scanner or the phone camera', 'Sell by the carton or by the piece, with wholesale prices', 'Weigh-scale labels scan straight into the sale'],
  },
  {
    id: 'pharmacies', title: 'Pharmacies and chemical sellers', pictures: PHARMACY_PICTURES, dark: true,
    points: ['Batch and expiry dates on every delivery', 'Prescription-only medicines are flagged at the till', 'Sell by the pack, strip or tablet'],
  },
  {
    id: 'food', title: 'Chop bars, grills and fast food', pictures: FOOD_PICTURES, dark: false,
    points: ['Order numbers and a ready screen for customers', 'Takeaway pack fee added for you', 'Mark a dish sold out for the rest of the day'],
  },
];

const STEPS = [
  ['We set up your shop', 'Tell us your shop name and branches. We create your account and send you the sign-in link.'],
  ['Add your products', 'Type them in or scan their barcodes, with prices in cedis.'],
  ['Open your till', 'Use any phone, tablet or computer with a browser as the till.'],
  ['Start selling', 'Take cash, mobile money, card or bank transfer, and print or WhatsApp the receipt.'],
] as const;

const ORANGE = 'bg-[#C9430D] text-white hover:bg-[#A9380B]';
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F26A21]';

function appHost() {
  try { return new URL(process.env.APP_URL ?? '').host; } catch { return 'adsmartshop.com'; }
}

function TrialOrSignIn({ trialHref }: { trialHref: string | null }) {
  return trialHref
    ? <a href={trialHref} className={`inline-block rounded-full px-7 py-3 font-semibold ${ORANGE} ${focus}`}>Ask for a free trial on WhatsApp</a>
    : <a href="#start" className={`inline-block rounded-full px-7 py-3 font-semibold ${ORANGE} ${focus}`}>Get started</a>;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-11 w-11 place-items-center rounded-lg bg-[#FDEBE3] text-[#C9430D]">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </span>
  );
}

export default function Home() {
  const trialHref = WHATSAPP_NUMBER
    ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('Hello, I would like a free trial of ADsmartshop for my shop.')}`
    : null;

  return (
    <div className="flex-1 bg-white font-['Bricolage_Grotesque_Variable',sans-serif] text-[#17141A]">
      <div className="bg-[#17141A] text-white">
        <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-8">
          <Link href="/" className={`flex items-center gap-3 rounded ${focus}`}>
            <span className="rounded-md bg-white p-1"><Image src="/landing/web/logo.png" alt="" width={40} height={30} priority /></span>
            <span className="text-xl font-bold tracking-tight">ADsmartshop</span>
          </Link>
          <nav aria-label="Main" className="hidden gap-7 text-sm text-white/80 md:flex">
            <a href="#shops" className={`rounded hover:text-white ${focus}`}>Shops</a>
            <a href="#pharmacies" className={`rounded hover:text-white ${focus}`}>Pharmacies</a>
            <a href="#food" className={`rounded hover:text-white ${focus}`}>Food</a>
            <a href="#prices" className={`rounded hover:text-white ${focus}`}>Prices</a>
          </nav>
          <a href="#start" className={`rounded-full px-5 py-2 text-sm font-semibold ${ORANGE} ${focus}`}>Shop sign in</a>
        </header>

        <section className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pt-6 pb-28 sm:px-8 md:grid-cols-2 md:pt-12 md:pb-36">
          <div>
            <h1 className="landing-rise text-[2.7rem] leading-[1.04] font-extrabold tracking-[-0.03em] sm:text-6xl">
              The till system for shops in Ghana
            </h1>
            <p className="landing-rise mt-6 max-w-md text-lg leading-relaxed text-white/75 [animation-delay:150ms]">
              Sell, count stock and print receipts in cedis. Made for provision shops, pharmacies and chop bars, and it keeps selling when the internet goes off.
            </p>
            <div className="landing-rise mt-8 [animation-delay:300ms]"><TrialOrSignIn trialHref={trialHref} /></div>
          </div>
          <div className="relative mx-auto w-full max-w-sm md:max-w-md">
            <div className="absolute -inset-4 -rotate-6 rounded-[2rem] bg-[#26212A]" aria-hidden="true" />
            <Image
              src="/landing/web/hero-shop.webp" alt="A shop front stacked with fresh fruit and vegetables" width={736} height={736} priority
              sizes="(min-width: 768px) 448px, 90vw"
              className="landing-float relative aspect-square w-full rotate-3 rounded-[1.75rem] object-cover shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)]"
            />
            <span className="absolute -top-3 -left-3 h-6 w-6 rounded-full bg-[#F26A21]" aria-hidden="true" />
            <span className="absolute -right-2 bottom-10 h-3 w-3 rounded-full bg-[#F0AC1A]" aria-hidden="true" />
          </div>
        </section>

        {/* torn paper edge into the white section below */}
        <svg className="-mt-16 block h-16 w-full text-white" viewBox="0 0 1200 64" preserveAspectRatio="none" aria-hidden="true">
          <path fill="currentColor" d="M0 40 L40 30 L70 44 L110 26 L150 38 L190 22 L240 40 L280 30 L330 46 L370 28 L420 36 L460 20 L510 42 L560 30 L600 44 L650 24 L700 38 L740 28 L790 46 L840 26 L880 40 L930 22 L980 42 L1020 32 L1070 46 L1110 26 L1160 38 L1200 28 L1200 64 L0 64 Z" />
        </svg>
      </div>

      <main>
        <section aria-labelledby="why" className="bg-[linear-gradient(#fff_0,#fff_58%,#17141A_58%)] pb-20">
          <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-8">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 id="why" className="text-3xl font-bold tracking-tight sm:text-4xl">Everything at the counter, in one place</h2>
              <p className="mt-3 text-[#17141A]/70">Payments, receipts and stock stay together, even on a slow network.</p>
            </Reveal>
            <Reveal className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Image src={SHOPS_PICTURES[5].src} alt={SHOPS_PICTURES[5].alt} width={480} height={600} sizes="(min-width: 1024px) 25vw, 50vw" className="h-full min-h-56 w-full rounded-xl object-cover" />
              <article className="rounded-xl bg-white p-6 shadow-[0_18px_40px_-18px_rgba(23,20,26,0.35)]">
                <Icon><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M6 15h4" /></Icon>
                <h3 className="mt-4 text-lg font-bold">Every way to pay</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#17141A]/70">Cash with change worked out, mobile money, card terminal and bank transfer, each with its reference.</p>
              </article>
              <article className="rounded-xl bg-white p-6 shadow-[0_18px_40px_-18px_rgba(23,20,26,0.35)]">
                <Icon><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h0M2 2l20 20" /></Icon>
                <h3 className="mt-4 text-lg font-bold">Sells without internet</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#17141A]/70">Tills keep selling for up to 72 hours offline and send every sale once the network is back.</p>
              </article>
              <Image src={FOOD_PICTURES[5].src} alt={FOOD_PICTURES[5].alt} width={480} height={600} sizes="(min-width: 1024px) 25vw, 50vw" className="h-full min-h-56 w-full rounded-xl object-cover" />
            </Reveal>
          </div>
        </section>

        {CATEGORIES.map((c) => (
          <section key={c.id} id={c.id} aria-labelledby={`${c.id}-title`} className={c.dark ? 'bg-[#17141A] text-white' : ''}>
            <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8">
              <Reveal className="grid gap-6 md:grid-cols-[1fr_1.2fr] md:items-end">
                <div>
                  <h2 id={`${c.id}-title`} className="text-3xl font-bold tracking-tight sm:text-4xl">{c.title}</h2>
                  <p className={`mt-2 text-sm ${c.dark ? 'text-white/60' : 'text-[#17141A]/60'}`}>{c.pictures.length} pictures</p>
                </div>
                <ul className={`space-y-2 ${c.dark ? 'text-white/85' : 'text-[#17141A]/80'}`}>
                  {c.points.map((p) => (
                    <li key={p} className="flex gap-3">
                      <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#F26A21]" aria-hidden="true" />{p}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <div className="mt-8"><PictureRow label={c.title} pictures={c.pictures} /></div>
            </div>
          </section>
        ))}

        <section id="prices" aria-labelledby="prices-title" className="bg-[#17141A] text-white">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-8 md:grid-cols-[1.2fr_1fr]">
            <div>
              <h2 id="prices-title" className="mb-8 text-3xl font-bold tracking-tight sm:text-4xl">Simple monthly prices</h2>
              <PlanTabs plans={PLANS} action={<TrialOrSignIn trialHref={trialHref} />} />
            </div>
            <div className="relative mx-auto w-64 sm:w-80">
              <Image src={FOOD_PICTURES[4].src} alt={FOOD_PICTURES[4].alt} width={480} height={600} sizes="320px"
                className="landing-spin aspect-square w-full rounded-full border-8 border-[#26212A] object-cover shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8)]" />
              <span className="absolute top-4 -right-2 h-5 w-5 rounded-full bg-[#F26A21]" aria-hidden="true" />
            </div>
          </div>
        </section>

        <section id="start" aria-labelledby="start-title" className="bg-[#F4F2F1]">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-8">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 id="start-title" className="text-3xl font-bold tracking-tight sm:text-4xl">Getting started</h2>
              <p className="mt-3 text-[#17141A]/70">Most shops are selling the same day.</p>
            </Reveal>
            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              <Reveal from="left" className="grid overflow-hidden rounded-xl bg-white shadow-[0_18px_40px_-18px_rgba(23,20,26,0.35)] sm:grid-cols-[0.8fr_1.2fr]">
                <Image src={SHOPS_PICTURES[18].src} alt={SHOPS_PICTURES[18].alt} width={480} height={600} sizes="(min-width: 640px) 240px, 100vw" className="h-56 w-full object-cover sm:h-full" />
                <ol className="space-y-5 p-6">
                  {STEPS.map(([title, text], i) => (
                    <li key={title} className="flex gap-4">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#C9430D] text-sm font-bold text-white">{i + 1}</span>
                      <div>
                        <h3 className="font-bold">{title}</h3>
                        <p className="mt-1 text-sm leading-relaxed text-[#17141A]/70">{text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Reveal>
              <Reveal from="right" className="rounded-xl bg-white p-6 shadow-[0_18px_40px_-18px_rgba(23,20,26,0.35)] sm:p-8">
                <h3 className="text-2xl font-bold tracking-tight">Already using ADsmartshop?</h3>
                <p className="mt-2 mb-6 text-[#17141A]/70">Type your shop address to go to your sign-in page.</p>
                <ShopSignIn host={appHost()} />
                <div className="mt-8 border-t border-[#17141A]/10 pt-6">
                  <h3 className="font-bold">New shop?</h3>
                  <p className="mt-1 mb-4 text-sm text-[#17141A]/70">Every plan starts with a free trial. We set up your shop for you.</p>
                  {trialHref
                    ? <a href={trialHref} className={`inline-block rounded-full px-6 py-2.5 font-semibold ${ORANGE} ${focus}`}>Ask for a free trial on WhatsApp</a>
                    : <a href="#prices" className={`inline-block rounded-full border-2 border-[#17141A] px-6 py-2.5 font-semibold hover:bg-[#17141A] hover:text-white ${focus}`}>See prices</a>}
                </div>
              </Reveal>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-[#17141A] text-white/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm sm:px-8">
          <span>ADsmartshop, made for shops in Ghana</span>
          <Link href="/admin/login" className={`rounded hover:text-white ${focus}`}>Platform admin</Link>
        </div>
      </footer>
    </div>
  );
}
