'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { nextStep } from '@/features/auth/use-me';
import { AuthShell } from '@/features/auth/shell';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

export default function OpsSignInPage() {
  const router = useRouter();
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = { email: fieldValue(e, 'email'), password: fieldValue(e, 'password') };
    setBusy(true);
    setError('');
    try {
      const { mfaState } = await unwrap(api.POST('/ops/auth/login', { body }));
      queries.removeQueries({ queryKey: ['me'] }); // the cached answer still says signed out
      router.push(nextStep(mfaState));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t.ops.signInTitle} subtitle={t.ops.signInSubtitle}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={t.signIn.email} name="email" type="email" autoComplete="username" required />
        <Field label={t.signIn.password} name="password" type="password" autoComplete="current-password" required />
        <Button type="submit" busy={busy} className="w-full">{t.signIn.submit}</Button>
      </form>
    </AuthShell>
  );
}
