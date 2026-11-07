import type { ReactNode } from 'react';
import { Logo } from '@/shared/ui';
import { t } from '@/shared/messages';

/** Two-panel layout for signed-out screens. The panel hides on phones. */
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <aside className="hidden flex-col justify-between bg-brand-deep p-12 text-white lg:flex">
        <Logo light />
        <div>
          <p className="text-3xl font-semibold leading-tight">{t.brand.tagline}</p>
          <p className="mt-4 max-w-md text-white/75">{t.signIn.pitch}</p>
        </div>
        <div className="h-1 w-16 rounded bg-gold" />
      </aside>
      <section className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </section>
    </main>
  );
}
