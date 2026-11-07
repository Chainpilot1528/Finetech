import { describe, expect, it } from 'vitest';
import { PARTNER_ROLES } from '@vittora/shared-kernel';
import { type Capability, can, capabilitiesFor, requiresMfa } from '../src/modules/identity/domain/permissions.js';

// PRD §7.1, written out by hand so a slip in the matrix fails here.
const EXPECTED: Record<Capability, [admin: boolean, manager: boolean, executive: boolean, viewer: boolean]> = {
  'dashboard.view': [true, true, true, true],
  'case.create': [true, true, true, false],
  'case.view_all': [true, true, false, true],
  'case.view_own': [false, false, true, false],
  'case.note': [true, true, true, false],
  'case.fieldwork': [true, true, true, false],
  'case.inhouse_lifecycle': [true, true, false, false],
  'case.bank_allocate': [true, true, false, false],
  'case.bureau_pull': [true, true, true, false],
  'case.export': [true, true, false, false],
  'pii.reveal': [true, true, true, false],
  'policy.manage': [true, true, false, false],
  'users.manage': [true, false, false, false],
  'invoices.manage': [true, false, false, false],
  'settings.view': [true, true, true, true],
  'settings.edit': [true, false, false, false],
  'notifications.view': [true, true, true, true],
};

describe('role matrix (§7.1)', () => {
  const inhouse = { inhouse: { enabled: true } };
  for (const [capability, row] of Object.entries(EXPECTED)) {
    PARTNER_ROLES.forEach((role, i) => {
      it(`${role} ${row[i] ? 'can' : 'cannot'} ${capability}`, () => {
        expect(can(role, capability as Capability, inhouse)).toBe(row[i]);
      });
    });
  }

  it('hides In-House capabilities until the feature is on', () => {
    expect(can('admin', 'policy.manage')).toBe(false);
    expect(can('manager', 'case.bank_allocate', { inhouse: { enabled: false } })).toBe(false);
    expect(capabilitiesFor('admin')).not.toContain('case.inhouse_lifecycle');
  });

  it('gives internal roles nothing on the partner side', () => {
    expect(capabilitiesFor('super_admin', inhouse)).toEqual([]);
  });

  it('requires MFA only for Admin and Manager', () => {
    expect(PARTNER_ROLES.filter(requiresMfa)).toEqual(['admin', 'manager']);
  });
});
