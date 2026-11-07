'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, unwrap } from '@/shared/api';
import { dateTime } from '@/shared/format';
import { t } from '@/shared/messages';

export function Bell() {
  const [open, setOpen] = useState(false);
  const queries = useQueryClient();
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => unwrap(api.GET('/notifications')), refetchInterval: 60_000 });
  const unread = list.data?.unreadCount ?? 0;

  async function markAll() {
    await api.POST('/notifications/read', { body: {} });
    await queries.invalidateQueries({ queryKey: ['notifications'] });
  }

  return (
    <div className="relative print:hidden">
      <button type="button" aria-expanded={open} aria-label={`${t.bell.label}: ${unread}`} onClick={() => setOpen(!open)}
        className="relative min-h-11 rounded-lg border border-line px-3 py-2 text-sm text-muted hover:text-ink">
        {t.bell.label}
        {unread > 0 && <span data-testid="unread" className="ml-2 rounded-full bg-brand px-1.5 py-0.5 text-xs font-semibold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">{t.bell.label}</p>
            {unread > 0 && <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={markAll}>{t.bell.markAll}</button>}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {list.data?.data.length === 0 && <li className="p-4 text-sm text-muted">{t.bell.empty}</li>}
            {list.data?.data.map((n) => (
              <li key={n.id} className={`border-b border-line last:border-0 ${n.readAt ? '' : 'bg-brand/5'}`}>
                <Link href={`/app/cases/${n.payload.caseId}`} onClick={() => setOpen(false)} className="block px-4 py-2.5 text-sm hover:bg-paper">
                  <span className="font-medium">{n.payload.caseNo}</span> {t.bell.moved} {t.cases.status[n.payload.status] ?? n.payload.status}
                  <span className="block text-xs text-muted">{dateTime(n.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
