'use client';

import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { ErrorState, Skeleton } from '@/shared/ui';

export default function UsersPage() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap(api.GET('/users')) });
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.users.title}</h1>
      {users.isPending && <Skeleton className="h-48" />}
      {users.isError && <ErrorState onRetry={() => users.refetch()} />}
      {users.data?.data.length === 0 && <p className="text-sm text-muted">{t.users.empty}</p>}
      {!!users.data?.data.length && (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase text-muted">
              <tr>{[t.users.name, t.users.email, t.users.role, t.users.status, t.users.twoStep].map((h) => <th key={h} scope="col" className="px-4 py-3 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {users.data.data.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 font-medium">{u.name}</td>
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3 capitalize">{u.role}</td>
                  <td className="px-4 py-3 capitalize">{u.status}</td>
                  <td className="px-4 py-3">{u.mfaEnabled ? t.users.on : t.users.off}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
