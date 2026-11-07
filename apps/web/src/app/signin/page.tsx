'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { nextStep } from '@/features/auth/use-me';
import { AuthShell } from '@/features/auth/shell';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = fieldValue(e, 'email');
    const password = fieldValue(e, 'password');
    setBusy(true);
    setError('');
    try {
      const { mfaState } = await unwrap(api.POST('/auth/login', { body: { email, password } }));
      router.push(nextStep(mfaState));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t.signIn.title} subtitle={t.signIn.subtitle}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={t.signIn.email} type="email" autoComplete="username" name="email" required />
        <Field label={t.signIn.password} type="password" autoComplete="current-password" name="password" required />
        <Button type="submit" busy={busy} className="w-full">{t.signIn.submit}</Button>
        <p className="text-center text-sm"><Link className="font-medium text-brand underline-offset-2 hover:underline" href="/forgot-password">{t.signIn.forgot}</Link></p>
      </form>
    </AuthShell>
  );
}
