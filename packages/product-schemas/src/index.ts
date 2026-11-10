import catalogue from '../products/catalogue.json';
import loanAgainstCar from '../products/loan_against_car.v1.json';
import personal from '../products/personal.v1.json';
import usedCar from '../products/used_car.v1.json';

/** One set of rules, used by the wizard and re-checked by the API (§14.5). */
export interface FieldSchema {
  type: 'string' | 'integer';
  title: string;
  description?: string;
  enum?: string[];
  'x-labels'?: Record<string, string>;
  /** Identifies a person or their property. Encrypted at rest and never logged (SEC-03, §9.3). */
  'x-sensitive'?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}
export interface DocumentRule {
  code: string;
  label: string;
  required: boolean;
  loanTypes?: string[];
  employment?: string[];
}
export interface Product {
  code: string;
  name: string;
  version: number;
  secured: boolean;
  valueField?: string;
  collateralField?: string;
  loanTypes: { code: string; label: string; help: string }[];
  details: { type: 'object'; required: string[]; properties: Record<string, FieldSchema> };
  documents: DocumentRule[];
  /** Common documents this product does not ask for (for example salary slips on a business loan). */
  excludeCommonDocuments?: string[];
  limits: {
    minAmount: number;
    maxAmount: number;
    minTenure: number;
    maxTenure: number;
    /** Secured products: the loan can't be more than this share of the collateral value. */
    maxLtvPercent?: number;
    /** The wizard warns above this. */
    warnLtvPercent?: number;
    /** Vehicle loans: the vehicle's age when the loan ends, in years (GAP-04). */
    maxVehicleAgeAtMaturityYears?: number;
    vehicleYearField?: string;
  };
}

/**
 * The product catalogue (ARCH-03). Each product is defined once, in its definition file; everything
 * else (the wizard, the API's checks, the sign-up list) is derived from here. Adding a product is a
 * new definition file and one line in catalogue.json.
 */
const DEFINITIONS: Record<string, Product> = Object.fromEntries(
  [usedCar, loanAgainstCar, personal].map((p) => [p.code, p as Product]),
);

export const PRODUCTS: Record<string, Product> = Object.fromEntries(
  catalogue.products.filter((c) => c.definition).map((c) => [c.code, DEFINITIONS[c.code]!]),
);

/** Every product a partner can say they deal in at sign-up, built or not. */
export const REGISTRATION_PRODUCTS: { code: string; name: string }[] = catalogue.products.map((c) => ({
  code: c.code,
  name: PRODUCTS[c.code]?.name ?? (c as { name?: string }).name ?? c.code,
}));

/** Display name for any product code. */
export const productName = (code: string) => REGISTRATION_PRODUCTS.find((p) => p.code === code)?.name ?? code;

/** Detail fields that must be encrypted before they are stored. */
export function sensitiveFields(product: Product): string[] {
  return Object.entries(product.details.properties).filter(([, f]) => f['x-sensitive']).map(([k]) => k);
}

export const EMPLOYMENT_TYPES = ['salaried', 'self_employed', 'business'] as const;

const COMMON_DOCUMENTS: DocumentRule[] = [
  { code: 'pan_card', label: 'PAN card', required: true },
  { code: 'aadhaar_masked', label: 'Masked Aadhaar (first 8 digits hidden)', required: true },
  { code: 'address_proof', label: 'Address proof', required: true },
  { code: 'bank_statement', label: 'Bank statement (6 months)', required: true },
  { code: 'salary_slips', label: 'Salary slips (3 months)', required: true, employment: ['salaried'] },
  { code: 'itr', label: 'ITR or Form 16', required: true, employment: ['self_employed', 'business'] },
];

export function documentsFor(product: Product, loanType?: string, employment?: string): DocumentRule[] {
  const common = COMMON_DOCUMENTS.filter((d) => !product.excludeCommonDocuments?.includes(d.code));
  return [...common, ...product.documents].filter(
    (d) =>
      (!d.loanTypes || (loanType !== undefined && d.loanTypes.includes(loanType))) &&
      (!d.employment || (employment !== undefined && d.employment.includes(employment))),
  );
}

