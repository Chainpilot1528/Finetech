import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTNER_ROLES, type PartnerRole } from '@vittora/shared-kernel';
import { v7 as uuid } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type Capability, can } from '../src/modules/identity/domain/permissions.js';
import { client, createPartner, createUser, harness, signedIn, type Client, type Harness } from './helpers.js';

/** The matrix is generated from the OpenAPI spec: a new endpoint is covered the moment it is listed (§14.8). */
const spec = parse(readFileSync(join(import.meta.dirname, '../../../packages/api-contract/openapi.yaml'), 'utf8'));
const operations = Object.entries<Record<string, { 'x-access': string }>>(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({ method, path, access: op['x-access'] })),
);

let h: Harness;
const sessions = {} as Record<PartnerRole, Client>;
let otherTenantUser: string;
let reviewer: Client;
let finance: Client;

beforeAll(async () => {
  h = await harness();
  const pid = await createPartner(h.db);
  for (const role of PARTNER_ROLES) {
    const u = await createUser(h.db, pid, role);
    sessions[role] = await signedIn(h, u.email);
  }
  otherTenantUser = (await createUser(h.db, await createPartner(h.db), 'viewer')).id;
  reviewer = await signedIn(h, (await createUser(h.db, null, 'kyc_reviewer')).email, 'ops');
  finance = await signedIn(h, (await createUser(h.db, null, 'finance')).email, 'ops');
});
afterAll(() => h.close());

const call = (c: Client, op: { method: string; path: string }, id: string) => {
  const url = op.path.replace('{id}', id).replace(/\{\w+\}/g, 'pan');
  if (op.method === 'get') return c.get(url);
  return op.method === 'patch' ? c.patch(url, {}) : c.post(url, {});
};

describe('contract', () => {
  it('every route in the app is in the spec, and every spec path is in the app', () => {
    const stack = h.app.getHttpAdapter().getInstance().router.stack;
    const routes = stack
      .filter((l: { route?: unknown }) => l.route)
      .flatMap((l: { route: { path: string; methods: Record<string, boolean> } }) =>
        Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`),
      )
      .filter((r: string) => r.includes('/api/v1'))
      .map((r: string) => r.replace('/api/v1', '').replace(/:(\w+)/g, '{$1}'))
      .sort();
    expect(routes).toEqual(operations.map((o) => `${o.method} ${o.path}`).sort());
  });
});

describe('every endpoint × anonymous', () => {
  for (const op of operations) {
    it(`${op.method.toUpperCase()} ${op.path} (${op.access})`, async () => {
      const res = await call(await client(h), op, uuid());
      if (op.access === 'public') expect(res.status).not.toBe(401);
      else expect(res.status).toBe(401);
    });
  }
});

describe('every protected endpoint × every role', () => {
  const capabilityOps = operations.filter((o) => o.access.includes('.'));
  for (const op of capabilityOps) {
    for (const role of PARTNER_ROLES) {
      const allowed = can(role, op.access as Capability);
      it(`${role} ${allowed ? 'may' : 'may not'} ${op.method.toUpperCase()} ${op.path}`, async () => {
        const res = await call(sessions[role], op, uuid());
        if (allowed) expect(res.status).not.toBe(403);
        else expect(res.status).toBe(403);
      });
    }
  }
});

describe('every capability endpoint × internal staff', () => {
  for (const op of operations.filter((o) => o.access.includes('.'))) {
    const opsRoute = op.path.startsWith('/ops/');
    it(`KYC reviewer ${opsRoute ? 'may' : 'may not'} ${op.method.toUpperCase()} ${op.path}`, async () => {
      const res = await call(reviewer, op, uuid());
      if (opsRoute) expect(res.status).not.toBe(403);
      else expect(res.status).toBe(403);
    });
    it(`finance ${can('finance', op.access as Capability) ? 'may' : 'may not'} ${op.method.toUpperCase()} ${op.path}`, async () => {
      const res = await call(finance, op, uuid());
      if (can('finance', op.access as Capability)) expect(res.status).not.toBe(403);
      else expect(res.status).toBe(403);
    });
  }
});

describe('every id-based endpoint × another tenant', () => {
  for (const op of operations.filter((o) => o.path.includes('{id}'))) {
    for (const role of PARTNER_ROLES) {
      it(`${role} gets no 2xx on another tenant via ${op.path}`, async () => {
        const res = await call(sessions[role], op, otherTenantUser);
        expect(res.status).toBeGreaterThanOrEqual(400);
      });
    }
  }
});
