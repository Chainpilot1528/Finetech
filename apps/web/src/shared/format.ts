const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const IST = { timeZone: 'Asia/Kolkata' } as const;

export const rupees = (paise: number) => INR.format(paise / 100);
export const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const dateTime = (at: string) => new Date(at).toLocaleString('en-IN', { ...IST, dateStyle: 'medium', timeStyle: 'short' });
export const dateOnly = (at: string) => new Date(at).toLocaleDateString('en-IN', { ...IST, dateStyle: 'medium' });
export const age = (hours: number) => (hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`);

/** The current month and the eleven before it, in India time, newest first. */
export function lastMonths(): { value: string; label: string }[] {
  const now = new Date(Date.now() + 330 * 60_000);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return {
      value: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  });
}
