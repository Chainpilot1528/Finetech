'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type DraftData, EMPLOYMENT_TYPES, type FieldSchema, PRODUCTS, STEPS, estimatedEmi, foirPercent, ltvPercent, validateStep,
} from '@vittora/product-schemas';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api, unwrap, uploadFile } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, Field, Select, Skeleton } from '@/shared/ui';

type Errors = Record<string, string>;
const w = t.wizard;

const numberOrUndefined = (v: string) => (v === '' ? undefined : Number(v));
const shown = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function Wizard({ draftId, onDone }: { draftId: string; onDone: (c: { id: string; caseNo: string }) => void }) {
  const queries = useQueryClient();
  const draft = useQuery({
    queryKey: ['draft', draftId],
    queryFn: () => unwrap(api.GET('/cases/drafts/{id}', { params: { path: { id: draftId } } })),
    // While waiting on the customer, keep checking so consent appears without a reload.
    refetchInterval: (q) => (q.state.data?.consent === 'sent' ? 4000 : false),
  });
  const products = useQuery({ queryKey: ['products'], queryFn: () => unwrap(api.GET('/catalogue/products')) });

  const [step, setStep] = useState(0);
  const [data, setData] = useState<DraftData | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [duplicate, setDuplicate] = useState(false);

  useEffect(() => {
    if (draft.data && !data) setData(draft.data.data as DraftData);
  }, [draft.data, data]);

  const productCode = data?.setup?.product ?? '';
  const lenders = useQuery({
    queryKey: ['lenders', productCode],
    enabled: !!productCode,
    queryFn: () => unwrap(api.GET('/lenders', { params: { query: { product: productCode } } })),
  });

  if (!draft.data || !data) return <Skeleton className="h-96" />;
  const product = PRODUCTS[productCode];
  const current = STEPS[step]!;

  function set<K extends keyof DraftData>(section: K, field: string, value: unknown) {
    setData((d) => ({ ...d, [section]: { ...d?.[section], [field]: value } }));
  }

  async function save(): Promise<boolean> {
    const stepErrors = validateStep(current, data!, new Date());
    if (current !== 'documents' && Object.keys(stepErrors).length) {
      setErrors(stepErrors);
      return false;
    }
    setBusy('save');
    setMessage('');
    try {
      const latest = await unwrap(api.GET('/cases/drafts/{id}', { params: { path: { id: draftId } } }));
      const saved = await unwrap(api.PATCH('/cases/drafts/{id}', {
        params: { path: { id: draftId } },
        body: { version: latest.version, data: { [current]: data![current] } },
      }));
      queries.setQueryData(['draft', draftId], saved);
      setData(saved.data as DraftData);
      setErrors({});
      return true;
    } catch (err) {
      setMessage((err as Error).message);
      if (err instanceof ApiError) setErrors(err.fields);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function next() {
    if (await save()) {
      setStep(step + 1);
      window.scrollTo({ top: 0 });
    }
  }

  function pickProduct(code: string) {
    if (productCode && code !== productCode && data?.details && !window.confirm(w.changeProduct)) return;
    setData((d) => ({ ...d, setup: { product: code } }));
  }

  async function upload(code: string, file: File) {
    setBusy(code);
    setMessage('');
    try {
      await uploadFile(`/cases/drafts/${draftId}/documents/${code}`, file);
      await draft.refetch();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function sendConsent() {
    if (!(await save())) return;
    setBusy('consent');
    try {
      await unwrap(api.POST('/cases/drafts/{id}/consent-requests', { params: { path: { id: draftId } } }));
      await draft.refetch();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function submit(confirmDuplicate = false) {
    const stepErrors = validateStep('documents', data!, new Date());
    if (Object.keys(stepErrors).length) return setErrors(stepErrors);
    if (!(await save())) return;
    setBusy('submit');
    setMessage('');
    try {
      const created = await unwrap(api.POST('/cases/drafts/{id}/submit', {
        params: { path: { id: draftId }, header: { 'Idempotency-Key': draftId } },
        body: { confirmDuplicate },
      }));
      onDone(created);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DUPLICATE_CASE') setDuplicate(true);
      else {
        setMessage((err as Error).message);
        if (err instanceof ApiError) setErrors(err.fields);
      }
    } finally {
      setBusy('');
    }
  }

  const a = data.applicant ?? {};
  const loan = data.loan ?? {};
  const income = data.income ?? {};
  const collateralValue = product?.valueField ? Number(data.details?.[product.valueField]) : 0;
  const ltv = collateralValue > 0 && loan.amount ? ltvPercent(loan.amount, collateralValue) : null;
  const foir = loan.amount && loan.tenureMonths && income.monthlyIncome
    ? foirPercent(income.existingEmi ?? 0, estimatedEmi(loan.amount, loan.tenureMonths), income.monthlyIncome)
    : null;
  const uploaded = new Map(draft.data.documents.map((d) => [d.docType, d.fileName]));
  const consent = draft.data.consent;

  const applicantField = (name: keyof typeof a, label: string, extra: object = {}) => (
    <Field label={label} value={shown(a[name])} error={errors[name]} onChange={(e) => set('applicant', name, e.target.value)} {...extra} />
  );

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{w.title}</h1>
      <ol className="flex gap-1" aria-label="Progress">
        {w.steps.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} className="flex-1">
            <div className={`h-1.5 rounded ${i <= step ? 'bg-brand' : 'bg-line'}`} />
            <span className={`mt-1 hidden text-xs sm:block ${i === step ? 'font-semibold text-ink' : 'text-muted'}`}>{label}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm font-semibold sm:hidden">{step + 1}. {w.steps[step]}</p>
      {message && <Alert>{message}</Alert>}

      <section className="space-y-4 rounded-xl border border-line bg-white p-5">
        {current === 'setup' && (
          <>
            <div>
              <p className="mb-2 text-sm font-medium">{w.caseType}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border-2 border-brand p-3">
                  <p className="text-sm font-semibold">{w.openMarket}</p>
                  <p className="text-xs text-muted">{w.openMarketHelp}</p>
                </div>
                <div aria-disabled className="rounded-lg border border-line p-3 opacity-50">
                  <p className="text-sm font-semibold">{w.inHouse}</p>
                  <p className="text-xs text-muted">{w.inHouseHelp}</p>
                </div>
              </div>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{w.product}</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {products.data?.data.map((p) => (
                  <label key={p.code} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm ${productCode === p.code ? 'border-brand bg-brand/5' : 'border-line'}`}>
                    <input type="radio" name="product" className="accent-brand" checked={productCode === p.code} onChange={() => pickProduct(p.code)} />
                    {p.name}
                  </label>
                ))}
              </div>
              {errors.product && <p className="mt-1 text-sm text-red-700">{errors.product}</p>}
              {products.data?.data.length === 0 && <Alert tone="info">{w.noProducts}</Alert>}
            </fieldset>
            {product && (
              <>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium">{w.loanType}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {product.loanTypes.map((l) => (
                      <label key={l.code} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${data.setup?.loanType === l.code ? 'border-brand bg-brand/5' : 'border-line'}`}>
                        <input type="radio" name="loanType" className="mt-0.5 accent-brand" checked={data.setup?.loanType === l.code} onChange={() => set('setup', 'loanType', l.code)} />
                        <span><span className="block text-sm font-medium">{l.label}</span><span className="block text-xs text-muted">{l.help}</span></span>
                      </label>
                    ))}
                  </div>
                  {errors.loanType && <p className="mt-1 text-sm text-red-700">{errors.loanType}</p>}
                </fieldset>
                <Select label={w.lender} placeholder={w.chooseLender} value={data.setup?.lenderId ?? ''} error={errors.lenderId}
                  options={(lenders.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
                  onChange={(e) => set('setup', 'lenderId', e.target.value)} />
                <Alert tone="info">{w.notice}</Alert>
              </>
            )}
          </>
        )}

        {current === 'applicant' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {applicantField('fullName', w.fullName, { autoComplete: 'off' })}
            {applicantField('email', w.email, { type: 'email', autoComplete: 'off' })}
            {applicantField('phone', w.phone, { inputMode: 'numeric', maxLength: 10 })}
            <Field label={w.pan} value={shown(a.pan)} error={errors.pan} maxLength={10} onChange={(e) => set('applicant', 'pan', e.target.value.toUpperCase())} />
            {applicantField('aadhaarLast4', w.aadhaar, { inputMode: 'numeric', maxLength: 4, hint: w.aadhaarHint })}
            {applicantField('dob', w.dob, { type: 'date' })}
            <div className="sm:col-span-2">{applicantField('address', w.address)}</div>
            {applicantField('pincode', w.pincode, { inputMode: 'numeric', maxLength: 6 })}
            {applicantField('city', w.city)}
            {applicantField('state', w.state)}
          </div>
        )}

        {current === 'details' && product && (
          Object.keys(product.details.properties).length === 0 ? (
            <p className="text-sm text-muted">{w.noDetails}</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(product.details.properties).map(([name, schema]) => (
                <SchemaField key={name} name={name} schema={schema} value={data.details?.[name]} error={errors[name]} onChange={(v) => set('details', name, v)} />
              ))}
            </div>
          )
        )}

        {current === 'loan' && (
          <>
            <Field label={w.amount} inputMode="numeric" value={shown(loan.amount)} error={errors.amount} onChange={(e) => set('loan', 'amount', numberOrUndefined(e.target.value))} />
            <Field label={w.tenure} inputMode="numeric" value={shown(loan.tenureMonths)} error={errors.tenureMonths} onChange={(e) => set('loan', 'tenureMonths', numberOrUndefined(e.target.value))} />
            <Field label={w.purpose} value={shown(loan.purpose)} onChange={(e) => set('loan', 'purpose', e.target.value)} />
            {ltv !== null && <Alert tone={ltv > 85 ? 'error' : 'info'}>{w.ltv}: {ltv}%{ltv > 85 ? `. ${w.ltvHigh}` : ''}</Alert>}
          </>
        )}

        {current === 'income' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label={w.employment} placeholder={w.choose} value={income.employmentType ?? ''} error={errors.employmentType}
              options={EMPLOYMENT_TYPES.map((e) => ({ value: e, label: w.employmentTypes[e]! }))}
              onChange={(e) => set('income', 'employmentType', e.target.value)} />
            <Field label={w.income} inputMode="numeric" value={shown(income.monthlyIncome)} error={errors.monthlyIncome} onChange={(e) => set('income', 'monthlyIncome', numberOrUndefined(e.target.value))} />
            <Field label={w.company} value={shown(income.companyName)} onChange={(e) => set('income', 'companyName', e.target.value)} />
            <Field label={w.experience} inputMode="numeric" value={shown(income.workExperienceYears)} onChange={(e) => set('income', 'workExperienceYears', numberOrUndefined(e.target.value))} />
            <Field label={w.existingEmi} inputMode="numeric" value={shown(income.existingEmi)} error={errors.existingEmi} onChange={(e) => set('income', 'existingEmi', numberOrUndefined(e.target.value))} />
            <Field label={w.cibil} inputMode="numeric" value={shown(income.cibilScore)} error={errors.cibilScore} onChange={(e) => set('income', 'cibilScore', numberOrUndefined(e.target.value))} />
            {foir !== null && <div className="sm:col-span-2"><Alert tone="info">{w.foir}: {foir}%. {w.foirNote}</Alert></div>}
          </div>
        )}

        {current === 'documents' && (
          <>
            <h2 className="font-semibold">{w.docsTitle}</h2>
            <p className="text-sm text-muted">{t.kyc.formats}</p>
            <ul className="divide-y divide-line">
              {draft.data.requiredDocuments.map((d) => (
                <li key={d.code} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{d.label}</p>
                    <p className="truncate text-xs text-muted">{uploaded.get(d.code) ?? (d.required ? w.required : w.optional)}</p>
                    {errors[d.code] && <p className="text-sm text-red-700">{errors[d.code]}</p>}
                  </div>
                  <label className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-4 text-sm font-semibold ${busy === d.code ? 'opacity-60' : ''}`}>
                    {busy === d.code ? t.common.loading : uploaded.has(d.code) ? t.kyc.replace : t.kyc.upload}
                    <input type="file" className="sr-only" aria-label={`${t.kyc.upload} ${d.label}`} accept="application/pdf,image/png,image/jpeg"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void upload(d.code, file);
                      }} />
                  </label>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={!!data.documents?.aadhaarMaskedConfirmed} onChange={(e) => set('documents', 'aadhaarMaskedConfirmed', e.target.checked)} />
              {w.aadhaarConfirm}
            </label>
            {errors.aadhaarMaskedConfirmed && <p className="text-sm text-red-700">{errors.aadhaarMaskedConfirmed}</p>}

            <div className="rounded-lg bg-paper p-4">
              <h2 className="font-semibold">{w.consentTitle}</h2>
              <p className="mt-1 text-sm" data-testid="consent-status">
                {consent === 'given' ? w.consentGiven : consent === 'sent' ? w.consentSent : w.consentNone}
              </p>
              {consent !== 'given' && (
                <Button ghost className="mt-3" busy={busy === 'consent'} onClick={sendConsent}>{consent === 'sent' ? w.consentResend : w.consentSend}</Button>
              )}
            </div>
            {duplicate && (
              <Alert>
                {w.duplicate}{' '}
                <button type="button" className="font-semibold underline" onClick={() => submit(true)}>{w.duplicateConfirm}</button>
              </Alert>
            )}
          </>
        )}
      </section>

      <div className="flex justify-between gap-3">
        <Button ghost disabled={step === 0} onClick={() => { setErrors({}); setStep(step - 1); }}>{w.back}</Button>
        {current === 'documents' ? (
          <Button busy={busy === 'submit'} disabled={consent !== 'given'} onClick={() => submit()}>{w.submit}</Button>
        ) : (
          <Button busy={busy === 'save'} onClick={next}>{w.next}</Button>
        )}
      </div>
      <p className="text-center text-xs"><Link href="/app/dashboard" className="text-muted underline">{t.nav.dashboard}</Link></p>
    </div>
  );
}

function SchemaField({ name, schema, value, error, onChange }: {
  name: string; schema: FieldSchema; value: unknown; error?: string; onChange: (v: string | number | undefined) => void;
}) {
  if (schema.enum) {
    return (
      <Select label={schema.title} placeholder={w.choose} value={shown(value)} error={error}
        options={schema.enum.map((v) => ({ value: v, label: schema['x-labels']?.[v] ?? v }))}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  const numeric = schema.type === 'integer';
  return (
    <Field label={schema.title} name={name} hint={schema.description} error={error} value={shown(value)} inputMode={numeric ? 'numeric' : undefined}
      onChange={(e) => {
        if (numeric) return onChange(numberOrUndefined(e.target.value));
        onChange(schema.pattern ? e.target.value.toUpperCase().replace(/\s/g, '') : e.target.value);
      }} />
  );
}
