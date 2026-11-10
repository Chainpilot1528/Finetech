'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { nextStep, useMe } from '@/features/auth/use-me';
import { api } from '@/shared/api';
import { t } from '@/shared/messages';
import { Button, Logo, Skeleton } from '@/shared/ui';

const NAV = [
  { href: '/ops', label: t.ops.nav.kyc, needs: 'partners.view' },
  { href: '/ops/cases', label: t.ops.nav.cases, needs: 'ops.cases' },
  { href: '/ops/invoices', label: t.ops.nav.invoices, needs: 'finance.manage' },
  { href: '/ops/rate-cards', label: t.ops.nav.rates, needs: 'finance.manage' },
  { href: '/ops/clawbacks', label: t.ops.nav.clawbacks, needs: 'finance.manage' },
];

export default function OpsLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  const queries = useQueryClient();
  const signingIn = path === '/ops/signin';
  const staff = me.data?.mfaState === 'ok' && me.data.permissions.includes('partners.view');

  useEffect(() => {
    if (signingIn || me.isPending) return;
    if (me.data === null) router.replace('/ops/signin');
    else if (me.data && me.data.mfaState !== 'ok') router.replace(nextStep(me.data.mfaState));
    else if (me.data && !staff) router.replace('/app/dashboard');
  }, [me.data, me.isPending, router, signingIn, staff]);

  if (signingIn) return children;
  if (!staff) return <div className="mx-auto max-w-5xl p-4"><Skeleton className="h-64" /></div>;

  async function signOut() {
    await api.POST('/auth/logout');
    queries.clear();
    router.replace('/ops/signin');
  }

  return (
    <div className="min-h-dvh">
      <header className="bg-brand-deep text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/ops"><Logo light /></Link>
          <span className="text-sm text-white/70">{t.ops.title}</span>
          <Button ghost className="ml-auto" onClick={signOut}>{t.common.signOut}</Button>
        </div>
        <nav aria-label="Ops" className="mx-auto flex max-w-6xl flex-wrap gap-1 px-4 pb-2">
          {NAV.filter((n) => me.data?.permissions.includes(n.needs)).map((n) => (
            <Link key={n.href} href={n.href} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${(n.href === '/ops' ? path === '/ops' || path.startsWith('/ops/partners') : path.startsWith(n.href)) ? 'bg-white/15 text-white' : 'text-white/70 hover:text-white'}`}>{n.label}</Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
