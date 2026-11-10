'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, downloadPost, unwrap } from '@/shared/api';
import { age, dateOnly, lastMonths, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Cell, DataTable, Empty, ErrorState, Skeleton, Tabs, fieldValue } from '@/shared/ui';

const PRODUCTS = [
  { value: 'used_car', label: 'Used Car Loan' }, { value: 'loan_against_car', label: 'Loan Against Car' }, { value: 'personal', label: 'Personal Loan' },
];
const FILTERS = ['status', 'bucket', 'caseType', 'product', 'registrationMonth', 'disbursedMonth', 'q'] as const;

function CasesList() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const { data: me } = useMe();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const page = Number(params.get('page') ?? 1);
  const filters = Object.fromEntries(FILTERS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : [])));

  const cases = useQuery({
    queryKey: ['cases', filters, page],
    queryFn: () => unwrap(api.GET('/cases', { params: { query: { ...filters, page, limit: 25 } } })),
    placeholderData: keepPreviousData,
  });

  /** Filters live in the address, so a link reproduces the same list. */
  function set(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(params);
    next.delete('page');
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${path}?${next}`);
  }

  async function download() {
    setBusy(true);
    setError('');
    try {
      await downloadPost('/cases/export', filters, 'vittora-cases.csv');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const can = (c: string) => me?.permissions.includes(c);
  const pages = cases.data?.pagination;
  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    set({ q: fieldValue(e, 'q').trim() || undefined });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t.cases.title} {pages && <span className="text-base font-medium text-muted">({pages.totalItems})</span>}</h1>
        <div className="flex gap-2">
          {can('case.export') && <Button ghost busy={busy} onClick={download}>{t.cases.export}</Button>}
          {can('case.create') && <Link href="/app/create-case" className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-deep">{t.cases.newCase}</Link>}
        </div>
      </div>
      {error && <Alert>{error}</Alert>}

      <Tabs label={t.cases.title} value={params.get('bucket') ?? ''} onChange={(v) => set({ bucket: v || undefined, status: undefined })}
        options={[{ value: '', label: t.cases.all }, ...Object.entries(t.cases.buckets).map(([value, label]) => ({ value, label }))]} />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <form onSubmit={search} className="sm:col-span-2 lg:col-span-1">
          <input key={params.get('q')} name="q" type="search" aria-label={t.cases.search} placeholder={t.cases.search} defaultValue={params.get('q') ?? ''}
            className="min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm" />
        </form>
        <select aria-label={t.cases.product} value={params.get('product') ?? ''} onChange={(e) => set({ product: e.target.value || undefined })} className="min-h-11 rounded-lg border border-line bg-white px-2 text-sm">
          <option value="">{t.cases.anyProduct}</option>
          {PRODUCTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select aria-label={t.cases.type} value={params.get('caseType') ?? ''} onChange={(e) => set({ caseType: e.target.value || undefined })} className="min-h-11 rounded-lg border border-line bg-white px-2 text-sm">
          <option value="">{t.cases.anyType}</option>
          {Object.entries(t.cases.types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label={t.cases.month} value={params.get('registrationMonth') ?? ''} onChange={(e) => set({ registrationMonth: e.target.value || undefined })} className="min-h-11 rounded-lg border border-line bg-white px-2 text-sm">
          <option value="">{t.cases.anyMonth}</option>
          {lastMonths().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {cases.isPending && <Skeleton className="h-64" />}
      {cases.isError && <ErrorState onRetry={() => cases.refetch()} />}
      {cases.data?.data.length === 0 && <Empty>{t.cases.empty}</Empty>}
      {!!cases.data?.data.length && (
        <DataTable head={t.cases.head} min={980}>
          {cases.data.data.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0 hover:bg-paper">
              <Cell strong><Link className="text-brand hover:underline" href={`/app/cases/${c.id}`}>{c.caseNo}</Link></Cell>
              <Cell>{c.applicant}<span className="block text-xs text-muted">{c.phone}</span></Cell>
              <Cell>{c.productName}<span className="block text-xs capitalize text-muted">{c.loanType.replaceAll('_', ' ')}</span></Cell>
              <Cell>{c.lender}</Cell>
              <Cell>{rupees(c.loanAmountPaise)}</Cell>
              <Cell><Badge status={c.status} label={t.cases.status[c.status]} /></Cell>
              <Cell>{c.loggedBy}</Cell>
              <Cell>{dateOnly(c.updatedAt)}</Cell>
              <Cell>{age(c.ageHours)}</Cell>
            </tr>
          ))}
        </DataTable>
      )}
      {pages && pages.totalPages > 1 && (
        <nav aria-label={t.cases.page} className="flex items-center justify-between text-sm">
          <Button ghost disabled={page <= 1} onClick={() => { const n = new URLSearchParams(params); n.set('page', String(page - 1)); router.replace(`${path}?${n}`); }}>{t.cases.previous}</Button>
          <span className="text-muted">{t.cases.page} {page} {t.cases.of} {pages.totalPages}</span>
          <Button ghost disabled={page >= pages.totalPages} onClick={() => { const n = new URLSearchParams(params); n.set('page', String(page + 1)); router.replace(`${path}?${n}`); }}>{t.cases.next}</Button>
        </nav>
      )}
    </div>
  );
}

export default function CasesPage() {
  return <Suspense fallback={<Skeleton className="h-64" />}><CasesList /></Suspense>;
}
