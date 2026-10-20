import { adminCtx } from '../admin-ctx';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await adminCtx();
  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between border-b pb-3">
        <a href="/admin/shops" className="font-semibold">Platform admin</a>
        <span className="text-sm text-gray-600">{admin.name}</span>
      </header>
      {children}
    </div>
  );
}
