'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Logo, Skeleton } from '@/shared/ui';

interface ConsentPage { partnerName: string; lenderName: string; text: string; given: boolean }

/** The customer's own page. It shows nothing about them, so a forwarded link reveals nothing. */
export default function ConsentPageView() {
  const { token } = useParams<{ token: string }>();
  const page = useQuery({
    queryKey: ['consent', token],
    queryFn: () => unwrap(api.GET('/public/consent/{token}', { params: { path: { token } } })) as Promise<unknown> as Promise<ConsentPage>,
  });
  const agree = useMutation({ mutationFn: () => unwrap(api.POST('/public/consent/{token}', { params: { path: { token } } })) });

  return (
    <main className="mx-auto max-w-md space-y-5 px-4 py-10">
      <Logo />
      <h1 className="text-2xl font-bold tracking-tight">{t.consent.title}</h1>
      {page.isPending && <Skeleton className="h-48" />}
      {page.isError && <Alert>{t.consent.expired}</Alert>}
      {page.data && (
        page.data.given || agree.isSuccess ? (
          <Alert tone="success">{t.consent.done}</Alert>
        ) : (
          <>
            <p className="text-sm"><strong>{page.data.partnerName}</strong> {t.consent.intro} <strong>{page.data.lenderName}</strong>.</p>
            <p className="rounded-xl border border-line bg-white p-4 text-sm leading-relaxed">{page.data.text}</p>
            {agree.isError && <Alert>{agree.error.message}</Alert>}
            <Button className="w-full" busy={agree.isPending} onClick={() => agree.mutate()}>{t.consent.agree}</Button>
            <p className="text-xs text-muted">{t.consent.grievance}</p>
          </>
        )
      )}
    </main>
  );
}