export interface DraftData {
  setup?: { product?: string; loanType?: string; lenderId?: string };
  applicant?: {
    fullName?: string; email?: string; phone?: string; pan?: string; aadhaarLast4?: string; dob?: string;
    address?: string; pincode?: string; city?: string; state?: string;
  };
  details?: Record<string, string | number | undefined>;
  loan?: { amount?: number; tenureMonths?: number; purpose?: string };
  income?: {
    employmentType?: string; monthlyIncome?: number; companyName?: string; workExperienceYears?: number;
    existingEmi?: number; cibilScore?: number;
  };
  documents?: { aadhaarMaskedConfirmed?: boolean };
}

export type Errors = Record<string, string>;
export const STEPS = ['setup', 'applicant', 'details', 'loan', 'income', 'documents'] as const;
export type Step = (typeof STEPS)[number];

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PHONE = /^[6-9][0-9]{9}$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUIRED = 'This field is required.';

export function ageOn(dob: string, today: Date): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = today.getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < d.getUTCMonth() ||
    (today.getUTCMonth() === d.getUTCMonth() && today.getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function validateField(schema: FieldSchema, value: unknown): string | null {
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return 'Enter a whole number.';
    if (schema.minimum !== undefined && value < schema.minimum) return `Must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `Must be at most ${schema.maximum}.`;
    return null;
  }
  if (typeof value !== 'string') return REQUIRED;
  if (schema.enum && !schema.enum.includes(value)) return 'Choose one of the options.';
  if (schema.minLength !== undefined && value.length < schema.minLength) return 'This is too short.';
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return 'This is too long.';
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return schema.description ?? 'This format is not valid.';
  return null;
}

export function validateStep(step: Step, data: DraftData, today: Date): Errors {
  const e: Errors = {};
  const product = PRODUCTS[data.setup?.product ?? ''];

  if (step === 'setup') {
    if (!product) e.product = REQUIRED;
    else if (!product.loanTypes.some((l) => l.code === data.setup?.loanType)) e.loanType = REQUIRED;
    if (!data.setup?.lenderId) e.lenderId = REQUIRED;
  }

  if (step === 'applicant') {
    const a = data.applicant ?? {};
    if (!a.fullName || a.fullName.trim().length < 2) e.fullName = REQUIRED;
    if (a.email && !EMAIL.test(a.email)) e.email = 'Enter a valid email.';
    if (!a.phone || !PHONE.test(a.phone)) e.phone = 'Enter a 10-digit mobile number.';
    if (!a.pan || !PAN.test(a.pan)) e.pan = 'Enter a valid PAN, like ABCDE1234F.';
    if (!a.aadhaarLast4 || !/^[0-9]{4}$/.test(a.aadhaarLast4)) e.aadhaarLast4 = 'Enter only the last 4 digits.';
    if (!a.dob || Number.isNaN(Date.parse(a.dob))) e.dob = REQUIRED;
    else if (ageOn(a.dob, today) < 18) e.dob = 'The primary applicant must be 18 or older.';
    if (!a.address || a.address.trim().length < 5) e.address = REQUIRED;
    if (!a.pincode || !PINCODE.test(a.pincode)) e.pincode = 'Enter a 6-digit pincode.';
    if (!a.city) e.city = REQUIRED;
    if (!a.state) e.state = REQUIRED;
  }

  if (step === 'details' && product) {
    for (const [name, schema] of Object.entries(product.details.properties)) {
      const value = data.details?.[name];
      if (value === undefined || value === '') {
        if (product.details.required.includes(name)) e[name] = REQUIRED;
        continue;
      }
      const problem = validateField(schema, value);
      if (problem) e[name] = problem;
    }
  }

  if (step === 'loan' && product) {
    const { amount, tenureMonths } = data.loan ?? {};
    const { minAmount, maxAmount, minTenure, maxTenure } = product.limits;
    if (!Number.isInteger(amount) || amount! < minAmount || amount! > maxAmount) {
      e.amount = `Enter an amount from ₹${minAmount.toLocaleString('en-IN')} to ₹${maxAmount.toLocaleString('en-IN')}.`;
    }
    if (!Number.isInteger(tenureMonths) || tenureMonths! < minTenure || tenureMonths! > maxTenure) {
      e.tenureMonths = `Enter ${minTenure} to ${maxTenure} months.`;
    }
    // Limits from the product definition, checked here so the API enforces them too (GAP-04).
    const l = product.limits;
    const value = product.valueField ? Number(data.details?.[product.valueField]) : NaN;
    if (!e.amount && l.maxLtvPercent && Number.isFinite(value) && value > 0 && ltvPercent(amount!, value) > l.maxLtvPercent) {
      e.amount = `The loan can't be more than ${l.maxLtvPercent}% of the valuation.`;
    }
    const year = l.vehicleYearField ? Number(data.details?.[l.vehicleYearField]) : NaN;
    if (!e.tenureMonths && l.maxVehicleAgeAtMaturityYears && Number.isInteger(year)) {
      const ageAtEnd = today.getUTCFullYear() - year + tenureMonths! / 12;
      if (ageAtEnd > l.maxVehicleAgeAtMaturityYears) {
        e.tenureMonths = `The car would be over ${l.maxVehicleAgeAtMaturityYears} years old when the loan ends. Choose a shorter tenure.`;
      }
    }
  }

  if (step === 'income') {
    const i = data.income ?? {};
    if (!i.employmentType || !(EMPLOYMENT_TYPES as readonly string[]).includes(i.employmentType)) e.employmentType = REQUIRED;
    if (!Number.isInteger(i.monthlyIncome) || i.monthlyIncome! <= 0) e.monthlyIncome = REQUIRED;
    if (i.existingEmi !== undefined && (!Number.isInteger(i.existingEmi) || i.existingEmi < 0)) e.existingEmi = 'Enter a whole number.';
    if (i.cibilScore !== undefined && (!Number.isInteger(i.cibilScore) || i.cibilScore < 300 || i.cibilScore > 900)) {
      e.cibilScore = 'Enter a score from 300 to 900.';
    }
  }

  if (step === 'documents' && !data.documents?.aadhaarMaskedConfirmed) {
    e.aadhaarMaskedConfirmed = 'Confirm that the Aadhaar copy is masked.';
  }
  return e;
}

