import { t } from './messages';

/**
 * Decorative pieces of the UI refresh: aurora glows, finance clip art, side cards that fade in and
 * out, and the case journey. All of it is hidden from screen readers and stops moving for people who
 * ask for less motion (globals.css).
 */

/** Slow green and gold glows on deep green (Aurora). `glow={false}` gives the plain green (staff). */
export function AuroraBackground({ glow = true }: { glow?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {glow && (
        <div className="absolute inset-0 opacity-80">
          <div className="v-aurora-1 absolute -left-[8%] -top-[10%] h-[420px] w-[640px] rounded-full bg-[#13937a] blur-[120px]" />
          <div className="v-aurora-2 absolute -right-[6%] top-[20%] h-[460px] w-[560px] rounded-full bg-brand blur-[110px]" />
          <div className="v-aurora-3 absolute -bottom-[14%] left-[30%] h-[320px] w-[420px] rounded-full bg-gold opacity-55 blur-[140px]" />
        </div>
      )}
      <div className="v-grid-dark absolute inset-0" />
    </div>
  );
}

/** Soft, rounded "clay" finance icons for the dark auth screens. */
export function ClayArt() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden opacity-25 sm:block">
      <svg className="v-drift absolute left-[6%] top-[12%]" width="96" height="96" viewBox="0 0 64 64"><ellipse cx="32" cy="54" rx="18" ry="4" fill="#000" opacity=".25" /><circle cx="32" cy="30" r="20" fill="#d9a54a" /><circle cx="32" cy="30" r="15" fill="#e8c47d" /><ellipse cx="26" cy="22" rx="6" ry="3.5" fill="#fbefd4" opacity=".8" /><text x="32" y="36" textAnchor="middle" fontSize="16" fontWeight="700" fill="#8a5f17">₹</text></svg>
      <svg className="v-drift-2 absolute left-[83%] top-[10%]" width="120" height="96" viewBox="0 0 80 64"><ellipse cx="40" cy="58" rx="30" ry="4" fill="#000" opacity=".25" /><rect x="8" y="28" width="64" height="20" rx="10" fill="#1fa58c" /><path d="M20 29 Q26 15 40 15 Q54 15 60 29 Z" fill="#3cc4a8" /><rect x="28" y="18" width="10" height="9" rx="3" fill="#d8f6ee" /><rect x="42" y="18" width="10" height="9" rx="3" fill="#d8f6ee" /><circle cx="22" cy="48" r="7" fill="#17201e" /><circle cx="22" cy="48" r="3" fill="#9aa8a4" /><circle cx="58" cy="48" r="7" fill="#17201e" /><circle cx="58" cy="48" r="3" fill="#9aa8a4" /></svg>
      <svg className="v-drift-3 absolute left-[10%] top-[72%]" width="100" height="100" viewBox="0 0 64 64"><ellipse cx="32" cy="58" rx="20" ry="3.5" fill="#000" opacity=".25" /><rect x="14" y="28" width="36" height="26" rx="6" fill="#f3ead7" /><path d="M8 32 L32 10 L56 32 Z" fill="#d9725a" stroke="#d9725a" strokeWidth="4" strokeLinejoin="round" /><rect x="27" y="38" width="10" height="16" rx="3" fill="#0f6b5c" /></svg>
      <svg className="v-drift absolute left-[88%] top-[56%]" width="92" height="92" viewBox="0 0 64 64"><ellipse cx="32" cy="58" rx="20" ry="3.5" fill="#000" opacity=".25" /><rect x="10" y="36" width="10" height="18" rx="4" fill="#3cc4a8" /><rect x="26" y="26" width="10" height="28" rx="4" fill="#1fa58c" /><rect x="42" y="14" width="10" height="40" rx="4" fill="#e8c47d" /></svg>
      <svg className="v-drift-2 absolute left-[30%] top-[5%]" width="80" height="80" viewBox="0 0 64 64"><ellipse cx="32" cy="58" rx="16" ry="3" fill="#000" opacity=".25" /><path d="M32 6 L52 13 V28 C52 41 43 50 32 55 C21 50 12 41 12 28 V13 Z" fill="#3cc4a8" /><path d="M23 30 L29 36 L41 24" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  );
}

