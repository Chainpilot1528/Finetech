'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, Logo, Skeleton } from '@/shared/ui';

interface ConsentPage { partnerName: string; lenderName: string; text: string; given: boolean }

/**
 * The customer's own page. It shows nothing about them, so a forwarded link reveals nothing, and
 * consent needs a one-time code sent to the customer's phone (SEC-01).
 */
export default function ConsentPageView() {
  const { token } = useParams<{ token: string }>();
  const [code, setCode] = useState('');
  const page = useQuery({
    queryKey: ['consent', token],
    queryFn: () => unwrap(api.GET('/public/consent/{token}', { params: { path: { token } } })) as Promise<unknown> as Promise<ConsentPage>,
  });
  const send = useMutation({ mutationFn: () => unwrap(api.POST('/public/consent/{token}/code', { params: { path: { token } } })) });
  const agree = useMutation({
    mutationFn: () => unwrap(api.POST('/public/consent/{token}', { params: { path: { token } }, body: { code } })),
  });
  const codeError = agree.error instanceof ApiError ? agree.error.fields.code ?? agree.error.message : agree.error?.message;

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
            {send.isError && <Alert>{send.error.message}</Alert>}
            {!send.isSuccess ? (
              <>
                <p className="text-sm text-muted">{t.consent.codeIntro}</p>
                <Button className="w-full" busy={send.isPending} onClick={() => send.mutate()}>{t.consent.sendCode}</Button>
              </>
            ) : (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); agree.mutate(); }}>
                <Alert tone="success">{t.consent.codeSent}</Alert>
                <Field label={t.consent.codeLabel} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} error={codeError} />
                <Button type="submit" className="w-full" busy={agree.isPending} disabled={code.length !== 6}>{t.consent.agree}</Button>
                <button type="button" className="text-sm text-brand underline" onClick={() => { setCode(''); agree.reset(); send.mutate(); }}>{t.consent.resendCode}</button>
              </form>
            )}
            <p className="text-xs text-muted">{t.consent.grievance}</p>
          </>
        )
      )}
    </main>
  );
}
