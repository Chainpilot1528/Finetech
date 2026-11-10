'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { Wizard } from '@/features/cases/wizard';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, ErrorState, Skeleton } from '@/shared/ui';

const w = t.wizard;

export default function CreateCasePage() {
  const { data: me } = useMe();
  const approved = me?.partner?.kycStatus === 'approved';
  const [draftId, setDraftId] = useState('');
  const [created, setCreated] = useState<{ id: string; caseNo: string }>();
  const drafts = useQuery({ queryKey: ['drafts'], enabled: approved, queryFn: () => unwrap(api.GET('/cases/drafts')) });
  const start = useMutation({
    mutationFn: () => unwrap(api.POST('/cases/drafts', { params: { header: { 'Idempotency-Key': crypto.randomUUID() } } })),
    onSuccess: (d) => setDraftId(d.id),
  });

  if (!me) return <Skeleton className="h-64" />;
  if (!approved) {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <Alert tone="info">{w.needsKyc}</Alert>
        {me.permissions.includes('kyc.manage') && <Link className="font-medium text-brand hover:underline" href="/app/kyc">{w.goKyc}</Link>}
      </div>
    );
  }
  if (created) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-line bg-white p-8 text-center">
        <h1 className="text-xl font-bold">{w.doneTitle}</h1>
        <p className="mt-3 font-mono text-lg" data-testid="case-no">{created.caseNo}</p>
        <p className="mt-2 text-sm text-muted">{w.doneBody}</p>
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={() => { setCreated(undefined); setDraftId(''); void drafts.refetch(); }}>{w.another}</Button>
          <Link className="text-sm font-medium text-brand hover:underline" href={`/app/cases/${created.id}`}>{w.viewCase}</Link>
          <Link className="text-sm font-medium text-brand hover:underline" href="/app/dashboard">{w.dashboard}</Link>
        </div>
      </div>
    );
  }
  if (draftId) return <Wizard key={draftId} draftId={draftId} onDone={setCreated} />;
  if (drafts.isPending) return <Skeleton className="h-64" />;
  if (drafts.isError) return <ErrorState onRetry={() => drafts.refetch()} />;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{w.title}</h1>
      {start.isError && <Alert>{start.error.message}</Alert>}
      <Button busy={start.isPending} onClick={() => start.mutate()}>{w.startNew}</Button>
      {!!drafts.data.data.length && (
        <section className="rounded-xl border border-line bg-white p-5">
          <h2 className="font-semibold">{w.resumeTitle}</h2>
          <ul className="mt-2 divide-y divide-line">
            {drafts.data.data.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2 text-sm">
                <span>{d.product ?? w.steps[0]} · {new Date(d.updatedAt ?? '').toLocaleDateString('en-IN')}</span>
                <Button ghost onClick={() => setDraftId(d.id)}>{w.resume}</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