export function validateAll(data: DraftData, today: Date): Errors {
  return Object.assign({}, ...STEPS.map((s) => validateStep(s, data, today)));
}

/** Loan to value, in percent, for secured products. */
export function ltvPercent(amount: number, collateralValue: number): number {
  return Math.round((amount / collateralValue) * 1000) / 10;
}

/** Estimated monthly instalment at an assumed yearly rate. An estimate only, shown as such. */
export function estimatedEmi(amount: number, tenureMonths: number, annualRatePercent = 12): number {
  const r = annualRatePercent / 12 / 100;
  const factor = (1 + r) ** tenureMonths;
  return Math.round((amount * r * factor) / (factor - 1));
}

export function foirPercent(existingEmi: number, newEmi: number, monthlyIncome: number): number {
  return Math.round(((existingEmi + newEmi) / monthlyIncome) * 1000) / 10;
}

export const CONSENT_TEXT_VERSION = 'draft-1';
export const CONSENT_TEXT =
  'I allow this loan partner and Vittora to use my personal details and documents to process my loan application and share them with the lender named here. I understand Vittora is a loan distribution service, not the lender. I can ask for my data to be corrected or deleted by contacting the grievance officer.';

export const AGREEMENT_VERSION = 'draft-1';
export const AGREEMENT_TEXT = `DRAFT FOR TESTING ONLY. This text must be replaced by counsel before launch.

1. You act as a channel partner and only submit genuine applications.
2. You obtain documents lawfully and never store full Aadhaar numbers.
3. Commission is paid per disbursal, under the rate card in force, and can be clawed back on reversal.
4. You keep customer data confidential and report any leak immediately.`;

/** Partner KYC documents (§4.2). One rule, used by the KYC page and re-checked by the API (ARCH-05). */
export const KYC_TYPES = ['pan', 'gst_certificate', 'address_proof', 'bank_details'] as const;
export type KycType = (typeof KYC_TYPES)[number];
/** The GST certificate applies only to GST-registered partners, so it isn't compulsory here (see D-015). */
export const REQUIRED_KYC: KycType[] = ['pan', 'address_proof', 'bank_details'];

/** Every required document is present and none is rejected. */
export function kycDocumentsReady(docs: { type: string; status: string }[]): boolean {
  const present = new Set(docs.filter((d) => d.status !== 'rejected').map((d) => d.type));
  return REQUIRED_KYC.every((t) => present.has(t)) && !docs.some((d) => d.status === 'rejected');
}
