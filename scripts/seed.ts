import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';

/** Fake partners and users for local testing. Passwords are random and stay in .dev/. */
process.loadEnvFile('.env');
const api = createRequire(resolve('apps/api/package.json'));
const { hash } = api('@node-rs/argon2') as typeof import('@node-rs/argon2');
const { v7: uuid } = api('uuid') as typeof import('uuid');

const client = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
await client.connect();
const lines = ['# Local test logins (fake data, this machine only)', ''];
const accounts: { email: string; password: string; role: string; partner: string }[] = [];

// Alpha has approved KYC, ready to create cases. Beta starts from nothing, for testing KYC. Gamma is for automation.
const partners = [
  { name: 'Alpha Motors Finance', channel: 'Alpha Motors', code: 'DEL-110-0001', domain: 'alpha.test', city: 'New Delhi', pin: '110001', kyc: 'approved' },
  { name: 'Beta Loan Consultants', channel: 'Beta Loans', code: 'MUM-400-0002', domain: 'beta.test', city: 'Mumbai', pin: '400001', kyc: 'not_started' },
  // Kept for the automated browser tests, which turn on two-step sign-in for these accounts.
  { name: 'Gamma Autos Finance', channel: 'Gamma Autos', code: 'PUN-411-0003', domain: 'gamma.test', city: 'Pune', pin: '411001', kyc: 'approved' },
];

for (const p of partners) {
  const found = await client.query('SELECT id FROM partner WHERE ref_code = $1', [p.code]);
  const id: string = found.rows[0]?.id ?? uuid();
  if (!found.rowCount) {
    await client.query(
      `INSERT INTO partner (id, ref_code, legal_name, channel_name, city, pincode, status, kyc_status)
       VALUES ($1,$2,$3,$4,$5,$6,'active','not_started')`,
      [id, p.code, p.name, p.channel, p.city, p.pin],
    );
  }
  await client.query('UPDATE partner SET kyc_status = $2 WHERE id = $1', [id, p.kyc]);
  // The browser tests expect Gamma to start with no cases or invoices, so a rerun begins clean.
  if (p.domain === 'gamma.test') {
    for (const table of ['clawback_recovery', 'clawback', 'invoice_event', 'invoice', 'invoice_counter', 'disbursal', 'case_reversal', 'case_note',
      'notification', 'pii_reveal_log', 'case_status_history', 'customer_consent', 'case_document', 'loan_case', 'applicant', 'case_draft', 'partner_billing']) {
      await client.query(`DELETE FROM ${table} WHERE partner_id = $1`, [id]);
    }
  }
  await client.query('DELETE FROM kyc_document WHERE partner_id = $1', [id]);
  await client.query('DELETE FROM partner_agreement WHERE partner_id = $1', [id]);
  for (const product of ['used_car', 'loan_against_car', 'personal']) {
    await client.query(
      'INSERT INTO partner_product (partner_id, product_code, enabled_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING',
      [id, product],
    );
  }
  lines.push(`## ${p.channel} (${p.code}), KYC ${p.kyc}`, '', '| Role | Email | Password |', '|---|---|---|');
  for (const role of ['admin', 'manager', 'executive', 'viewer']) {
    const email = `${role}@${p.domain}`;
    const password = randomBytes(9).toString('base64url') + '-Vt9';
    await client.query(
      `INSERT INTO app_user (id, partner_id, name, email, role, status, password_hash)
       VALUES ($1,$2,$3,$4,$5,'active',$6)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, locked_until = NULL, status = 'active'`,
      [uuid(), id, `Test ${role[0]!.toUpperCase()}${role.slice(1)}`, email, role, await hash(password)],
    );
    accounts.push({ email, password, role, partner: p.code });
    lines.push(`| ${role} | ${email} | ${password} |`);
  }
  const invited = `invited@${p.domain}`;
  await client.query(
    `INSERT INTO app_user (id, partner_id, name, email, role, status) VALUES ($1,$2,'Test Invited',$3,'executive','invited')
     ON CONFLICT (lower(email)) DO UPDATE SET status = 'invited', password_hash = NULL`,
    [uuid(), id, invited],
  );
  lines.push(`| invited (use Forgot password) | ${invited} | none yet |`, '');
}
lines.push('## Vittora staff (sign in at /ops/signin)', '', '| Role | Email | Password |', '|---|---|---|');
const staff: [string, string][] = [
  ['kyc_reviewer', 'kyc.reviewer'], ['super_admin', 'super.admin'], ['ops_agent', 'ops.agent'], ['ops_lead', 'ops.lead'],
  ['finance', 'finance.one'], ['finance', 'finance.two'],
];
for (const [role, handle] of staff) {
  const email = `${handle}@vittora.test`;
  const password = randomBytes(9).toString('base64url') + '-Vt9';
  await client.query(
    `INSERT INTO app_user (id, partner_id, name, email, role, status, password_hash) VALUES ($1,NULL,$2,$3,$4,'active',$5)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL, locked_until = NULL`,
    [uuid(), `Staff ${role}`, email, role, await hash(password)],
  );
  accounts.push({ email, password, role, partner: 'internal' });
  lines.push(`| ${role} | ${email} | ${password} |`);
}
lines.push('');

const lenders = ['Test Bank One', 'Test Bank Two', 'Test Finance NBFC'];
for (const name of lenders) {
  const found = await client.query('SELECT id FROM lender WHERE name = $1', [name]);
  const id: string = found.rows[0]?.id ?? uuid();
  if (!found.rowCount) await client.query('INSERT INTO lender (id, name, type) VALUES ($1,$2,$3)', [id, name, name.includes('NBFC') ? 'nbfc' : 'bank']);
  for (const product of ['used_car', 'loan_against_car', 'personal']) {
    await client.query('INSERT INTO lender_product (lender_id, product_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, product]);
  }
}

// A 1% rate for two lenders. Test Finance NBFC has none, so testers can see an invoice wait for a rate.
const makers = await client.query(`SELECT id FROM app_user WHERE email LIKE 'finance.%@vittora.test' ORDER BY email`);
for (const name of ['Test Bank One', 'Test Bank Two']) {
  const lender = await client.query('SELECT id FROM lender WHERE name = $1', [name]);
  for (const product of ['used_car', 'loan_against_car', 'personal']) {
    const found = await client.query('SELECT 1 FROM rate_card WHERE lender_id = $1 AND product = $2', [lender.rows[0].id, product]);
    if (found.rowCount) continue;
    await client.query(
      `INSERT INTO rate_card (id, lender_id, product, pct_bps, clawback_months, valid_from, status, created_by, approved_by, created_at, decided_at)
       VALUES ($1,$2,$3,100,6,'2024-04-01','active',$4,$5,now(),now())`,
      [uuid(), lender.rows[0].id, product, makers.rows[0].id, makers.rows[1].id],
    );
  }
}

await client.end();
writeFileSync('.dev/seed-credentials.md', lines.join('\n'), { mode: 0o600 });
writeFileSync('.dev/seed-credentials.json', JSON.stringify(accounts, null, 2), { mode: 0o600 });
console.log('Seeded. Logins are in .dev/seed-credentials.md');
