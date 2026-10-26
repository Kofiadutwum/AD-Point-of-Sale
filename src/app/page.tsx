import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { HeroSlides, Reveal } from './landing-motion';
import { ShopSignIn } from './shop-sign-in';

// self-hosted fonts, so building the site never depends on reaching Google Fonts
const display = { className: "font-['Bricolage_Grotesque_Variable',sans-serif]" };
const receiptFont = { className: "font-['IBM_Plex_Mono',monospace]" };

export const metadata: Metadata = {
  title: 'ADsmartshop: point of sale for shops, pharmacies and food businesses in Ghana',
  description: 'Sell, track stock and print receipts in cedis. Keeps selling when the internet is down.',
};

// shortcut: no contact number yet, so the trial button is hidden; set it (e.g. '233241234567') before launch
const WHATSAPP_NUMBER = '';

const HERO_SLIDES = [
  { src: '/landing/web/slide-fabric.webp', alt: 'A wax-print fabric shop with shelves of colourful cloth' },
  { src: '/landing/web/slide-supermarket.webp', alt: 'A supermarket aisle with fresh produce and packed shelves' },
  { src: '/landing/web/slide-grill.webp', alt: 'Grilled chicken skewers with lemon and tomatoes' },
  { src: '/landing/web/slide-pharmacy.webp', alt: 'Pharmacy shelves of medicines and supplements' },
];

const STRIP = [
  ['m-stall', 'Fruit stall'], ['m-phones', 'Phones and accessories'], ['m-fabric', 'Fabric shop'], ['m-burgers', 'Burgers and fried chicken'],
  ['m-sneakers', 'Sneaker wall'], ['m-veg', 'Vegetable display'], ['m-watches', 'Watch counter'], ['m-suits', 'Menswear shop'],
  ['m-oil', 'Motor oil shelves'], ['m-bags', 'Handbag shop'],
] as const;

const SHOP_TYPES = [
  {
    image: '/landing/web/retail.webp', alt: 'Shelves of soaps, creams and toiletries in a shop', title: 'Shops and supermarkets',
    points: ['Scan with a barcode scanner or the phone camera', 'Sell by the carton or by the piece, with wholesale prices', 'Weigh-scale labels scan straight into the sale'],
  },
  {
    image: '/landing/web/pharmacy.webp', alt: 'Pharmacy shelves stocked with medicines', title: 'Pharmacies and chemical sellers',
    points: ['Batch and expiry dates on every delivery', 'Prescription-only medicines are flagged at the till', 'Sell by the pack, strip or tablet'],
  },
  {
    image: '/landing/web/food.webp', alt: 'Trays of rice, stew and fried plantain at a food counter', title: 'Chop bars, grills and fast food',
    points: ['Order numbers and a ready screen for customers', 'Takeaway pack fee added for you', 'Mark a dish sold out for the rest of the day'],
  },
];

const PLANS = [
  { name: 'Starter', price: 150, branches: 1, tills: 2 },
  { name: 'Standard', price: 300, branches: 2, tills: 5 },
  { name: 'Pro', price: 600, branches: 5, tills: 15 },
];

function appHost() {
  try { return new URL(process.env.APP_URL ?? '').host; } catch { return 'adsmartshop.com'; }
}

// the receipt's bottom edge is cut in a zigzag, like paper torn off a till printer
const TORN_EDGE = {
  maskImage: 'linear-gradient(-45deg, transparent 7px, #000 0), linear-gradient(45deg, transparent 7px, #000 0), linear-gradient(#000, #000)',
  maskSize: '14px 14px, 14px 14px, 100% calc(100% - 7px)',
  maskRepeat: 'repeat-x, repeat-x, no-repeat',
  maskPosition: 'bottom left, bottom left, top',
};

