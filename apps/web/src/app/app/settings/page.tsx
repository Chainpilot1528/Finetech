'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { dateOnly, dateTime } from '@/shared/format';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, ErrorState, Field, Select, Skeleton, fieldValue } from '@/shared/ui';

const BANDS = ['1-5', '6-10', '11-25', '26-50', '51-100', '100+'].map((v) => ({ value: v, label: v }));
const Fact = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between gap-4 border-b border-line py-2 text-sm last:border-0"><span className="text-muted">{label}</span><span className="text-right font-medium">{value}</span></div>
);

const loadCompany = () => unwrap(api.GET('/partner'));
type BillingView = NonNullable<Awaited<ReturnType<typeof loadCompany>>['billing']>;

function useSave() {
  const queries = useQueryClient();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await work();
      setSaved(true);
      await queries.invalidateQueries({ queryKey: ['company'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { error, saved, busy, save };
}

function Notice({ error, saved, text = t.settings.changesSaved }: { error: string; saved: boolean; text?: string }) {
  return <>{error && <Alert>{error}</Alert>}{saved && <Alert tone="success">{text}</Alert>}</>;
}

function Company({ canEdit }: { canEdit: boolean }) {
  const company = useQuery({ queryKey: ['company'], queryFn: loadCompany });
  const s = useSave();
  const c = company.data;
  if (company.isPending) return <Skeleton className="h-64" />;
  if (company.isError || !c) return <ErrorState onRetry={() => company.refetch()} />;

  function saveCompany(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const phone = fieldValue(e, 'businessPhone');
    const body = {
      city: fieldValue(e, 'city'), pincode: fieldValue(e, 'pincode'), employeeBand: fieldValue(e, 'employeeBand'),
      businessEmail: fieldValue(e, 'businessEmail'), businessPhone: phone || null,
    };
    s.save(() => unwrap(api.PATCH('/partner', { body })));
  }

  return (
    <>
      <Card title={t.settings.companyInfo}>
        <Fact label={t.settings.reference} value={c.refCode} />
        <Fact label={t.settings.channel} value={c.channelName} />
        <Fact label={t.settings.legal} value={c.legalName} />
        <Fact label={t.settings.products} value={c.products.map((p) => p.name).join(', ')} />
        <p className="mt-2 text-xs text-muted">{t.settings.lockedHint} {t.settings.productsHint}</p>
        <form onSubmit={saveCompany} className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Notice error={s.error} saved={s.saved} /></div>
          <fieldset disabled={!canEdit} className="contents">
            <Field label={t.settings.city} name="city" defaultValue={c.city} required />
            <Field label={t.settings.pincode} name="pincode" defaultValue={c.pincode} required pattern="[1-9][0-9]{5}" />
            <Select label={t.settings.employees} name="employeeBand" defaultValue={c.employeeBand ?? '1-5'} options={BANDS} />
            <Field label={t.settings.businessEmail} name="businessEmail" type="email" defaultValue={c.businessEmail ?? ''} required />
            <Field label={t.settings.businessPhone} name="businessPhone" defaultValue={c.businessPhone ?? ''} pattern="[6-9][0-9]{9}" />
          </fieldset>
          {canEdit && <div className="sm:col-span-2"><Button type="submit" busy={s.busy}>{t.settings.saveChanges}</Button></div>}
        </form>
      </Card>
      <Card title={t.settings.admins}>
        {c.admins.map((a) => <Fact key={a.email} label={a.name} value={a.email} />)}
      </Card>
      <Billing billing={c.billing ?? null} canEdit={canEdit} />
      <Privacy masked={c.maskCustomerContact} canEdit={canEdit} />
      <Card title={t.settings.account}>
        <Fact label={t.settings.accountStatus} value={<Badge status={c.status} label={c.status} />} />
        <Fact label={t.settings.registered} value={dateOnly(c.registeredAt)} />
        <Fact label={t.settings.lastLogin} value={c.lastLoginAt ? dateTime(c.lastLoginAt) : '–'} />
      </Card>
    </>
  );
}

function Billing({ billing, canEdit }: { billing: BillingView | null; canEdit: boolean }) {
  const s = useSave();
  const [registered, setRegistered] = useState(billing?.gstRegistered ?? false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {
      gstRegistered: registered, ...(registered ? { gstin: fieldValue(e, 'gstin') } : {}), pan: fieldValue(e, 'pan'),
      bankAccount: fieldValue(e, 'bankAccount'), ifsc: fieldValue(e, 'ifsc'), bankName: fieldValue(e, 'bankName'), branch: fieldValue(e, 'branch'),
    };
    s.save(async () => {
      await unwrap(api.PATCH('/partner/billing', { body }));
      form.reset();
    });
  }

  return (
    <Card title={t.settings.billing}>
      {billing && (
        <div className="mb-4">
          <Fact label={t.ops.kyc} value={<Badge status={billing.verificationStatus} label={t.settings.verification[billing.verificationStatus]} />} />
          <Fact label={t.settings.onFile} value={`PAN ••••${billing.panLast4} · A/c ••••${billing.bankLast4}`} />
          {billing.reviewerNote && <Alert tone="info">{billing.reviewerNote}</Alert>}
        </div>
      )}
      {canEdit && (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Notice error={s.error} saved={s.saved} /></div>
          <label className="flex items-center gap-2 text-sm font-medium sm:col-span-2">
            <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} /> {t.settings.gstRegistered}
          </label>
          {registered && <Field label={t.settings.gstin} name="gstin" required defaultValue={billing?.gstin ?? ''} />}
          <Field label={t.settings.pan} name="pan" required autoComplete="off" />
          <Field label={t.settings.bankAccount} name="bankAccount" required autoComplete="off" inputMode="numeric" />
          <Field label={t.settings.ifsc} name="ifsc" required defaultValue={billing?.ifsc ?? ''} />
          <Field label={t.settings.bankName} name="bankName" required defaultValue={billing?.bankName ?? ''} />
          <Field label={t.settings.branch} name="branch" required defaultValue={billing?.branch ?? ''} />
          <p className="text-xs text-muted sm:col-span-2">{t.settings.billingHint}</p>
          <div className="sm:col-span-2"><Button type="submit" busy={s.busy}>{t.settings.saveBilling}</Button></div>
        </form>
      )}
    </Card>
  );
}

function Privacy({ masked, canEdit }: { masked: boolean; canEdit: boolean }) {
  const s = useSave();
  return (
    <Card title={t.settings.privacy}>
      <Notice error={s.error} saved={s.saved} />
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={masked} disabled={!canEdit || s.busy}
          onChange={(e) => { const maskCustomerContact = e.target.checked; s.save(() => unwrap(api.PATCH('/partner', { body: { maskCustomerContact } }))); }} />
        {t.settings.maskLabel}
      </label>
      <p className="mt-2 text-xs text-muted">{t.settings.privacyHint}</p>
    </Card>
  );
}

function Notifications() {
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => unwrap(api.GET('/partner/notification-prefs')) });
  const s = useSave();
  if (!prefs.data) return <Skeleton className="h-40" />;
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const next = Object.fromEntries(Object.keys(t.settings.events).map((k) => [k, { email: data.has(`${k}.email`), inApp: data.has(`${k}.inApp`) }]));
    s.save(() => unwrap(api.PATCH('/partner/notification-prefs', { body: { prefs: next } })));
  }
  return (
    <Card title={t.settings.notifications}>
      <form onSubmit={submit} className="space-y-3">
        <Notice error={s.error} saved={s.saved} />
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted"><tr><th scope="col" /><th scope="col" className="w-16 py-1">{t.settings.emailChannel}</th><th scope="col" className="w-16 py-1">{t.settings.appChannel}</th></tr></thead>
          <tbody>
            {Object.entries(t.settings.events).map(([key, label]) => (
              <tr key={key} className="border-t border-line">
                <th scope="row" className="py-2 font-normal">{label}</th>
                <td><input type="checkbox" aria-label={`${label}: ${t.settings.emailChannel}`} name={`${key}.email`} defaultChecked={prefs.data.prefs[key]?.email} /></td>
                <td><input type="checkbox" aria-label={`${label}: ${t.settings.appChannel}`} name={`${key}.inApp`} defaultChecked={prefs.data.prefs[key]?.inApp} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button type="submit" busy={s.busy}>{t.settings.savePrefs}</Button>
      </form>
    </Card>
  );
}

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
    <div className="max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>
      <Company canEdit={!!data?.permissions.includes('settings.edit')} />
      <Notifications />
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
