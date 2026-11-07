'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, unwrap } from '@/shared/api';
import { dateTime, percent, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, ErrorState, Skeleton, TextArea, fieldValue } from '@/shared/ui';

const Line = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
  <div className={`flex justify-between gap-4 border-b border-line py-2 text-sm last:border-0 ${strong ? 'font-bold' : ''}`}><span>{label}</span><span>{value}</span></div>
);

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const queries = useQueryClient();
  const found = useQuery({ queryKey: ['invoice', id], queryFn: () => unwrap(api.GET('/invoices/{id}', { params: { path: { id } } })) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const i = found.data;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      setDisputing(false);
      await queries.invalidateQueries({ queryKey: ['invoice', id] });
      await queries.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (found.isPending) return <Skeleton className="h-96" />;
  if (found.isError || !i) return <ErrorState onRetry={() => found.refetch()} />;
  const header = { 'If-Match': String(i.version) };
  const rate = i.rate as { pctBps?: number } | null | undefined;
  const billing = i.billing as Record<string, string> | null | undefined;

  return (
    <div className="max-w-3xl space-y-5">
      <div className="print:hidden"><Link href="/app/invoices" className="text-sm font-medium text-brand hover:underline">← {t.invoices.back}</Link></div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{i.invoiceNo ?? t.invoices.draftNo}</h1>
          <p className="text-sm text-muted">{i.caseNo} · {i.applicant}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge status={i.status} label={t.invoices.status[i.status]} />
          <Button ghost className="print:hidden" onClick={() => window.print()}>{t.invoices.print}</Button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {i.status === 'PENDING_RATE_CARD' && <Alert tone="info">{t.invoices.waitingRate}</Alert>}
      {i.status === 'DRAFT' && !i.canRaise && (
        <Alert tone="info">{t.invoices.raiseBlocked} <Link href="/app/settings" className="font-semibold underline">{t.invoices.goSettings}</Link></Alert>
      )}

      <Card title={t.invoices.lines}>
        <Line label={t.invoices.disbursal} value={rupees(i.disbursalPaise)} />
        {rate?.pctBps && <Line label={t.invoices.rate} value={percent(rate.pctBps)} />}
        <Line label={t.invoices.gross} value={rupees(i.grossPaise)} />
        <Line label={t.invoices.gst} value={rupees(i.gstPaise)} />
        <Line label={t.invoices.tds} value={`− ${rupees(i.tdsPaise)}`} />
        <Line label={t.invoices.net} value={rupees(i.netPaise)} strong />
        {i.recoveredPaise > 0 && <Line label={t.invoices.recovered} value={`− ${rupees(i.recoveredPaise)}`} />}
      </Card>

      {billing && (
        <Card title={t.invoices.billing}>
          <p className="text-sm font-medium">{billing.legalName}</p>
          {billing.gstin && <p className="text-sm">GSTIN {billing.gstin}</p>}
          <p className="text-sm">{t.invoices.sac} {billing.sacCode}</p>
          <p className="text-sm text-muted">{billing.bankName}, {billing.branch} · {t.invoices.account} {billing.bankLast4}</p>
        </Card>
      )}

      <Card title={t.invoices.timeline}>
        <ol className="space-y-3">
          {i.events.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3 text-sm">
              <p className="font-medium">{t.invoices.status[e.toStatus] ?? e.toStatus}</p>
              <p className="text-xs text-muted">{e.actor} · {dateTime(e.at)}</p>
              {e.note && <p className="mt-1">{e.note}</p>}
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex flex-wrap gap-2 print:hidden">
        {i.status === 'DRAFT' && (
          <Button busy={busy} disabled={!i.canRaise} onClick={() => run(() => unwrap(api.POST('/invoices/{id}/raise', { params: { path: { id }, header } })))}>{t.invoices.raise}</Button>
        )}
        {['RAISED', 'APPROVED'].includes(i.status) && !disputing && <Button ghost onClick={() => setDisputing(true)}>{t.invoices.dispute}</Button>}
      </div>
      {disputing && (
        <Card>
          <form className="space-y-3" onSubmit={(e) => {
            e.preventDefault();
            const note = fieldValue(e, 'note');
            run(() => unwrap(api.POST('/invoices/{id}/dispute', { params: { path: { id }, header }, body: { note } })));
          }}>
            <TextArea label={t.invoices.disputeNote} name="note" required minLength={3} />
            <div className="flex gap-2">
              <Button type="submit" busy={busy}>{t.invoices.send}</Button>
              <Button ghost type="button" onClick={() => setDisputing(false)}>{t.invoices.cancel}</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