function Receipt() {
  const line = 'flex justify-between gap-6';
  return (
    <div className="drop-shadow-[0_18px_24px_rgba(20,0,30,0.45)]">
      <div
        className={`${receiptFont.className} w-60 rotate-2 bg-white px-5 pt-5 pb-8 text-[13px] leading-6 text-[#2B0838] motion-safe:animate-[receipt-print_900ms_ease-out_600ms_both] sm:w-64`}
        style={TORN_EDGE}
        role="img"
        aria-label="Example receipt: Milo 400g, total GHS 25.00, paid GHS 50.00 cash, change GHS 25.00"
      >
        <p className="text-center font-semibold">Ama&apos;s Provisions</p>
        <p className="text-center">Receipt B1-T1-000001</p>
        <div className="my-2 border-t border-dashed border-current" />
        <p className={line}><span>Milo 400g × 1</span><span>25.00</span></p>
        <p className={line}><span>Tax</span><span>0.00</span></p>
        <div className="my-2 border-t border-dashed border-current" />
        <p className={`${line} font-semibold`}><span>Total GHS</span><span>25.00</span></p>
        <p className={line}><span>Cash</span><span>50.00</span></p>
        <p className={`${line} font-semibold text-[#8806A9]`}><span>Change</span><span>25.00</span></p>
        <p className="mt-3 text-center">Thank you. Come again.</p>
      </div>
    </div>
  );
}

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F0AC1A]';

