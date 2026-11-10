'use client';

import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Cell, DataTable, Empty, ErrorState, Skeleton, fieldValue } from '@/shared/ui';

export default function OpsInvoicesPage() {
  const { data: me } = useMe();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const invoices = useQuery({
    queryKey: ['ops-invoices', status],
    queryFn: () => unwrap(api.GET('/ops/invoices', { params: { query: status ? { status } : {} } })),
  });

  async function run(work: () => Promise<unknown>) {
    setError('');
    try {
      await work();
      await invoices.refetch();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const params = (id: string, version: number) => ({ path: { id }, header: { 'If-Match': String(version) } });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{t.ops.invoicesTitle}</h1>
      {error && <Alert>{error}</Alert>}
      <select aria-label={t.ops.anyStatus} value={status} onChange={(e) => setStatus(e.target.value)} className="min-h-9 rounded-lg border border-line bg-white px-2 text-sm">
        <option value="">{t.ops.anyStatus}</option>
        {Object.entries(t.invoices.status).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {invoices.isPending && <Skeleton className="h-48" />}
      {invoices.isError && <ErrorState onRetry={() => invoices.refetch()} />}
      {invoices.data?.data.length === 0 && <Empty>{t.ops.noInvoices}</Empty>}
      {!!invoices.data?.data.length && (
        <DataTable head={t.ops.invoiceHead} min={900}>
          {invoices.data.data.map((i) => (
            <tr key={i.id} className="border-b border-line align-top last:border-0">
              <Cell strong>{i.invoiceNo ?? t.invoices.draftNo}</Cell>
              <Cell>{i.caseNo}</Cell>
              <Cell>{i.partner}</Cell>
              <Cell>{rupees(i.netPaise)}</Cell>
              <Cell><Badge status={i.status} label={t.invoices.status[i.status]} /></Cell>
              <Cell>{i.payoutRef ?? '–'}</Cell>
              <Cell>
                {i.status === 'RAISED' && <Button ghost onClick={() => run(() => unwrap(api.POST('/ops/invoices/{id}/approve', { params: params(i.id, i.version) })))}>{t.ops.approveInvoice}</Button>}
                {i.status === 'APPROVED' && !i.payoutRequestedBy && (
                  <form className="flex gap-2" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const payoutRef = fieldValue(e, 'payoutRef');
                    run(() => unwrap(api.POST('/ops/invoices/{id}/mark-paid', { params: params(i.id, i.version), body: { payoutRef } })));
                  }}>
                    <input name="payoutRef" aria-label={t.ops.payoutRef} placeholder={t.ops.payoutRef} required minLength={3} className="min-h-11 w-36 rounded-lg border border-line px-2 text-sm" />
                    <Button type="submit" ghost>{t.ops.markPaid}</Button>
                  </form>
                )}
                {i.status === 'APPROVED' && i.payoutRequestedBy && (
                  <Button disabled={i.payoutRequestedBy === me?.userId} onClick={() => run(() => unwrap(api.POST('/ops/invoices/{id}/confirm-paid', { params: params(i.id, i.version) })))}>{t.ops.confirmPaid}</Button>
                )}
                {i.status === 'DISPUTED' && (
                  <form className="space-y-2" onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                    const outcome = submitter?.value ?? 'reinstate';
                    const note = fieldValue(e, 'note');
                    run(() => unwrap(api.POST('/ops/invoices/{id}/resolve-dispute', { params: params(i.id, i.version), body: { outcome, note } })));
                  }}>
                    <input name="note" aria-label={t.ops.resolutionNote} placeholder={t.ops.resolutionNote} required minLength={3} className="min-h-11 w-full rounded-lg border border-line px-2 text-sm" />
                    <div className="flex gap-2">
                      <Button type="submit" ghost value="reinstate">{t.ops.reinstate}</Button>
                      <Button type="submit" ghost value="void">{t.ops.voidInvoice}</Button>
                    </div>
                  </form>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
