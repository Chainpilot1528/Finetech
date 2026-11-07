'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap, uploadFile } from '@/shared/api';
import { dateOnly, dateTime, percent, rupees } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, ErrorState, Field, Select, Skeleton, TextArea, fieldValue } from '@/shared/ui';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex justify-between gap-4 border-b border-line py-2 text-sm last:border-0"><dt className="text-muted">{label}</dt><dd className="text-right font-medium">{children}</dd></div>
);

function Reveal({ caseId, field, value }: { caseId: string; field: 'phone' | 'email'; value: string }) {
  const [shown, setShown] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = fieldValue(e, 'reason');
    setError('');
    try {
      const res = await unwrap(api.POST('/cases/{id}/pii-reveal', { params: { path: { id: caseId } }, body: { field, reason } }));
      setShown(res.value);
      setAsking(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  if (shown) return <span data-testid={`revealed-${field}`}>{shown}</span>;
  return (
    <span>
      {value}{' '}
      <button type="button" className="text-brand hover:underline print:hidden" onClick={() => setAsking(!asking)}>{t.cases.reveal}</button>
      {asking && (
        <form onSubmit={submit} className="mt-2 space-y-2 text-left">
          <p className="font-semibold">{t.cases.revealTitle}</p>
          {error && <Alert>{error}</Alert>}
          <Field label={t.cases.revealReason} name="reason" required minLength={5} hint={t.cases.revealHint} />
          <Button type="submit">{t.cases.revealSubmit}</Button>
        </form>
      )}
    </span>
  );
}

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const queries = useQueryClient();
  const key = ['case', id];
  const found = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET('/cases/{id}', { params: { path: { id } } })) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const noteKey = useRef(crypto.randomUUID());
  const c = found.data;
  const can = (x: string) => me?.permissions.includes(x);

  async function run(work: () => Promise<unknown>, form?: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      await work();
      form?.reset();
      await queries.invalidateQueries({ queryKey: key });
      await queries.invalidateQueries({ queryKey: ['cases'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const move = (body: { to: string; note: string; reasonCode?: string }) =>
    unwrap(api.POST('/cases/{id}/transitions', { params: { path: { id }, header: { 'If-Match': String(c!.version) } }, body }));

  if (found.isPending) return <Skeleton className="h-96" />;
  if (found.isError || !c) return <ErrorState onRetry={() => found.refetch()} />;

  const returnTo = c.allowedTransitions.find((s) => s !== 'WITHDRAWN');
  const openDoc = async (docId: string) => {
    const link = await unwrap(api.GET('/cases/{id}/documents/{docId}/url', { params: { path: { id, docId } } }));
    window.open(link.url, '_blank', 'noopener');
  };

  return (
    <div className="space-y-5">
      <div className="print:hidden"><Link href="/app/cases" className="text-sm font-medium text-brand hover:underline">← {t.cases.back}</Link></div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{c.caseNo}</h1>
          <p className="text-sm text-muted">{c.applicant.name} · {c.productName} · {rupees(c.loanAmountPaise)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge status={c.status} label={t.cases.status[c.status]} />
          <Button ghost className="print:hidden" onClick={() => window.print()}>{t.cases.print}</Button>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}

      {c.status === 'RELOOK' && returnTo && (
        <Card title={t.cases.relookTitle} className="border-amber-300 print:hidden">
          <p className="mb-3 text-sm">{c.history.at(-1)?.note}</p>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const note = fieldValue(e, 'note'); run(() => move({ to: returnTo, note }), e.currentTarget); }}>
            <TextArea label={t.cases.responseLabel} name="note" required />
            <Button type="submit" busy={busy}>{t.cases.respond}</Button>
          </form>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
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

          {c.disbursals.length > 0 && (
            <Card title={t.cases.disbursals}>
              <ul className="divide-y divide-line text-sm">
                {c.disbursals.map((d) => (
                  <li key={d.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{t.cases.tranche} {d.trancheNo}{d.isFinal ? ` (${t.cases.final})` : ''} · {d.utr}</span>
                    <span className="font-medium">{rupees(d.amountPaise)} · {dateOnly(d.disbursedOn)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={t.cases.documents}>
            {c.documents.length === 0 && <p className="text-sm text-muted">{t.cases.noDocuments}</p>}
            <ul className="divide-y divide-line text-sm">
              {c.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate">{d.fileName}</span>
                  <button type="button" className="font-medium text-brand hover:underline print:hidden" onClick={() => openDoc(d.id)}>{t.cases.open}</button>
                </li>
              ))}
            </ul>
            {c.canUpload && (
              <label className="mt-3 block text-sm font-medium print:hidden">
                {t.cases.addDocument}
                <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="mt-1 block w-full text-sm" onChange={(e) => {
                  const file = e.target.files?.[0];
                  const input = e.target;
                  if (file) run(() => uploadFile(`/cases/${id}/documents`, file)).finally(() => { input.value = ''; });
                }} />
              </label>
            )}
          </Card>

          <Card title={t.cases.notes}>
            {c.notes.length === 0 && <p className="text-sm text-muted">{t.cases.noNotes}</p>}
            <ul className="space-y-3">
              {c.notes.map((n) => (
                <li key={n.id} className="text-sm"><p>{n.body}</p><p className="text-xs text-muted">{n.author} · {dateTime(n.at)}</p></li>
              ))}
            </ul>
            {can('case.note') && (
              <form className="mt-3 space-y-3 print:hidden" onSubmit={(e) => {
                e.preventDefault();
                const body = fieldValue(e, 'body');
                const form = e.currentTarget;
                run(async () => {
                  await unwrap(api.POST('/cases/{id}/notes', { params: { path: { id }, header: { 'Idempotency-Key': noteKey.current } }, body: { body } }));
                  noteKey.current = crypto.randomUUID();
                }, form);
              }}>
                <TextArea label={t.cases.addNote} name="body" required maxLength={1000} />
                <Button type="submit" busy={busy}>{t.cases.saveNote}</Button>
              </form>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t.cases.summary}>
            <dl>
              <Row label={t.cases.loanType}><span className="capitalize">{c.loanType.replaceAll('_', ' ')}</span></Row>
              <Row label={t.cases.lender}>{c.lender}</Row>
              <Row label={t.cases.amount}>{rupees(c.loanAmountPaise)}</Row>
              <Row label={t.cases.tenure}>{c.tenureMonths} {t.cases.months}</Row>
              {c.sanctionedAmountPaise && <Row label={t.cases.sanctioned}>{rupees(c.sanctionedAmountPaise)}</Row>}
              {c.sanctionedRoiBps && <Row label={t.cases.rate}>{percent(c.sanctionedRoiBps)}</Row>}
              <Row label={t.cases.loggedBy}>{c.loggedBy}</Row>
            </dl>
          </Card>
          <Card title={t.cases.customer}>
            <dl>
              <Row label={t.cases.customer}>{c.applicant.name}</Row>
              <Row label={t.cases.phone}>{c.applicant.masked && can('pii.reveal') ? <Reveal caseId={id} field="phone" value={c.applicant.phone} /> : c.applicant.phone}</Row>
              {c.applicant.email && <Row label={t.cases.email}>{c.applicant.masked && can('pii.reveal') ? <Reveal caseId={id} field="email" value={c.applicant.email} /> : c.applicant.email}</Row>}
              <Row label={t.cases.location}>{c.applicant.city}, {c.applicant.state}</Row>
            </dl>
          </Card>
          {c.allowedTransitions.includes('WITHDRAWN') && (
            <div className="print:hidden">
              {!withdrawing && <Button ghost className="w-full" onClick={() => setWithdrawing(true)}>{t.cases.withdraw}</Button>}
              {withdrawing && (
                <Card title={t.cases.withdrawTitle}>
                  <form className="space-y-3" onSubmit={(e) => {
                    e.preventDefault();
                    const reasonCode = fieldValue(e, 'reasonCode');
                    const note = fieldValue(e, 'note');
                    run(() => move({ to: 'WITHDRAWN', reasonCode, note })).then(() => setWithdrawing(false));
                  }}>
                    <Select label={t.cases.withdrawReason} name="reasonCode" options={Object.entries(t.cases.withdrawReasons).map(([value, label]) => ({ value, label }))} />
                    <TextArea label={t.cases.withdrawNote} name="note" required />
                    <div className="flex gap-2">
                      <Button type="submit" busy={busy}>{t.cases.withdraw}</Button>
                      <Button ghost type="button" onClick={() => setWithdrawing(false)}>{t.cases.cancel}</Button>
                    </div>
                  </form>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
