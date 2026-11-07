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

// Alpha has approved KYC, ready to create cases. Beta starts from nothing, for testing KYC.
const partners = [
  { name: 'Alpha Motors Finance', channel: 'Alpha Motors', code: 'DEL-110-0001', domain: 'alpha.test', city: 'New Delhi', pin: '110001', kyc: 'approved' },
  { name: 'Beta Loan Consultants', channel: 'Beta Loans', code: 'MUM-400-0002', domain: 'beta.test', city: 'Mumbai', pin: '400001', kyc: 'not_started' },
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
for (const role of ['kyc_reviewer', 'super_admin']) {
  const email = `${role.replace('_', '.')}@vittora.test`;
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

await client.end();
writeFileSync('.dev/seed-credentials.md', lines.join('\n'), { mode: 0o600 });
writeFileSync('.dev/seed-credentials.json', JSON.stringify(accounts, null, 2), { mode: 0o600 });
console.log('Seeded. Logins are in .dev/seed-credentials.md');
