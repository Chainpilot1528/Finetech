'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { age, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Cell, DataTable, Empty, ErrorState, Skeleton, Tabs } from '@/shared/ui';

type Who = '' | 'me' | 'none';

export default function OpsCasesPage() {
  const { data: me } = useMe();
  const [status, setStatus] = useState('');
  const [who, setWho] = useState<Who>('');
  const [notice, setNotice] = useState('');
  const queue = useQuery({
    queryKey: ['ops-cases', status, who],
    queryFn: () => unwrap(api.GET('/ops/cases', { params: { query: { ...(status ? { status } : {}), ...(who ? { assigned: who } : {}), limit: 100 } } })),
  });

  async function autoAssign() {
    const res = await unwrap(api.POST('/ops/cases/auto-assign')) as unknown as { assigned: number };
    setNotice(`${res.assigned} ${t.ops.assignedCount}`);
    await queue.refetch();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t.ops.casesTitle}</h1>
        {me?.permissions.includes('ops.assign') && <Button ghost onClick={autoAssign}>{t.ops.autoAssign}</Button>}
      </div>
      {notice && <Alert tone="success">{notice}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs label={t.ops.assignee} value={who} onChange={setWho} options={[{ value: '' as Who, label: t.ops.everyone }, { value: 'me' as Who, label: t.ops.mine }, { value: 'none' as Who, label: t.ops.unassigned }]} />
        <select aria-label={t.ops.anyStatus} value={status} onChange={(e) => setStatus(e.target.value)} className="min-h-9 rounded-lg border border-line bg-white px-2 text-sm">
          <option value="">{t.ops.anyStatus}</option>
          {Object.entries(t.cases.status).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {queue.isPending && <Skeleton className="h-48" />}
      {queue.isError && <ErrorState onRetry={() => queue.refetch()} />}
      {queue.data?.data.length === 0 && <Empty>{t.ops.noCases}</Empty>}
      {!!queue.data?.data.length && (
        <DataTable head={t.ops.caseHead} min={860}>
          {queue.data.data.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0">
              <Cell strong>{c.caseNo}{c.possibleDuplicate && <span className="block text-xs font-normal text-amber-800">{t.ops.duplicate}</span>}</Cell>
              <Cell>{c.partner}</Cell>
              <Cell>{c.productName}</Cell>
              <Cell>{rupees(c.loanAmountPaise)}</Cell>
              <Cell><Badge status={c.status} label={t.cases.status[c.status]} /></Cell>
              <Cell>{c.assignee ?? '–'}</Cell>
              <Cell>{age(c.ageHours)}</Cell>
              <Cell><Link className="font-medium text-brand hover:underline" href={`/ops/cases/${c.id}`}>{t.ops.open}</Link></Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