const LINE = { fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/**
 * Thin line-drawn finance icons. `tone="dark"` scatters them over the green sign-in screens.
 * `tone="light"` (dashboard) keeps them in the empty side margins beside the content, and hides them
 * on screens too narrow to have margins, so they never sit behind text or cards.
 */
export function LineArt({ tone }: { tone: 'dark' | 'light' }) {
  const dark = tone === 'dark';
  const stroke = dark ? '#ffffff' : '#0f6b5c';
  const accent = dark ? '#ffffff' : '#c8963e';
  const width = dark ? 1 : 1.4;
  // Positions: [dark, light]. Light ones stay within ~2–6% of each edge (the margins beside max-w-6xl).
  const at = (d: string, l: string) => `absolute ${dark ? d : l}`;
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 hidden ${dark ? 'sm:block opacity-[.18]' : '2xl:block opacity-[.12]'}`}>
      <svg className={`v-drift ${at('left-[5%] top-[12%]', 'left-[2%] top-[20%]')}`} width="100" height="100" viewBox="0 0 48 48" stroke={stroke} strokeWidth={width} {...LINE}><path d="M6 30 L10 20 H38 L42 30 V36 H6 Z" /><path d="M12 20 L16 12 H32 L36 20" /><circle cx="14" cy="36" r="4" /><circle cx="34" cy="36" r="4" /></svg>
      <svg className={`v-drift-2 ${at('left-[84%] top-[9%]', 'right-[2%] top-[18%]')}`} width="96" height="96" viewBox="0 0 48 48" stroke={accent} strokeWidth={width} {...LINE}><path d="M8 22 L24 8 L40 22" /><path d="M12 20 V40 H36 V20" /><path d="M20 40 V30 H28 V40" /></svg>
      <svg className={`v-drift-3 ${at('left-[12%] top-[74%]', 'left-[3%] top-[72%]')}`} width="84" height="84" viewBox="0 0 48 48" stroke={accent} strokeWidth={width} {...LINE}><ellipse cx="24" cy="34" rx="14" ry="5" /><ellipse cx="24" cy="26" rx="14" ry="5" /><ellipse cx="24" cy="18" rx="14" ry="5" /></svg>
      <svg className={`v-drift ${at('left-[86%] top-[68%]', 'right-[3%] top-[48%]')}`} width="92" height="92" viewBox="0 0 48 48" stroke={stroke} strokeWidth={width} {...LINE}><path d="M6 40 H42" /><path d="M8 32 L18 22 L26 28 L40 12" /><path d="M32 12 H40 V20" /></svg>
      <svg className={`v-drift-2 ${at('left-[34%] top-[5%]', 'left-[3%] top-[46%]')}`} width="72" height="72" viewBox="0 0 48 48" stroke={stroke} strokeWidth={width} {...LINE}><path d="M14 10 H34 M14 18 H34 M14 10 C30 10 30 26 14 26 L32 40" /></svg>
      <svg className={`v-drift-3 ${at('left-[62%] top-[84%]', 'right-[2%] top-[76%]')}`} width="80" height="80" viewBox="0 0 48 48" stroke={stroke} strokeWidth={width} {...LINE}><path d="M12 6 H30 L38 14 V42 H12 Z" /><path d="M30 6 V14 H38" /><path d="M18 24 L22 28 L30 20" /></svg>
    </div>
  );
}

const GHOST = 'v-ghost pointer-events-none absolute hidden rounded-2xl bg-white px-[18px] py-3.5 shadow-[0_14px_34px_rgba(0,0,0,.25)] xl:flex';

/** Three small example cards that take turns fading in beside the sign-in card. Illustrations, not data. */
export function GhostCards() {
  return (
    <div aria-hidden>
      <div className={`${GHOST} left-[7%] top-[40%] items-center gap-3`}>
        <svg width="32" height="32" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#e3f2ee" /><path className="v-draw" d="M12 21 L18 27 L29 15" fill="none" stroke="#0f6b5c" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="text-sm font-semibold text-ink">{t.scene.approved}</span>
      </div>
      <div className={`${GHOST} v-ghost-2 right-[7%] top-[28%] flex-col gap-0.5`}>
        <span className="text-xs text-muted">{t.scene.disbursed}</span>
        <span className="font-display text-xl font-semibold text-ink">{t.scene.disbursedAmount}</span>
      </div>
      <div className={`${GHOST} v-ghost-3 bottom-[15%] right-[12%] items-end gap-3.5`}>
        <span className="flex flex-col"><span className="text-xs text-muted">{t.scene.commission}</span><span className="font-display text-xl font-semibold text-[#a8771f]">{t.scene.commissionAmount}</span></span>
        <span className="flex h-8 items-end gap-1">
          <span className="v-rise h-3.5 w-[7px] rounded-sm bg-[#b7d6cf]" />
          <span className="v-rise h-[22px] w-[7px] rounded-sm bg-[#5fa797] [animation-delay:.15s]" />
          <span className="v-rise h-8 w-[7px] rounded-sm bg-gold [animation-delay:.3s]" />
        </span>
      </div>
    </div>
  );
}

/** An example case moving through its five stages, ending in a "Disbursed" stamp (sign-up page). */
export function JourneyCard() {
  return (
    <aside aria-label={t.scene.journeyLabel} className="v-in v-d3 relative w-full lg:sticky lg:top-12 max-w-[440px] rounded-3xl bg-white p-7 shadow-[0_30px_70px_rgba(0,0,0,.30)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-muted">{t.scene.journeyCase}</p>
          <p className="mt-1 font-display text-[28px] font-semibold">{t.scene.journeyAmount}</p>
        </div>
        <span aria-hidden className="v-stamp rounded-lg border-[3px] border-gold px-2.5 py-1 font-display text-[15px] font-bold tracking-[0.08em] text-[#a8771f]">{t.scene.stamp}</span>
      </div>
      <ol className="relative mt-6 flex flex-col gap-[18px]">
        <span aria-hidden className="absolute bottom-4 left-[15px] top-4 w-0.5 bg-line" />
        <span aria-hidden className="v-line absolute bottom-4 left-[15px] top-4 w-0.5 bg-brand" />
        {t.scene.journeySteps.map((step, i) => (
          <li key={step} className="relative flex items-center gap-3.5">
            <span aria-hidden className={`v-step-${i + 1} flex size-8 shrink-0 items-center justify-center rounded-full bg-line text-[13px] font-semibold text-muted`}>{i + 1}</span>
            <span className="text-[15px] font-medium">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-6 font-display text-lg font-semibold">{t.scene.journeyHeading}</p>
      <p className="mt-1 text-sm text-muted">{t.scene.journeyBody}</p>
    </aside>
  );
}
