'use client';

import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { percent, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, Cell, DataTable, Empty, ErrorState, Field, Select, Skeleton, fieldValue } from '@/shared/ui';

const PRODUCTS = [{ value: 'used_car', label: 'Used Car Loan' }, { value: 'loan_against_car', label: 'Loan Against Car' }, { value: 'personal', label: 'Personal Loan' }];

export default function RateCardsPage() {
  const { data: me } = useMe();
  const [error, setError] = useState('');
  const cards = useQuery({ queryKey: ['rate-cards'], queryFn: () => unwrap(api.GET('/ops/rate-cards')) });

  async function run(work: () => Promise<unknown>, form?: HTMLFormElement) {
    setError('');
    try {
      await work();
      form?.reset();
      await cards.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = (k: string) => fieldValue(e, k);
    const body = {
      lenderId: v('lenderId'), product: v('product'), ...(v('loanType') ? { loanType: v('loanType') } : {}), slabMin: Number(v('slabMin')),
      ...(v('slabMax') ? { slabMax: Number(v('slabMax')) } : {}), pctBps: Math.round(Number(v('pct')) * 100), clawbackMonths: Number(v('clawbackMonths')),
      validFrom: v('validFrom'), ...(v('validTo') ? { validTo: v('validTo') } : {}),
    };
    run(() => unwrap(api.POST('/ops/rate-cards', { body })), e.currentTarget);
  }

  const decide = (id: string, decision: string) => run(() => unwrap(api.POST('/ops/rate-cards/{id}/decision', { params: { path: { id } }, body: { decision } })));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.ops.ratesTitle}</h1>
      {error && <Alert>{error}</Alert>}
      {cards.data && (
        <Card title={t.ops.newRate}>
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-3">
            <Select label={t.ops.lender} name="lenderId" options={cards.data.lenders.map((l) => ({ value: l.id, label: l.name }))} />
            <Select label={t.ops.product} name="product" options={PRODUCTS} />
            <Field label={t.ops.loanType} name="loanType" />
            <Field label={t.ops.slabMin} name="slabMin" type="number" min={0} defaultValue={0} required />
            <Field label={t.ops.slabMax} name="slabMax" type="number" min={0} />
            <Field label={t.ops.pct} name="pct" type="number" step="0.01" min={0.01} max={100} required />
            <Field label={t.ops.clawbackMonths} name="clawbackMonths" type="number" min={0} defaultValue={6} required />
            <Field label={t.ops.validFrom} name="validFrom" type="date" required />
            <Field label={t.ops.validTo} name="validTo" type="date" />
            <div className="sm:col-span-3"><Button type="submit">{t.ops.create}</Button></div>
          </form>
        </Card>
      )}
      {cards.isPending && <Skeleton className="h-48" />}
      {cards.isError && <ErrorState onRetry={() => cards.refetch()} />}
      {cards.data?.data.length === 0 && <Empty>{t.ops.noRates}</Empty>}
      {!!cards.data?.data.length && (
        <DataTable head={t.ops.rateHead} min={860}>
          {cards.data.data.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0">
              <Cell strong>{r.lender}</Cell>
              <Cell>{r.product}{r.loanType ? ` · ${r.loanType}` : ''}</Cell>
              <Cell>{rupees(r.slabMinPaise)} – {r.slabMaxPaise ? rupees(r.slabMaxPaise) : '∞'}</Cell>
              <Cell>{percent(r.pctBps)}</Cell>
              <Cell>{r.clawbackMonths}</Cell>
              <Cell>{r.validFrom}</Cell>
              <Cell><Badge status={r.status} label={r.status} /></Cell>
              <Cell>
                {r.status === 'pending' && r.createdBy !== me?.userId && (
                  <div className="flex gap-2">
                    <Button ghost onClick={() => decide(r.id, 'active')}>{t.ops.activate}</Button>
                    <Button ghost onClick={() => decide(r.id, 'rejected')}>{t.ops.reject}</Button>
                  </div>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
