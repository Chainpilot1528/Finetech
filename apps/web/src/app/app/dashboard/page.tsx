'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type CSSProperties, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { lastMonths, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { LineArt } from '@/shared/scene';
import { Alert, Badge, Card, ErrorState, Skeleton, Tabs } from '@/shared/ui';

const STAGE_STATUSES: Record<string, string> = {
  registered: 'REGISTERED,RELOOK', in_review: 'IN_REVIEW', approved: 'APPROVED,CUSTOMER_APPROVED', disbursing: 'DISBURSAL_IN_PROGRESS', disbursed: 'DISBURSED',
};

const TILE = 'rounded-2xl border border-line bg-white p-5 shadow-[0_1px_3px_rgba(10,79,68,.06)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_34px_rgba(10,79,68,.10)]';

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

  const maxStage = Math.max(1, ...(d?.stages.map((s) => s.count) ?? [0]));
  const rate = d?.approval.ratePct ?? null;
  const RING = 113.1; // circumference of the approval ring (r = 18)

  return (
    <div className="space-y-5">
      {/* Grid and faint finance line art behind the page (UI refresh, style B). */}
      <div aria-hidden className="v-grid-light pointer-events-none fixed inset-0 -z-10"><LineArt tone="light" /></div>
      <h1 className="v-in font-display text-3xl font-semibold tracking-tight">{t.dashboard.title}</h1>
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
          <div className="grid gap-4 sm:grid-cols-3">
            <Link href="/app/cases?bucket=needs_action" className={`${TILE} v-in v-d1 flex items-center justify-between gap-3`} data-testid="needs-action">
              <span>
                <span className="block font-display text-3xl font-semibold">{d.needsAction || '✓'}</span>
                <span className="block text-sm text-muted">{d.needsAction === 0 ? t.dashboard.caughtUp : d.needsAction === 1 ? t.dashboard.waitingOne : t.dashboard.waiting}</span>
              </span>
              <span aria-hidden className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${d.needsAction ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-brand'}`}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d.needsAction ? <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></> : <path d="M5 12l5 5L20 7" />}</svg>
              </span>
            </Link>
            <div className={`${TILE} v-in v-d2 flex items-center justify-between gap-3`}>
              <span>
                <span className="block font-display text-3xl font-semibold">{rate === null || rate === undefined ? '–' : `${rate}%`}</span>
                <span className="block text-sm text-muted">{t.dashboard.approvalRate}</span>
                <span className="block text-xs text-muted">{d.approval.decided ? `${d.approval.approved} ${t.dashboard.approvalOf} ${d.approval.decided} ${t.dashboard.approvalCases}` : t.dashboard.noDecisions}</span>
              </span>
              <svg aria-hidden width="48" height="48" viewBox="0 0 44 44" className="shrink-0">
                <circle cx="22" cy="22" r="18" fill="none" stroke="#e3ece9" strokeWidth="5" />
                <circle cx="22" cy="22" r="18" fill="none" stroke="#0f6b5c" strokeWidth="5" strokeLinecap="round" transform="rotate(-90 22 22)"
                  strokeDasharray={RING} strokeDashoffset={RING * (1 - (rate ?? 0) / 100)} className="v-ring"
                  style={{ '--ring-from': RING, '--ring-to': RING * (1 - (rate ?? 0) / 100) } as CSSProperties} />
              </svg>
            </div>
            {canCreate && (
              <Link href="/app/create-case" className="v-in v-d3 flex items-center justify-center gap-2 rounded-2xl bg-brand p-5 font-semibold text-white shadow-[0_10px_30px_rgba(15,107,92,.25)] transition hover:-translate-y-0.5 hover:bg-brand-deep">
                <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                {t.dashboard.newCase}
              </Link>
            )}
          </div>

          {view === 'pipeline' ? (
            <Card title={t.dashboard.pipeline} className="v-in v-d4">
              <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {d.stages.map((s) => (
                  <li key={s.key}>
                    <Link href={`/app/cases?status=${STAGE_STATUSES[s.key]}&registrationMonth=${month.value}`} className="block rounded-xl bg-paper p-3 transition hover:-translate-y-0.5 hover:ring-1 hover:ring-brand" data-testid={`stage-${s.key}`}>
                      <p className="font-display text-2xl font-semibold">{s.count}</p>
                      <p className="text-xs text-muted">{t.dashboard.stages[s.key]}</p>
                      <span aria-hidden className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-[#e3ece9]">
                        <span className={`v-fill block h-full rounded-full ${s.key === 'disbursed' ? 'bg-gold' : 'bg-brand'}`} style={{ width: `${(s.count / maxStage) * 100}%` }} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Card>
          ) : (
            <Card title={t.dashboard.revenue} className="v-in v-d4">
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
            <Card title={t.dashboard.commission} className="v-in v-d5">
              <div className="grid gap-3 sm:grid-cols-3">
                {[[t.dashboard.commissionPending, d.commission.pending], [t.dashboard.commissionReview, d.commission.inReview], [t.dashboard.commissionPaid, d.commission.paid]].map(([label, value]) => (
                  <Link key={label} href="/app/invoices" className="rounded-xl bg-paper p-3 transition hover:-translate-y-0.5 hover:ring-1 hover:ring-gold"><p className="font-display text-lg font-semibold text-[#8a5f17]">{rupees(Number(value ?? 0))}</p><p className="text-xs text-muted">{label}</p></Link>
                ))}
              </div>
            </Card>
          )}

          {d.totalCases === 0 ? (
            <section className="v-in v-d5 rounded-2xl border border-dashed border-line bg-white p-10 text-center">
              <p className="font-semibold">{t.dashboard.emptyTitle}</p>
              <p className="mt-1 text-sm text-muted">{t.dashboard.emptyBody}</p>
            </section>
          ) : (
            <Card className="v-in v-d5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold">{t.dashboard.recent}</h2>
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
