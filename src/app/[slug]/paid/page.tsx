export const metadata = { robots: { index: false } };

/** Where Paystack returns a customer who paid at the till on their own phone; the till confirms the sale itself. */
export default function PaidPage() {
  return (
    <main className="mx-auto my-16 flex max-w-sm flex-col gap-3 p-4 text-center">
      <h1 className="text-2xl font-semibold">Thank you</h1>
      <p>Your payment was sent. The cashier&apos;s screen confirms it in a moment. You can close this page.</p>
    </main>
  );
}
