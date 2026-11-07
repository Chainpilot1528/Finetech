'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useState } from 'react';
import { AuthShell } from '@/features/auth/shell';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = fieldValue(e, 'password');
    if (password !== fieldValue(e, 'confirm')) return setError(t.reset.mismatch);
    setBusy(true);
    setError('');
    try {
      await unwrap(api.POST('/auth/password/reset', { body: { token, password } }));
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Alert tone="success">{t.reset.done}</Alert>;
  if (!token) return <Alert>{t.reset.missing}</Alert>;
  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <Field label={t.reset.password} type="password" autoComplete="new-password" name="password" required />
      <Field label={t.reset.confirm} type="password" autoComplete="new-password" name="confirm" required />
      <Button type="submit" busy={busy} className="w-full">{t.reset.submit}</Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell title={t.reset.title} subtitle={t.reset.subtitle}>
      <Suspense><ResetForm /></Suspense>
      <p className="mt-4 text-center text-sm"><Link className="font-medium text-brand hover:underline" href="/signin">{t.common.backToSignIn}</Link></p>
    </AuthShell>
  );
}
