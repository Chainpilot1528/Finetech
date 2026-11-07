'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/features/auth/shell';
import { ApiError, api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

export default function TwoStepPage() {
  const router = useRouter();
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = fieldValue(e, 'code');
    setBusy(true);
    setError('');
    try {
      await unwrap(api.POST('/auth/mfa/verify', { body: { code } }));
      await queries.invalidateQueries({ queryKey: ['me'] });
      router.push('/app/dashboard');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_REQUIRED') return router.push('/signin');
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function emailCode() {
    setError('');
    try {
      await unwrap(api.POST('/auth/mfa/email-otp'));
      setNote(t.mfa.emailSent);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <AuthShell title={t.mfa.verifyTitle} subtitle={t.mfa.verifySubtitle}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {note && <Alert tone="success">{note}</Alert>}
        <Field label={t.mfa.code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} name="code" required />
        <Button type="submit" busy={busy} className="w-full">{t.mfa.submit}</Button>
        <Button type="button" ghost className="w-full" onClick={emailCode}>{t.mfa.emailInstead}</Button>
      </form>
    </AuthShell>
  );
}
