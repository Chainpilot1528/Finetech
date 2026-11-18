import type { ReactNode } from 'react';
import { AuroraBackground, ClayArt, GhostCards, JourneyCard } from '@/shared/scene';
import { Logo } from '@/shared/ui';

/**
 * Signed-out screens (UI refresh): a white card centred on deep green.
 * - `partner` (default): aurora glow, clay finance icons and example cards fading in at the sides.
 * - `join`: the same scene, with the case journey beside the form (partner sign-up).
 * - `staff`: plain green and grid, nothing moving, so the back office looks clearly different.
 */
export function AuthShell({ title, subtitle, children, footer, variant = 'partner' }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'partner' | 'join' | 'staff';
}) {
  const lively = variant !== 'staff';
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-7 overflow-hidden bg-night px-4 py-12">
      <AuroraBackground glow={lively} />
      {lively && <ClayArt />}
      {variant === 'partner' && <GhostCards />}

      <div className="v-in relative"><Logo light /></div>

      <div className={`relative flex w-full flex-wrap items-start justify-center gap-6 ${variant === 'join' ? 'max-w-[920px]' : 'max-w-[440px]'}`}>
        <section className="v-in v-d2 w-full max-w-[440px] rounded-3xl bg-white p-7 shadow-[0_30px_70px_rgba(0,0,0,.30)] sm:p-10">
          <div className="text-center">
            <h1 className="font-display text-[28px] font-semibold tracking-tight sm:text-3xl">{title}</h1>
            {subtitle && <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p>}
          </div>
          <div className="mt-7">{children}</div>
        </section>
        {variant === 'join' && <JourneyCard />}
      </div>

      {footer && <div className="v-in v-d3 relative text-sm text-[#cfe3dd] [&_a]:font-medium [&_a]:text-mint [&_a:hover]:text-white">{footer}</div>}
    </main>
  );
}
