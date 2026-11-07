'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AuthShell } from '@/features/auth/shell';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, ErrorState, Field, Skeleton, fieldValue } from '@/shared/ui';

export default function TwoStepSetupPage() {
  const router = useRouter();
  const queries = useQueryClient();
  const me = useMe();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setup = useMutation({ mutationFn: () => unwrap(api.POST('/auth/mfa/setup')) });
  const { mutate } = setup;
  const started = useRef(false);

  useEffect(() => {
    if (me.data === null) router.replace('/signin');
    // Once only: a second call would replace the secret the person just scanned.
    if (me.data && !started.current) {
      started.current = true;
      mutate();
    }
  }, [me.data, mutate, router]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = fieldValue(e, 'code');
    setBusy(true);
    setError('');
    try {
      await unwrap(api.POST('/auth/mfa/enable', { body: { code } }));
      await queries.invalidateQueries({ queryKey: ['me'] });
      router.push('/app/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const required = me.data?.mfaState === 'enroll';
  return (
    <AuthShell title={t.mfa.setupTitle} subtitle={required ? t.mfa.setupRequired : t.mfa.setupOptional}>
      {setup.isError && <ErrorState onRetry={() => setup.mutate()} />}
      {!setup.data && !setup.isError && <Skeleton className="h-64" />}
      {setup.data && (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <img src={setup.data.qrDataUrl} alt={t.mfa.qrAlt} width={192} height={192} className="mx-auto rounded-lg border border-line" />
          <div className="text-sm text-muted">
            {t.mfa.manual}
            <code data-testid="mfa-secret" className="mt-1 block break-all rounded bg-white px-2 py-1.5 font-mono text-xs text-ink">{setup.data.secret}</code>
          </div>
          <Field label={t.mfa.code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} name="code" required />
          <Button type="submit" busy={busy} className="w-full">{t.mfa.enable}</Button>
        </form>
      )}
    </AuthShell>
  );
}
