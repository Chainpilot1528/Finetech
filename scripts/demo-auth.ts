import { timingSafeEqual } from 'node:crypto';

/** Who may open what behind the demo tunnel's password proxy (D-031). */
export interface DemoPasswords {
  SITE_USER: string;
  SITE_PASS: string;
  INBOX_USER: string;
  INBOX_PASS: string;
}

export type Access = { ok: true; inbox: boolean } | { ok: false; realm: string };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function credentials(header: string | undefined) {
  if (!header?.startsWith('Basic ')) return null;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  return { user: user ?? '', pass: pass ?? '' };
}

/** Every page worth opening in the demo, for links.txt. Paths only; the link is added per run. */
export function linksText(base: string, startedAt: Date): string {
  const page = (path: string, what: string) => `${what.padEnd(34)} ${base}${path}`;
  return [
    'Vittora demo links (fake data only)',
    `Started ${startedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. These stop working when pnpm demo:tunnel stops,`,
    'and the link changes every time it starts. This file is rewritten on each start.',
    '',
    'Passwords: .dev/demo-passwords.env (site: client, inbox: inbox)',
    'App logins: .dev/seed-credentials.md',
    '',
    'SEND TO THE CLIENT',
    page('', 'Main link'),
    '',
    'TEST INBOX (emails, texts, codes)',
    page('/inbox', 'Inbox (inbox password)'),
    '',
    'PARTNER PORTAL',
    page('/signin', 'Partner sign in'),
    page('/signup', 'Register a new partner'),
    page('/forgot-password', 'Forgot password'),
    page('/app/dashboard', 'Dashboard'),
    page('/app/create-case', 'Create case'),
    page('/app/cases', 'Cases'),
    page('/app/invoices', 'Invoices (admin)'),
    page('/app/users', 'Team (admin)'),
    page('/app/kyc', 'Company KYC (admin)'),
    page('/app/settings', 'Settings'),
    page('/app/help', 'Help'),
    '',
    'VITTORA STAFF (BACK OFFICE)',
    page('/ops/signin', 'Staff sign in'),
    page('/ops', 'Partners and KYC review'),
    page('/ops/cases', 'Case queue'),
    page('/ops/invoices', 'Invoice review (finance)'),
    page('/ops/rate-cards', 'Rate cards (finance)'),
    page('/ops/clawbacks', 'Clawbacks (finance)'),
    '',
  ].join('\n');
}

export const isInboxPath = (url: string) => url === '/inbox' || url.startsWith('/inbox/') || url.startsWith('/inbox?');

/**
 * The inbox needs the inbox password. The app accepts either password: a browser keeps one password
 * per site and sends the last one it used everywhere, so after someone opens /inbox their app
 * requests carry the inbox password. Whoever holds it may open the app anyway.
 */
export function checkAccess(url: string, header: string | undefined, pw: DemoPasswords): Access {
  const c = credentials(header);
  const inbox = isInboxPath(url);
  const isInbox = !!c && same(c.user, pw.INBOX_USER) && same(c.pass, pw.INBOX_PASS);
  const isSite = !!c && same(c.user, pw.SITE_USER) && same(c.pass, pw.SITE_PASS);
  if (inbox ? isInbox : isInbox || isSite) return { ok: true, inbox };
  return { ok: false, realm: inbox ? 'Vittora demo inbox' : 'Vittora demo' };
}
