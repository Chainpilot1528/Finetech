'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, unwrap } from '@/shared/api';
import { rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Badge, Button, Cell, DataTable, Empty, ErrorState, Skeleton, Tabs } from '@/shared/ui';

type Group = '' | 'to_raise' | 'in_review' | 'pending_payout' | 'paid';

export default function InvoicesPage() {
  const [group, setGroup] = useState<Group>('');
  const invoices = useQuery({
    queryKey: ['invoices', group],
    queryFn: () => unwrap(api.GET('/invoices', { params: { query: group ? { group } : {} } })),
  });
  const s = invoices.data?.summary;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.invoices.title}</h1>
          <p className="text-sm text-muted">{t.invoices.subtitle}</p>
        </div>
        <Button ghost onClick={() => invoices.refetch()}>{t.invoices.refresh}</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[[t.invoices.pending, s?.pendingPaise], [t.invoices.review, s?.underReviewPaise], [t.invoices.paid, s?.paidPaise]].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-white p-5">
            <p className="text-xl font-bold">{rupees(Number(value ?? 0))}</p>
            <p className="text-sm text-muted">{label}</p>
          </div>
        ))}
      </div>
      <Tabs label={t.invoices.title} value={group} onChange={setGroup}
        options={[{ value: '' as Group, label: t.invoices.all }, ...Object.entries(t.invoices.groups).map(([value, label]) => ({ value: value as Group, label }))]} />
      {invoices.isPending && <Skeleton className="h-48" />}
      {invoices.isError && <ErrorState onRetry={() => invoices.refetch()} />}
      {invoices.data?.data.length === 0 && <Empty>{t.invoices.empty}</Empty>}
      {!!invoices.data?.data.length && (
        <DataTable head={t.invoices.head} min={860}>
          {invoices.data.data.map((i) => (
            <tr key={i.id} className="border-b border-line last:border-0 hover:bg-paper">
              <Cell strong><Link className="text-brand hover:underline" href={`/app/invoices/${i.id}`}>{i.invoiceNo ?? t.invoices.draftNo}</Link></Cell>
              <Cell><Link className="hover:underline" href={`/app/cases/${i.caseId}`}>{i.caseNo}</Link></Cell>
              <Cell>{i.applicant}</Cell>
              <Cell>{rupees(i.grossPaise)}</Cell>
              <Cell>{rupees(i.tdsPaise)}</Cell>
              <Cell>{rupees(i.gstPaise)}</Cell>
              <Cell strong>{rupees(i.netPaise)}</Cell>
              <Cell><Badge status={i.status} label={t.invoices.status[i.status]} /></Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
