'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { lastMonths, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Card, ErrorState, Skeleton, Tabs } from '@/shared/ui';

const STAGE_STATUSES: Record<string, string> = {
  registered: 'REGISTERED,RELOOK', in_review: 'IN_REVIEW', approved: 'APPROVED,CUSTOMER_APPROVED', disbursing: 'DISBURSAL_IN_PROGRESS', disbursed: 'DISBURSED',
};

export default function DashboardPage() {
  const { data: me } = useMe();
  const months = lastMonths();
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<'pipeline' | 'revenue'>('pipeline');
  const month = months[index]!;
  const summary = useQuery({
    queryKey: ['dashboard', month.value, view],
    queryFn: () => unwrap(api.GET('/dashboard/summary', { params: { query: { month: month.value, view } } })),
  });
  const canKyc = me?.permissions.includes('kyc.manage');
  const canCreate = me?.permissions.includes('case.create');
  const d = summary.data;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.dashboard.title}</h1>
      {me?.partner?.kycStatus !== 'approved' && (
        <Alert tone="info">
          {canKyc ? t.kyc.status[me?.partner?.kycStatus ?? ''] ?? t.dashboard.kycBanner : t.dashboard.kycBannerStaff}{' '}
          {canKyc && <Link href="/app/kyc" className="font-semibold underline">{t.dashboard.kycAction}</Link>}
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs label={t.dashboard.title} value={view} onChange={setView} options={[{ value: 'pipeline', label: t.dashboard.pipeline }, { value: 'revenue', label: t.dashboard.revenue }]} />
        <div className="flex items-center gap-1">
          <button type="button" aria-label={t.dashboard.prev} disabled={index === months.length - 1} onClick={() => setIndex(index + 1)} className="min-h-9 min-w-9 rounded-lg border border-line bg-white disabled:opacity-40">‹</button>
          <select aria-label={t.cases.month} value={month.value} onChange={(e) => setIndex(months.findIndex((m) => m.value === e.target.value))} className="min-h-9 rounded-lg border border-line bg-white px-2 text-sm">
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" aria-label={t.dashboard.next} disabled={index === 0} onClick={() => setIndex(index - 1)} className="min-h-9 min-w-9 rounded-lg border border-line bg-white disabled:opacity-40">›</button>
        </div>
      </div>
      <p className="text-sm text-muted">{view === 'pipeline' ? t.dashboard.showing : t.dashboard.showingRevenue} {month.label}</p>

      {summary.isPending && <Skeleton className="h-64" />}
      {summary.isError && <ErrorState onRetry={() => summary.refetch()} />}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Link href="/app/cases?bucket=needs_action" className="rounded-xl border border-line bg-white p-5 hover:border-brand" data-testid="needs-action">
              <p className="text-2xl font-bold">{d.needsAction || '✓'}</p>
              <p className="text-sm text-muted">{d.needsAction === 0 ? t.dashboard.caughtUp : d.needsAction === 1 ? t.dashboard.waitingOne : t.dashboard.waiting}</p>
            </Link>
            <div className="rounded-xl border border-line bg-white p-5">
              <p className="text-2xl font-bold">{d.approval.ratePct === null || d.approval.ratePct === undefined ? '–' : `${d.approval.ratePct}%`}</p>
              <p className="text-sm text-muted">{t.dashboard.approvalRate}</p>
              <p className="text-xs text-muted">{d.approval.decided ? `${d.approval.approved} ${t.dashboard.approvalOf} ${d.approval.decided} ${t.dashboard.approvalCases}` : t.dashboard.noDecisions}</p>
            </div>
            {canCreate && (
              <Link href="/app/create-case" className="flex items-center justify-center rounded-xl bg-brand p-5 font-semibold text-white hover:bg-brand-deep">{t.dashboard.newCase}</Link>
            )}
          </div>

          {view === 'pipeline' ? (
            <Card title={t.dashboard.pipeline}>
              <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {d.stages.map((s) => (
                  <li key={s.key}>
                    <Link href={`/app/cases?status=${STAGE_STATUSES[s.key]}&registrationMonth=${month.value}`} className="block rounded-lg bg-paper p-3 hover:ring-1 hover:ring-brand" data-testid={`stage-${s.key}`}>
                      <p className="text-2xl font-bold">{s.count}</p>
                      <p className="text-xs text-muted">{t.dashboard.stages[s.key]}</p>
                    </Link>
                  </li>
                ))}
              </ol>
            </Card>
          ) : (
            <Card title={t.dashboard.revenue}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Link href={`/app/cases?disbursedMonth=${month.value}`} className="rounded-lg bg-paper p-3 hover:ring-1 hover:ring-brand"><p className="text-2xl font-bold">{d.revenue.cases}</p><p className="text-xs text-muted">{t.dashboard.disbursedCases}</p></Link>
                <div className="rounded-lg bg-paper p-3"><p className="text-2xl font-bold">{rupees(d.revenue.amountPaise)}</p><p className="text-xs text-muted">{t.dashboard.disbursedAmount}</p></div>
              </div>
              {d.revenue.byProduct.length > 0 && (
                <ul className="mt-4 divide-y divide-line text-sm">
                  {d.revenue.byProduct.map((p) => <li key={p.product} className="flex justify-between py-2"><span>{p.productName} ({p.cases})</span><span className="font-medium">{rupees(p.amountPaise)}</span></li>)}
                </ul>
              )}
            </Card>
          )}

          {d.commission && (
            <Card title={t.dashboard.commission}>
              <div className="grid gap-3 sm:grid-cols-3">
                {[[t.dashboard.commissionPending, d.commission.pending], [t.dashboard.commissionReview, d.commission.inReview], [t.dashboard.commissionPaid, d.commission.paid]].map(([label, value]) => (
                  <Link key={label} href="/app/invoices" className="rounded-lg bg-paper p-3 hover:ring-1 hover:ring-brand"><p className="text-lg font-bold">{rupees(Number(value ?? 0))}</p><p className="text-xs text-muted">{label}</p></Link>
                ))}
              </div>
            </Card>
          )}

          {d.totalCases === 0 ? (
            <section className="rounded-xl border border-dashed border-line bg-white p-10 text-center">
              <p className="font-semibold">{t.dashboard.emptyTitle}</p>
              <p className="mt-1 text-sm text-muted">{t.dashboard.emptyBody}</p>
            </section>
          ) : (
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">{t.dashboard.recent}</h2>
                <Link href="/app/cases" className="text-sm font-medium text-brand hover:underline">{t.dashboard.seeAll} {d.totalCases} →</Link>
              </div>
              <ul className="divide-y divide-line text-sm">
                {d.recent.map((c) => (
                  <li key={c.id}>
                    <Link href={`/app/cases/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:text-brand">
                      <span><span className="font-medium">{c.caseNo}</span> · {c.applicant} · {c.productName}</span>
                      <Badge status={c.status} label={t.cases.status[c.status]} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
