/** "Rahul Kumar" becomes "R**** K****". */
export const maskName = (name: string) =>
  name.trim().split(/\s+/).map((w) => `${w[0] ?? ''}${'*'.repeat(Math.max(w.length - 1, 1))}`).join(' ');

export const maskPhone = (phone: string) => `******${phone.slice(-4)}`;

export function maskEmail(email: string) {
  const [local = '', domain = ''] = email.split('@');
  return `${local[0] ?? ''}***@${domain}`;
}

/** Stops spreadsheet apps treating a cell as a formula. */
export function csvCell(value: string | number | null) {
  const text = value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
