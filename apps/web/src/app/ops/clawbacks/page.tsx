'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Cell, DataTable, Empty, ErrorState, Skeleton } from '@/shared/ui';

export default function ClawbacksPage() {
  const { data: me } = useMe();
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['clawbacks'], queryFn: () => unwrap(api.GET('/ops/clawbacks')) });

  async function decide(id: string, decision: string) {
    setError('');
    try {
      await unwrap(api.POST('/ops/clawbacks/{id}/decision', { params: { path: { id } }, body: { decision } }));
      await list.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{t.ops.clawbacksTitle}</h1>
      {error && <Alert>{error}</Alert>}
      {list.isPending && <Skeleton className="h-48" />}
      {list.isError && <ErrorState onRetry={() => list.refetch()} />}
      {list.data?.data.length === 0 && <Empty>{t.ops.noClawbacks}</Empty>}
      {!!list.data?.data.length && (
        <DataTable head={t.ops.clawbackHead} min={800}>
          {list.data.data.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0">
              <Cell strong>{c.partner}</Cell>
              <Cell>{c.invoiceNo}</Cell>
              <Cell>{rupees(c.amountPaise)}</Cell>
              <Cell>{rupees(c.recoveredPaise)}</Cell>
              <Cell>{c.reason}</Cell>
              <Cell><Badge status={c.status} label={c.status} /></Cell>
              <Cell>
                {c.status === 'pending' && c.raisedBy !== me?.userId && (
                  <div className="flex gap-2">
                    <Button ghost onClick={() => decide(c.id, 'approved')}>{t.ops.approve}</Button>
                    <Button ghost onClick={() => decide(c.id, 'rejected')}>{t.ops.reject}</Button>
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
