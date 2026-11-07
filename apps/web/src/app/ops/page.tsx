'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Button, ErrorState, Skeleton } from '@/shared/ui';

export default function OpsQueuePage() {
  const [all, setAll] = useState(false);
  const partners = useQuery({
    queryKey: ['ops-partners', all],
    queryFn: () => unwrap(api.GET('/ops/partners', { params: { query: all ? {} : { kycStatus: 'submitted' } } })),
  });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{all ? t.ops.all : t.ops.queue}</h1>
        <Button ghost onClick={() => setAll(!all)}>{all ? t.ops.queue : t.ops.all}</Button>
      </div>
      {partners.isPending && <Skeleton className="h-48" />}
      {partners.isError && <ErrorState onRetry={() => partners.refetch()} />}
      {partners.data?.data.length === 0 && <p className="rounded-xl border border-dashed border-line bg-white p-10 text-center text-sm text-muted">{t.ops.empty}</p>}
      {!!partners.data?.data.length && (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase text-muted">
              <tr>{[t.ops.partner, t.ops.reference, t.ops.city, t.ops.kyc, ''].map((h) => <th key={h} scope="col" className="px-4 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {partners.data.data.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">{p.channelName}</td>
                  <td className="px-4 py-3">{p.refCode}</td>
                  <td className="px-4 py-3">{p.city}</td>
                  <td className="px-4 py-3">{p.kycStatus}</td>
                  <td className="px-4 py-3"><Link className="font-medium text-brand hover:underline" href={`/ops/partners/${p.id}`}>{t.ops.open}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