export default function Home() {
  const trialHref = WHATSAPP_NUMBER
    ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('Hello, I would like a free trial of ADsmartshop for my shop.')}`
    : null;

  return (
    <div className={`${display.className} flex-1 bg-white text-[#2B0838]`}>
      <div className="bg-[#2B0838] text-white">
        <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-4 py-5 sm:px-8">
          <Link href="/" className={`flex items-center gap-3 rounded ${focus}`}>
            <span className="rounded-md bg-white p-1"><Image src="/landing/web/logo.png" alt="" width={40} height={30} priority /></span>
            <span className="text-xl font-bold tracking-tight">ADsmartshop</span>
          </Link>
          <a href="#sign-in" className={`rounded px-1 text-[#F0AC1A] underline-offset-4 hover:underline ${focus}`}>Shop sign in</a>
        </header>

        <section className="mx-auto grid max-w-7xl lg:min-h-[640px] lg:grid-cols-2">
          <div className="flex flex-col justify-center px-4 pt-6 pb-14 sm:px-8 lg:py-20">
            <h1 className="max-w-xl text-[2.6rem] leading-[1.05] font-extrabold tracking-[-0.03em] sm:text-6xl">
              <span className="landing-rise block">Sell, count stock</span>
              <span className="landing-rise block [animation-delay:120ms]">and print receipts</span>
              <span className="landing-rise block [animation-delay:240ms]">in cedis.</span>
            </h1>
            <p className="landing-rise mt-6 max-w-[34rem] text-lg leading-relaxed text-white/80 [animation-delay:380ms]">
              One till system for provision shops, pharmacies and chop bars. Take cash, mobile money, card or bank transfer,
              and keep selling when the internet goes off.
            </p>
            <div className="landing-rise mt-8 flex flex-wrap items-center gap-4 [animation-delay:500ms]">
              {trialHref && (
                <a href={trialHref} className={`rounded-md bg-[#F0AC1A] px-6 py-3 font-semibold text-[#2B0838] hover:bg-[#ffc23d] ${focus}`}>
                  Ask for a free trial on WhatsApp
                </a>
              )}
              <a href="#prices" className={`rounded px-1 font-semibold text-white underline decoration-[#F0AC1A] decoration-2 underline-offset-4 ${focus}`}>See prices</a>
            </div>
          </div>

          <div className="relative h-[460px] lg:h-auto">
            <HeroSlides slides={HERO_SLIDES} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#2B0838]/50 to-transparent" />
            <div className="absolute bottom-8 left-4 sm:left-8 lg:-left-16">
              <Receipt />
            </div>
          </div>
        </section>
      </div>

      <main>
        <section aria-label="Shops that sell with ADsmartshop" className="overflow-hidden py-10">
          <ul className="landing-marquee flex w-max gap-4">
            {[...STRIP, ...STRIP].map(([name, label], i) => (
              <li key={`${name}-${i}`} aria-hidden={i >= STRIP.length} className="w-40 shrink-0 sm:w-48">
                <Image src={`/landing/web/${name}.webp`} alt={i < STRIP.length ? label : ''} width={400} height={500} sizes="192px" className="aspect-[4/5] w-full rounded-lg object-cover" />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="types" className="mx-auto max-w-7xl px-4 py-14 sm:px-8">
          <Reveal>
            <h2 id="types" className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">Set up for the way your shop sells</h2>
          </Reveal>
          <div className="mt-10 grid gap-12 md:grid-cols-3 md:gap-8">
            {SHOP_TYPES.map((t, i) => (
              <Reveal key={t.title} className={['', 'md:[transition-delay:150ms]', 'md:[transition-delay:300ms]'][i]}>
                <article className="group">
                  <div className="overflow-hidden rounded-lg">
                    <Image src={t.image} alt={t.alt} width={736} height={920} sizes="(min-width: 768px) 33vw, 100vw" className="aspect-[4/5] w-full object-cover transition-transform duration-700 group-hover:scale-105 motion-reduce:transition-none" />
                  </div>
                  <h3 className="mt-5 text-xl font-bold">{t.title}</h3>
                  <ul className="mt-3 space-y-2 leading-snug text-[#2B0838]/80">
                    {t.points.map((p) => <li key={p} className="border-l-2 border-[#F0AC1A] pl-3">{p}</li>)}
                  </ul>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <section aria-labelledby="offline" className="mt-10 bg-[#2B0838] text-white">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-16 sm:px-8 md:grid-cols-2">
            <Reveal from="left">
              <h2 id="offline" className="text-3xl font-bold tracking-tight sm:text-5xl">No network? Keep selling.</h2>
            </Reveal>
            <Reveal from="right">
              <div className="max-w-xl space-y-4 text-lg leading-relaxed text-white/85">
                <p>Your tills keep taking cash and mobile money for up to 72 hours without internet. Every sale is saved on the device and sent to your account when the connection comes back, without being counted twice.</p>
                <p>Each cashier signs in with their own PIN, so you always know who sold what, at which till.</p>
              </div>
            </Reveal>
          </div>
        </section>

        <section aria-labelledby="receipts" className="mx-auto max-w-7xl px-4 py-20 sm:px-8">
          <Reveal className="grid gap-6 md:grid-cols-3">
            <h2 id="receipts" className="text-3xl font-bold tracking-tight">Every sale, on paper or on WhatsApp</h2>
            <p className="leading-relaxed text-[#2B0838]/80">Print on 80 mm or 58 mm receipt printers, or send the receipt to the customer&apos;s WhatsApp as a link they can open any time.</p>
            <p className="leading-relaxed text-[#2B0838]/80">Stock goes down with each sale and up when deliveries arrive, so the dashboard shows what sold today and what is running low.</p>
          </Reveal>
        </section>

        <section id="prices" aria-labelledby="prices-title" className="bg-[#F2F4F8]">
          <Reveal className="mx-auto max-w-7xl px-4 py-16 sm:px-8">
            <h2 id="prices-title" className="text-3xl font-bold tracking-tight sm:text-4xl">Prices</h2>
            <p className="mt-3 max-w-xl text-[#2B0838]/80">Paid monthly in cedis. Every plan starts with a free trial, and we set up your shop for you.</p>
            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[20rem] border-collapse text-left">
                <thead>
                  <tr className="border-b-2 border-[#2B0838]">
                    <th scope="col" className="py-3 pr-4 font-semibold">Plan</th>
                    <th scope="col" className="py-3 pr-4 font-semibold">Per month</th>
                    <th scope="col" className="py-3 pr-4 font-semibold">Branches</th>
                    <th scope="col" className="py-3 font-semibold">Tills</th>
                  </tr>
                </thead>
                <tbody>
                  {PLANS.map((p) => (
                    <tr key={p.name} className="border-b border-[#2B0838]/15">
                      <th scope="row" className="py-4 pr-4 text-lg font-bold">{p.name}</th>
                      <td className="py-4 pr-4 text-lg">GHS {p.price}</td>
                      <td className="py-4 pr-4">{p.branches}</td>
                      <td className="py-4">{p.tills}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </section>

        <section id="sign-in" aria-labelledby="sign-in-title" className="mx-auto max-w-7xl px-4 py-16 sm:px-8">
          <div className="max-w-xl">
            <h2 id="sign-in-title" className="text-2xl font-bold tracking-tight">Already using ADsmartshop?</h2>
            <p className="mt-2 mb-5 text-[#2B0838]/80">Type your shop address to go to your sign-in page.</p>
            <ShopSignIn host={appHost()} />
          </div>
        </section>
      </main>

      <footer className="border-t border-[#2B0838]/15">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-[#2B0838]/70 sm:px-8">
          <span>ADsmartshop, made for shops in Ghana</span>
          <Link href="/admin/login" className="rounded underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[#0773B5]">Platform admin</Link>
        </div>
      </footer>
    </div>
  );
}
