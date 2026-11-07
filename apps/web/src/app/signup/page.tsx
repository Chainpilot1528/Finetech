'use client';

import { REGISTRATION_PRODUCTS } from '@vittora/product-schemas';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/features/auth/shell';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, Select, fieldValue } from '@/shared/ui';

const BANDS = ['1-5', '6-10', '11-25', '26-50', '51-100', '100+'].map((b) => ({ value: b, label: b }));

export default function SignUpPage() {
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const products = new FormData(e.currentTarget).getAll('products').map(String);
    if (!products.length) return setError(t.signUp.pickProduct);
    const v = (name: string) => fieldValue(e, name);
    const optional = (name: string) => v(name) || undefined;
    setBusy(true);
    setError('');
    try {
      await unwrap(api.POST('/partners/register', {
        body: {
          channelName: v('channelName'), legalName: v('legalName'), city: v('city'), pincode: v('pincode'),
          businessEmail: v('businessEmail'), businessPhone: optional('businessPhone'), products,
          employeeBand: v('employeeBand'), adminName: v('adminName'), adminEmail: v('adminEmail'),
          adminPhone: optional('adminPhone'),
        },
      }));
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t.signUp.title} subtitle={t.signUp.subtitle}>
      {done ? (
        <Alert tone="success">{t.signUp.done}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-6">
          {error && <Alert>{error}</Alert>}
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-muted">{t.signUp.company}</legend>
            <Field label={t.signUp.channel} name="channelName" required />
            <Field label={t.signUp.legal} name="legalName" required />
            <Field label={t.signUp.city} name="city" required />
            <Field label={t.signUp.pincode} name="pincode" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} required />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-muted">{t.signUp.contact}</legend>
            <Field label={t.signUp.businessEmail} name="businessEmail" type="email" required />
            <Field label={t.signUp.businessPhone} name="businessPhone" inputMode="numeric" pattern="[6-9][0-9]{9}" maxLength={10} />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-muted">{t.signUp.business}</legend>
            <div>
              <p className="mb-2 text-sm font-medium">{t.signUp.products}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {REGISTRATION_PRODUCTS.map((p) => (
                  <label key={p.code} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="products" value={p.code} className="size-4 accent-brand" />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
            <Select label={t.signUp.team} name="employeeBand" options={BANDS} required />
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-semibold text-muted">{t.signUp.admin}</legend>
            <Field label={t.signUp.adminName} name="adminName" required />
            <Field label={t.signUp.adminEmail} name="adminEmail" type="email" hint={t.signUp.adminEmailHint} required />
            <Field label={t.signUp.adminPhone} name="adminPhone" inputMode="numeric" pattern="[6-9][0-9]{9}" maxLength={10} />
          </fieldset>
          <Button type="submit" busy={busy} className="w-full">{t.signUp.submit}</Button>
        </form>
      )}
      <p className="mt-4 text-center text-sm"><Link className="font-medium text-brand hover:underline" href="/signin">{t.common.backToSignIn}</Link></p>
    </AuthShell>
  );
}
