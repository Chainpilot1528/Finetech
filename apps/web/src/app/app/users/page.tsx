'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useMe } from '@/features/auth/use-me';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, Cell, DataTable, ErrorState, Field, Select, Skeleton, fieldValue } from '@/shared/ui';

const ROLES = Object.entries(t.users.roles).map(([value, label]) => ({ value, label }));
type Role = 'admin' | 'manager' | 'executive' | 'viewer';

export default function UsersPage() {
  const { data: me } = useMe();
  const queries = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')) });
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<string>();

  async function run(work: () => Promise<unknown>, done = t.users.done) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(done);
      setInviting(false);
      setLeaving(undefined);
      await queries.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const phone = fieldValue(e, 'phone');
    const body = { name: fieldValue(e, 'name'), email: fieldValue(e, 'email'), role: fieldValue(e, 'role'), ...(phone ? { phone } : {}) };
    run(() => unwrap(api.POST('/users/invite', { body })), t.users.invited);
  }

  const post = (path: '/users/{id}/reactivate' | '/users/{id}/resend-invite' | '/users/{id}/sign-out', id: string) =>
    run(() => unwrap(api.POST(path, { params: { path: { id } } })));
  const list = users.data?.data ?? [];
  const takers = list.filter((u) => u.status === 'active' && u.role !== 'viewer' && u.id !== leaving);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{t.users.title}</h1>
        <Button onClick={() => setInviting(!inviting)}>{t.users.invite}</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
      {inviting && (
        <Card title={t.users.invite}>
          <form onSubmit={invite} className="grid gap-3 sm:grid-cols-2">
            <Field label={t.users.name} name="name" required minLength={2} />
            <Field label={t.users.email} name="email" type="email" required />
            <Field label={t.users.phone} name="phone" inputMode="numeric" pattern="[6-9][0-9]{9}" />
            <Select label={t.users.role} name="role" defaultValue="executive" options={ROLES} />
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" busy={busy}>{t.users.send}</Button>
              <Button ghost type="button" onClick={() => setInviting(false)}>{t.users.cancel}</Button>
            </div>
          </form>
        </Card>
      )}
      {users.isPending && <Skeleton className="h-48" />}
      {users.isError && <ErrorState onRetry={() => users.refetch()} />}
      {list.length === 0 && !users.isPending && <p className="text-sm text-muted">{t.users.empty}</p>}
      {list.length > 0 && (
        <DataTable head={[t.users.name, t.users.email, t.users.role, t.users.status, t.users.twoStep, t.users.actions]} min={860}>
          {list.map((u) => {
            const self = u.id === me?.userId;
            return (
              <tr key={u.id} className="border-b border-line align-top last:border-0">
                <Cell strong>{u.name} {self && <span className="font-normal text-muted">{t.users.you}</span>}</Cell>
                <Cell>{u.email}</Cell>
                <Cell>
                  <select aria-label={`${t.users.edit}: ${u.name}`} value={u.role} disabled={self || u.status === 'inactive'} className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm"
                    onChange={(e) => { const role = e.target.value as Role; run(() => unwrap(api.PATCH('/users/{id}', { params: { path: { id: u.id } }, body: { role } }))); }}>
                    {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </Cell>
                <Cell><Badge status={u.status} label={t.users.statuses[u.status]} /></Cell>
                <Cell>{u.mfaEnabled ? t.users.on : t.users.off}</Cell>
                <Cell>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm font-medium text-brand">
                    {u.status === 'invited' && <button type="button" className="hover:underline" onClick={() => post('/users/{id}/resend-invite', u.id)}>{t.users.resend}</button>}
                    {u.status === 'inactive' && <button type="button" className="hover:underline" onClick={() => post('/users/{id}/reactivate', u.id)}>{t.users.reactivate}</button>}
                    {u.status === 'active' && !self && <button type="button" className="hover:underline" onClick={() => post('/users/{id}/sign-out', u.id)}>{t.users.signOut}</button>}
                    {u.status !== 'inactive' && !self && <button type="button" className="hover:underline" onClick={() => setLeaving(leaving === u.id ? undefined : u.id)}>{t.users.deactivate}</button>}
                  </div>
                  {leaving === u.id && (
                    <form className="mt-2 space-y-2" onSubmit={(e) => {
                      e.preventDefault();
                      const reassignTo = fieldValue(e, 'reassignTo');
                      run(() => unwrap(api.POST('/users/{id}/deactivate', { params: { path: { id: u.id } }, body: reassignTo ? { reassignTo } : {} })));
                    }}>
                      <Select label={t.users.reassign} name="reassignTo" placeholder="" options={takers.map((x) => ({ value: x.id, label: x.name }))} />
                      <Button type="submit" busy={busy}>{t.users.confirmDeactivate}</Button>
                    </form>
                  )}
                </Cell>
              </tr>
            );
          })}
        </DataTable>
      )}
    </div>
  );
}
