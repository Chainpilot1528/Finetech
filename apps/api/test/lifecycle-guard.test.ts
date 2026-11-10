import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextStatuses } from '../src/modules/cases/domain/lifecycle.js';
import { createLender, createPartner, createUser, enableProducts, harness, makeCase, signedIn, type Harness } from './helpers.js';

const STATUSES = ['REGISTERED', 'IN_REVIEW', 'APPROVED', 'CUSTOMER_APPROVED', 'DISBURSAL_IN_PROGRESS', 'DISBURSED', 'REVERSED', 'RELOOK', 'REJECTED', 'WITHDRAWN'];
/** Moves only special flows make: recording the final disbursal and an approved reversal. */
const SPECIAL = ['DISBURSAL_IN_PROGRESS>DISBURSED', 'DISBURSED>REVERSED'];

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(async () => h?.close());

describe('the database guards case status (ARCH-01)', () => {
  it('allows exactly the moves the lifecycle rules allow', async () => {
    const fromCode = new Set(SPECIAL);
    for (const from of STATUSES) {
      for (const to of nextStatuses(from, 'ops', null)) fromCode.add(`${from}>${to}`);
      for (const relookFrom of STATUSES) for (const to of nextStatuses(from, 'partner', relookFrom)) fromCode.add(`${from}>${to}`);
    }
    const { rows } = await h.db.query('SELECT from_status, to_status FROM case_transition');
    const inDb = new Set(rows.map((r) => `${r.from_status}>${r.to_status}`));
    // A partner can only return a Relook to an open stage, so the impossible pairs drop out.
    const possible = [...fromCode].filter((m) => !/^RELOOK>(DISBURSED|REVERSED|RELOOK)$/.test(m));
    expect([...inDb].sort()).toEqual(possible.sort());
  });

  it('refuses a skipped stage, a status change without a new version, and a bad Relook return', async () => {
    const partner = await createPartner(h.db, {}, 'approved');
    await enableProducts(h.db, partner);
    const lender = await createLender(h.db);
    const exec = await signedIn(h, (await createUser(h.db, partner, 'executive')).email);
    const { id } = await makeCase(h, exec, lender);
    await expect(h.db.query(`UPDATE loan_case SET status = 'DISBURSED', version = version + 1 WHERE id = $1`, [id])).rejects.toThrow(/can not move/);
    await expect(h.db.query(`UPDATE loan_case SET status = 'IN_REVIEW' WHERE id = $1`, [id])).rejects.toThrow(/bump the version/);
    await h.db.query(`UPDATE loan_case SET status = 'RELOOK', relook_from = 'REGISTERED', version = version + 1 WHERE id = $1`, [id]);
    await expect(h.db.query(`UPDATE loan_case SET status = 'APPROVED', version = version + 1 WHERE id = $1`, [id])).rejects.toThrow(/returns to where it was/);
    await h.db.query(`UPDATE loan_case SET status = 'REGISTERED', relook_from = NULL, version = version + 1 WHERE id = $1`, [id]);
  });
});
