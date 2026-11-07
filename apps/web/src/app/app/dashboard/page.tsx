'use client';

import { useMe } from '@/features/auth/use-me';
import { t } from '@/shared/messages';
import { Alert } from '@/shared/ui';

export default function DashboardPage() {
  const { data } = useMe();
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.dashboard.title}</h1>
      {data?.partner?.kycStatus !== 'approved' && <Alert tone="info">{t.dashboard.kycBanner}</Alert>}
      <section aria-label={t.dashboard.pipeline} className="rounded-xl border border-line bg-white p-5">
        <h2 className="text-sm font-semibold text-muted">{t.dashboard.pipeline}</h2>
        <ol className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {t.dashboard.stages.map((stage) => (
            <li key={stage} className="rounded-lg bg-paper p-3">
              <p className="text-2xl font-bold">0</p>
              <p className="text-xs text-muted">{stage}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-xl border border-dashed border-line bg-white p-10 text-center">
        <p className="font-semibold">{t.dashboard.emptyTitle}</p>
        <p className="mt-1 text-sm text-muted">{t.dashboard.emptyBody}</p>
      </section>
    </div>
  );
}
