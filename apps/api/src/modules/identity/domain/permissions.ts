import type { Role } from '@vittora/shared-kernel';

/** Capabilities from PRD §7.1. Anything not listed for a role is denied. */
export const CAPABILITIES = [
  'dashboard.view',
  'case.create',
  'case.view_all',
  'case.view_own',
  'case.note',
  'case.fieldwork',
  'case.inhouse_lifecycle',
  'case.bank_allocate',
  'case.bureau_pull',
  'case.export',
  'pii.reveal',
  'policy.manage',
  'users.manage',
  'invoices.manage',
  'settings.view',
  'settings.edit',
  'notifications.view',
  'kyc.manage',
  'kyc.review',
  'partners.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<Role, readonly Capability[]> = {
  admin: [
    'dashboard.view', 'case.create', 'case.view_all', 'case.note', 'case.fieldwork',
    'case.inhouse_lifecycle', 'case.bank_allocate', 'case.bureau_pull', 'case.export', 'pii.reveal',
    'policy.manage', 'users.manage', 'invoices.manage', 'settings.view', 'settings.edit',
    'notifications.view', 'kyc.manage',
  ],
  manager: [
    'dashboard.view', 'case.create', 'case.view_all', 'case.note', 'case.fieldwork',
    'case.inhouse_lifecycle', 'case.bank_allocate', 'case.bureau_pull', 'case.export', 'pii.reveal',
    'policy.manage', 'settings.view', 'notifications.view',
  ],
  executive: [
    'dashboard.view', 'case.create', 'case.view_own', 'case.note', 'case.fieldwork',
    'case.bureau_pull', 'pii.reveal', 'settings.view', 'notifications.view',
  ],
  viewer: ['dashboard.view', 'case.view_all', 'settings.view', 'notifications.view'],
  ops_agent: ['partners.view'],
  ops_lead: ['partners.view', 'kyc.review'],
  kyc_reviewer: ['partners.view', 'kyc.review'],
  finance: ['partners.view'],
  super_admin: ['partners.view', 'kyc.review'],
};

/** Capabilities that also need a feature switched on for the partner (§7.1 †). */
const FEATURE_GATED: Partial<Record<Capability, string>> = {
  'policy.manage': 'inhouse',
  'case.inhouse_lifecycle': 'inhouse',
  'case.bank_allocate': 'inhouse',
};

export type Features = Record<string, { enabled?: boolean } | undefined>;

export function can(role: Role, capability: Capability, features: Features = {}): boolean {
  if (!MATRIX[role].includes(capability)) return false;
  const feature = FEATURE_GATED[capability];
  return !feature || features[feature]?.enabled === true;
}

export function capabilitiesFor(role: Role, features: Features = {}): Capability[] {
  return CAPABILITIES.filter((c) => can(role, c, features));
}

/** MFA is mandatory for Admin, Manager and every internal role (§4.1, §9.2). */
export const requiresMfa = (role: Role) => role !== 'executive' && role !== 'viewer';
