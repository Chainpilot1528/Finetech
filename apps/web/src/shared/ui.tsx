'use client';

import type { ButtonHTMLAttributes, FormEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useEffect, useId, useState } from 'react';
import { t } from './messages';

/** Reads a form field. Works even if the person typed before React finished loading. */
export const fieldValue = (e: FormEvent<HTMLFormElement>, name: string) =>
  String(new FormData(e.currentTarget).get(name) ?? '');

const CONTROL =
  'block w-full rounded-lg border bg-white px-3 py-2.5 text-base text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/25';

export function Field({ label, error, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <input id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined} {...input}
        className={`${CONTROL} ${error ? 'border-red-400' : 'border-line'}`} />
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-e`} className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

export function Select({ label, error, options, placeholder, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string; error?: string; placeholder?: string; options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <select id={id} aria-invalid={!!error} {...rest} className={`${CONTROL} ${error ? 'border-red-400' : 'border-line'}`}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

export function Button({ busy, children, ghost, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; ghost?: boolean }) {
  // A submit before React loads would reload the page and lose the form, so wait for it.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const look = ghost
    ? 'border border-line bg-white text-ink hover:bg-paper'
    : 'bg-brand text-white hover:bg-brand-deep';
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled || (rest.type === 'submit' && !ready)}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60 ${look} ${rest.className ?? ''}`}
    >
      {busy ? t.common.loading : children}
    </button>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const look = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-amber-200 bg-amber-50 text-amber-900',
  }[tone];
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3 py-2.5 text-sm ${look}`}>{children}</p>;
}

export function Skeleton({ className = 'h-24' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-xl bg-line/60 ${className}`} />;
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-white p-8 text-center">
      <p className="text-sm text-muted">{t.common.genericError}</p>
      <Button ghost className="mt-4" onClick={onRetry}>{t.common.retry}</Button>
    </div>
  );
}

export function Logo({ light }: { light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 text-lg font-bold tracking-tight ${light ? 'text-white' : 'text-ink'}`}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect width="26" height="26" rx="7" fill={light ? '#fff' : '#0f6b5c'} />
        <path d="M7 8l6 11 6-11" fill="none" stroke={light ? '#0f6b5c' : '#fff'} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {t.brand.name}
    </span>
  );
}
