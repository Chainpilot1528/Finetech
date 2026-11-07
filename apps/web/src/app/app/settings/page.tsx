'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, fieldValue } from '@/shared/ui';

export default function SettingsPage() {
  const { data } = useMe();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const currentPassword = fieldValue(e, 'currentPassword');
    const newPassword = fieldValue(e, 'newPassword');
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await unwrap(api.POST('/auth/password/change', { body: { currentPassword, newPassword } }));
      setSaved(true);
      form.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOutAll() {
    await api.POST('/auth/sessions/revoke-all');
    window.location.assign('/signin');
  }

  const twoStepOn = data?.mfaEnabled;
  return (
    <div className="max-w-xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>
      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="font-semibold">{t.settings.company}</h2>
        <p className="mt-2 text-sm">{data?.partner?.legalName}</p>
        <p className="text-sm text-muted">{t.settings.reference}: {data?.partner?.refCode}</p>
      </section>
      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="font-semibold">{t.settings.changePassword}</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          {error && <Alert>{error}</Alert>}
          {saved && <Alert tone="success">{t.settings.saved}</Alert>}
          <Field label={t.settings.currentPassword} type="password" autoComplete="current-password" name="currentPassword" required />
          <Field label={t.settings.newPassword} type="password" autoComplete="new-password" name="newPassword" required />
          <Button type="submit" busy={busy}>{t.settings.save}</Button>
        </form>
      </section>
      <section className="space-y-3 rounded-xl border border-line bg-white p-5">
        <h2 className="font-semibold">{t.settings.security}</h2>
        <p className="text-sm text-muted">{twoStepOn ? t.settings.twoStepOn : t.settings.twoStepOff}</p>
        {!twoStepOn && <Link className="block text-sm font-medium text-brand hover:underline" href="/two-step/setup">{t.settings.turnOn}</Link>}
        <Button ghost onClick={signOutAll}>{t.settings.signOutAll}</Button>
      </section>
    </div>
  );
}
