'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { dateOnly, dateTime, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, ErrorState, Field, Select, Skeleton, TextArea, fieldValue } from '@/shared/ui';

export default function OpsCasePage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const queries = useQueryClient();
  const key = ['ops-case', id];
  const found = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET('/ops/cases/{id}', { params: { path: { id } } })) });
  const canAssign = me?.permissions.includes('ops.assign');
  const canWork = me?.permissions.includes('ops.cases');
  const canFinance = me?.permissions.includes('finance.manage');
  const staff = useQuery({ queryKey: ['ops-staff'], enabled: !!canAssign, queryFn: () => unwrap(api.GET('/ops/staff')) });
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const c = found.data;

  async function run(work: () => Promise<unknown>, form?: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      await work();
      form?.reset();
      await queries.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (found.isPending) return <Skeleton className="h-96" />;
  if (found.isError || !c) return <ErrorState onRetry={() => found.refetch()} />;
  const header = { 'If-Match': String(c.version) };

  function move(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (k: string) => String(data.get(k) ?? '').trim();
    const body: Record<string, unknown> = { to };
    if (text('note')) body.note = text('note');
    if (text('reasonCode')) body.reasonCode = text('reasonCode');
    if (to === 'IN_REVIEW') body.lenderId = text('lenderId');
    if (to === 'APPROVED') Object.assign(body, { sanctionedAmount: Number(text('sanctionedAmount')), roiBps: Math.round(Number(text('roi')) * 100), tenureMonths: Number(text('tenureMonths')) });
    if (to === 'DISBURSAL_IN_PROGRESS') body.checklistComplete = data.has('checklist');
    const form = e.currentTarget;
    run(async () => {
      await unwrap(api.POST('/ops/cases/{id}/transitions', { params: { path: { id }, header }, body }));
      setTo('');
    }, form);
  }

  function disburse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const body = { utr: fieldValue(e, 'utr'), amount: Number(fieldValue(e, 'amount')), disbursedOn: fieldValue(e, 'disbursedOn'), isFinal: data.has('isFinal') };
    const form = e.currentTarget;
    run(() => unwrap(api.POST('/ops/cases/{id}/disbursals', { params: { path: { id }, header }, body })), form);
  }

  const openDoc = async (docId: string) => {
    const link = await unwrap(api.GET('/ops/cases/{id}/documents/{docId}/url', { params: { path: { id, docId } } }));
    window.open(link.url, '_blank', 'noopener');
  };
  const pendingReversal = c.reversal?.status === 'pending';

  return (
    <div className="space-y-5">
      <Link href="/ops/cases" className="text-sm font-medium text-brand hover:underline">← {t.ops.backCases}</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{c.caseNo}</h1>
          <p className="text-sm text-muted">{c.partner} · {c.productName} · {rupees(c.loanAmountPaise)} · {c.tenureMonths} {t.cases.months}</p>
        </div>
        <Badge status={c.status} label={t.cases.status[c.status]} />
      </div>
      {error && <Alert>{error}</Alert>}
      {c.possibleDuplicate && <Alert tone="info">{t.ops.duplicate}</Alert>}
      <p className="text-xs text-muted">{t.ops.identityHidden} {c.location.city}, {c.location.state} {c.location.pincode}</p>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {canWork && c.allowedTransitions.length > 0 && (
            <Card title={t.ops.move}>
              <form onSubmit={move} className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Select label={t.ops.moveTo} value={to} onChange={(e) => setTo(e.target.value)} placeholder="" options={c.allowedTransitions.map((s) => ({ value: s, label: t.cases.status[s] ?? s }))} />
                </div>
                {to === 'IN_REVIEW' && <Select label={t.ops.lender} name="lenderId" defaultValue={c.lenderId} options={c.lenders.map((l) => ({ value: l.id, label: l.name }))} />}
                {to === 'APPROVED' && (
                  <>
                    <Field label={t.ops.sanctionedAmount} name="sanctionedAmount" type="number" min={1} required defaultValue={c.loanAmountPaise / 100} />
                    <Field label={t.ops.roi} name="roi" type="number" step="0.01" min={0.01} required />
                    <Field label={t.ops.tenure} name="tenureMonths" type="number" min={1} required defaultValue={c.tenureMonths} />
                  </>
                )}
                {to === 'DISBURSAL_IN_PROGRESS' && <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2"><input type="checkbox" name="checklist" /> {t.ops.checklist}</label>}
                {(to === 'REJECTED' || to === 'WITHDRAWN') && <Field label={t.ops.reasonCode} name="reasonCode" required />}
                {to && <div className="sm:col-span-2"><TextArea label={t.ops.moveNote} name="note" required={['RELOOK', 'REJECTED', 'WITHDRAWN'].includes(to)} /></div>}
                {to && <div className="sm:col-span-2"><Button type="submit" busy={busy}>{t.ops.apply}</Button></div>}
              </form>
            </Card>
          )}

          {canWork && c.status === 'DISBURSAL_IN_PROGRESS' && (
            <Card title={t.ops.disbursal}>
              <form onSubmit={disburse} className="grid gap-3 sm:grid-cols-3">
                <Field label={t.ops.utr} name="utr" required pattern="[A-Za-z0-9]{12,22}" />
                <Field label={t.ops.amount} name="amount" type="number" min={1} required />
                <Field label={t.ops.date} name="disbursedOn" type="date" required />
                <label className="flex items-center gap-2 text-sm font-medium sm:col-span-3"><input type="checkbox" name="isFinal" /> {t.ops.finalTranche}</label>
                <div className="sm:col-span-3"><Button type="submit" busy={busy}>{t.ops.record}</Button></div>
              </form>
            </Card>
          )}

          {c.status === 'DISBURSED' && (canWork || canFinance) && (
            <Card title={t.ops.reversal}>
              {pendingReversal ? (
                <div className="space-y-3">
                  <Alert tone="info">{t.ops.reversalWaiting}: {c.reversal?.reasonCode}, {c.reversal?.reference}</Alert>
                  {canFinance && (
                    <div className="flex gap-2">
                      <Button busy={busy} onClick={() => run(() => unwrap(api.POST('/ops/cases/{id}/reversal/decision', { params: { path: { id } }, body: { decision: 'approved' } })))}>{t.ops.approveReversal}</Button>
                      <Button ghost onClick={() => run(() => unwrap(api.POST('/ops/cases/{id}/reversal/decision', { params: { path: { id } }, body: { decision: 'rejected' } })))}>{t.ops.rejectReversal}</Button>
                    </div>
                  )}
                </div>
              ) : canWork && (
                <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
                  e.preventDefault();
                  const body = { reasonCode: fieldValue(e, 'reasonCode'), reference: fieldValue(e, 'reference') };
                  run(() => unwrap(api.POST('/ops/cases/{id}/reversal', { params: { path: { id }, header }, body })), e.currentTarget);
                }}>
                  <Field label={t.ops.reversalReason} name="reasonCode" required />
                  <Field label={t.ops.reversalRef} name="reference" required />
                  <div className="sm:col-span-2"><Button type="submit" ghost busy={busy}>{t.ops.requestReversal}</Button></div>
                </form>
              )}
            </Card>
          )}

          <Card title={t.cases.timeline}>
            <ol className="space-y-3">
              {c.history.map((h) => (
                <li key={h.id} className="border-l-2 border-line pl-3 text-sm">
                  <p className="font-medium">{t.cases.status[h.toStatus] ?? h.toStatus}</p>
                  <p className="text-xs text-muted">{h.actor} · {dateTime(h.at)}</p>
                  {h.note && <p className="mt-1">{h.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t.ops.assignee}>
            <p className="text-sm">{c.assignee ?? t.ops.nobody}</p>
            {canWork && !c.assignee && <Button ghost className="mt-2" busy={busy} onClick={() => run(() => unwrap(api.POST('/ops/cases/{id}/take', { params: { path: { id } } })))}>{t.ops.take}</Button>}
            {canAssign && !!staff.data?.data.length && (
              <form className="mt-3 space-y-2" onSubmit={(e) => {
                e.preventDefault();
                const userId = fieldValue(e, 'userId');
                run(() => unwrap(api.POST('/ops/cases/{id}/assign', { params: { path: { id } }, body: { userId } })));
              }}>
                <Select label={t.ops.assignTo} name="userId" options={staff.data.data.map((s) => ({ value: s.id, label: s.name }))} />
                <Button type="submit" ghost busy={busy}>{t.ops.assign}</Button>
              </form>
            )}
          </Card>
          <Card title={t.cases.documents}>
            <ul className="divide-y divide-line text-sm">
              {c.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate">{d.docType}</span>
                  {canWork && <button type="button" className="font-medium text-brand hover:underline" onClick={() => openDoc(d.id)}>{t.cases.open}</button>}
                </li>
              ))}
            </ul>
          </Card>
          {c.disbursals.length > 0 && (
            <Card title={t.cases.disbursals}>
              <ul className="divide-y divide-line text-sm">
                {c.disbursals.map((d) => <li key={d.id} className="py-2">{t.cases.tranche} {d.trancheNo}: {rupees(d.amountPaise)} · {dateOnly(d.disbursedOn)}</li>)}
              </ul>
            </Card>
          )}
          {c.notes.length > 0 && (
            <Card title={t.cases.notes}>
              <ul className="space-y-2 text-sm">{c.notes.map((n) => <li key={n.id}>{n.body}<span className="block text-xs text-muted">{n.author}</span></li>)}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
