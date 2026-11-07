'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/features/auth/shell';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = fieldValue(e, 'email');
    setBusy(true);
    setError('');
    try {
      await unwrap(api.POST('/auth/password/forgot', { body: { email } }));
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t.forgot.title} subtitle={t.forgot.subtitle}>
      {sent ? (
        <Alert tone="success">{t.forgot.sent}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t.signIn.email} type="email" autoComplete="username" name="email" required />
          <Button type="submit" busy={busy} className="w-full">{t.forgot.submit}</Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm"><Link className="font-medium text-brand hover:underline" href="/signin">{t.common.backToSignIn}</Link></p>
    </AuthShell>
  );
}
