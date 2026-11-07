'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { nextStep, useMe } from '@/features/auth/use-me';
import { api } from '@/shared/api';
import { t } from '@/shared/messages';
import { Button, ErrorState, Logo, Skeleton } from '@/shared/ui';

/** Each item needs a capability; menu items a role can't use are hidden, not disabled (§3.2). */
const NAV = [
  { href: '/app/dashboard', label: t.nav.dashboard, needs: 'dashboard.view' },
  { href: '/app/create-case', label: t.nav.createCase, needs: 'case.create' },
  { href: '/app/cases', label: t.nav.cases, needs: ['case.view_all', 'case.view_own'] },
  { href: '/app/invoices', label: t.nav.invoices, needs: 'invoices.manage' },
  { href: '/app/users', label: t.nav.users, needs: 'users.manage' },
  { href: '/app/kyc', label: t.nav.kyc, needs: 'kyc.manage' },
  { href: '/app/settings', label: t.nav.settings, needs: 'settings.view' },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (me.data === null) router.replace('/signin');
    else if (me.data && me.data.mfaState !== 'ok') router.replace(nextStep(me.data.mfaState));
    else if (me.data?.permissions.includes('partners.view')) router.replace('/ops');
  }, [me.data, router]);

  if (me.isError) return <div className="mx-auto max-w-5xl p-4"><ErrorState onRetry={() => me.refetch()} /></div>;
  if (!me.data || me.data.mfaState !== 'ok') return <div className="mx-auto max-w-5xl space-y-4 p-4"><Skeleton className="h-14" /><Skeleton className="h-64" /></div>;

  const permissions = me.data.permissions;
  const items = NAV.filter((n) => [n.needs].flat().some((c) => permissions.includes(c)));

  async function signOut() {
    await api.POST('/auth/logout');
    queries.clear();
    router.replace('/signin');
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/app/dashboard" aria-label={t.brand.name}><Logo /></Link>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-auto rounded-lg border border-line px-3 py-2 text-sm md:hidden">{t.nav.menu}</button>
          <nav aria-label="Main" className={`${open ? 'flex' : 'hidden'} absolute inset-x-0 top-[61px] z-10 flex-col gap-1 border-b border-line bg-white p-3 md:static md:flex md:flex-1 md:flex-row md:items-center md:border-0 md:p-0`}>
            {items.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} aria-current={path === n.href ? 'page' : undefined}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${path === n.href ? 'bg-brand/10 text-brand-deep' : 'text-muted hover:text-ink'}`}>{n.label}</Link>
            ))}
            <div className="md:ml-auto md:flex md:items-center md:gap-3">
              <span className="block px-3 py-2 text-sm text-muted md:px-0" data-testid="org-name">{me.data.partner?.channelName}</span>
              <Button ghost onClick={signOut} className="w-full md:w-auto">{t.common.signOut}</Button>
            </div>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
