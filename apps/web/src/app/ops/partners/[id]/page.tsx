'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { BillingReview } from '@/features/billing-review';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, ErrorState, Field, Skeleton } from '@/shared/ui';

export default function OpsPartnerPage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const queries = useQueryClient();
  const partner = useQuery({
    queryKey: ['ops-partner', id],
    queryFn: () => unwrap(api.GET('/ops/partners/{id}', { params: { path: { id } } })),
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  async function run(work: () => Promise<unknown>) {
    setError('');
    try {
      await work();
      await queries.invalidateQueries({ queryKey: ['ops-partner', id] });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const review = (docId: string, decision: 'approved' | 'rejected') =>
    run(() => unwrap(api.POST('/ops/kyc/documents/{id}/review', {
      params: { path: { id: docId } }, body: { decision, note: notes[docId] },
    })));
  const decide = (decision: 'approved' | 'rejected') =>
    run(() => unwrap(api.POST('/ops/partners/{id}/kyc-decision', { params: { path: { id } }, body: { decision } })));
  async function view(docId: string) {
    const { url } = await unwrap(api.GET('/ops/kyc/documents/{id}/url', { params: { path: { id: docId } } }));
    window.location.assign(url);
  }

  if (partner.isPending) return <Skeleton className="h-96" />;
  if (partner.isError) return <ErrorState onRetry={() => partner.refetch()} />;
  const p = partner.data;
  const open = p.kycStatus === 'submitted';

  return (
    <div className="max-w-3xl space-y-5">
      <Link href="/ops" className="text-sm font-medium text-brand hover:underline">{t.ops.back}</Link>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{p.channelName}</h1>
        <p className="text-sm text-muted">{p.legalName} · {p.refCode} · {p.city} · {t.ops.kyc}: {p.kycStatus}</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {!open && <Alert tone="info">{t.ops.waiting}</Alert>}
      <ul className="space-y-3">
        {p.documents.map((d) => (
          <li key={d.id} className="rounded-xl border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{t.kyc.labels[d.type]}</p>
                <p className="text-xs text-muted">{d.fileName} · {d.status}</p>
                {d.reviewerNote && <p className="text-sm text-red-700">{d.reviewerNote}</p>}
              </div>
              <Button ghost onClick={() => view(d.id)}>{t.ops.view}</Button>
            </div>
            {open && (
              <div className="mt-3 space-y-2">
                <Field label={`${t.ops.note}: ${t.kyc.labels[d.type]}`} value={notes[d.id] ?? ''} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} />
                <div className="flex gap-2">
                  <Button onClick={() => review(d.id, 'approved')} aria-label={`${t.ops.approve} ${t.kyc.labels[d.type]}`}>{t.ops.approve}</Button>
                  <Button ghost onClick={() => review(d.id, 'rejected')} aria-label={`${t.ops.reject} ${t.kyc.labels[d.type]}`}>{t.ops.reject}</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {open && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => decide('approved')}>{t.ops.approvePartner}</Button>
          <Button ghost onClick={() => decide('rejected')}>{t.ops.rejectPartner}</Button>
        </div>
      )}
      {me?.permissions.includes('kyc.review') && <BillingReview partnerId={id} />}
    </div>
  );
}
