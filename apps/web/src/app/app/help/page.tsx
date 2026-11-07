'use client';

import { useState } from 'react';
import { t } from '@/shared/messages';
import { Card, DataTable, Cell } from '@/shared/ui';

const ARTICLES = [
  { title: 'Quick start', body: 'Register your business, set your password from the email link, and turn on two-step sign-in. Accept the partner agreement and upload your KYC documents. Once Vittora approves your KYC you can create cases.' },
  { title: 'Creating a case', body: 'Open Create Case and follow the six steps. Your work saves as you go. Upload a masked Aadhaar, with the first 8 digits hidden. The customer must confirm through their own link before you can submit.' },
  { title: 'Tracking a case', body: 'All Cases lists every case you can see. Search by case ID, the last 4 digits of the phone, or the vehicle number. Open a case for its history, documents and notes.' },
  { title: 'When a case needs your action', body: 'Vittora sends a case back when something is missing. It appears under Needs Action. Read the note, add what was asked for, and send it back for review.' },
  { title: 'Customer contact details', body: 'Phone and email are masked by default. To see one, click Show and type your reason. Every view is recorded. An Admin can change this in Settings.' },
  { title: 'Invoices and commission', body: 'Each disbursal creates a draft invoice. Before you can raise it, your KYC and your bank and GST details must be verified. Vittora then approves and pays it. If something looks wrong, open the invoice and dispute it.' },
  { title: 'Clawbacks', body: 'If a disbursed case is reversed, unpaid invoices are voided. Commission already paid is recovered from your next payouts, and shows on the invoice timeline.' },
  { title: 'Managing your team', body: 'Admins invite people from Users. They set their own password through the email link. Before you deactivate someone with open cases, choose who takes those cases over.' },
];

const ROLES: [string, ...boolean[]][] = [
  ['Dashboard', true, true, true, true],
  ['Create cases and add notes', true, true, true, false],
  ['See all organisation cases', true, true, false, true],
  ['Show masked contact details', true, true, true, false],
  ['Download cases', true, true, false, false],
  ['Users, invoices, edit settings, KYC', true, false, false, false],
];

export default function HelpPage() {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const found = ARTICLES.filter((a) => `${a.title} ${a.body}`.toLowerCase().includes(term));
  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.help.title}</h1>
      <input type="search" aria-label={t.help.search} placeholder={t.help.search} value={q} onChange={(e) => setQ(e.target.value)} className="min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm" />
      {found.length === 0 && <p className="text-sm text-muted">{t.help.empty}</p>}
      {found.map((a) => <Card key={a.title} title={a.title}><p className="text-sm">{a.body}</p></Card>)}
      {!term && (
        <>
          <h2 className="font-semibold">{t.help.roles}</h2>
          <DataTable head={['', ...Object.values(t.users.roles)]} min={560}>
            {ROLES.map(([label, ...cells]) => (
              <tr key={label} className="border-b border-line last:border-0">
                <Cell strong>{label}</Cell>
                {cells.map((yes, i) => <Cell key={i}>{yes ? '✓' : '–'}</Cell>)}
              </tr>
            ))}
          </DataTable>
        </>
      )}
    </div>
  );
}
