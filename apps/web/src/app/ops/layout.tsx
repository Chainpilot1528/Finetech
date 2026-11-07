'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { nextStep, useMe } from '@/features/auth/use-me';
import { api } from '@/shared/api';
import { t } from '@/shared/messages';
import { Button, Logo, Skeleton } from '@/shared/ui';

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
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
