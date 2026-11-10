'use client';

import { useState } from 'react';
import { api, unwrap } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Badge, Button, Card, Field, fieldValue } from '@/shared/ui';

type Billing = Awaited<ReturnType<typeof load>>;
const load = (id: string) => unwrap(api.GET('/ops/partners/{id}/billing', { params: { path: { id } } }));

/** The real numbers load only when someone asks, because each look is audited. */
export function BillingReview({ partnerId }: { partnerId: string }) {
  const [billing, setBilling] = useState<Billing>();
  const [error, setError] = useState('');

  async function show() {
    setError('');
    try {
      setBilling(await load(partnerId));
    } catch {
      setError(t.ops.noBilling);
    }
  }

  async function decide(decision: string, note: string) {
    setError('');
    try {
      await unwrap(api.POST('/ops/partners/{id}/billing/decision', { params: { path: { id: partnerId } }, body: { decision, ...(note ? { note } : {}) } }));
      await show();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card title={t.ops.billing}>
      {error && <Alert>{error}</Alert>}
      {!billing && <Button ghost onClick={show}>{t.ops.showBilling}</Button>}
      {billing && (
        <div className="space-y-3 text-sm">
          <Badge status={billing.verificationStatus} label={t.settings.verification[billing.verificationStatus]} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-muted">{t.settings.gstin}</dt><dd>{billing.gstin ?? '–'}</dd>
            <dt className="text-muted">{t.settings.pan}</dt><dd>{billing.pan}</dd>
            <dt className="text-muted">{t.settings.bankAccount}</dt><dd>{billing.bankAccount}</dd>
            <dt className="text-muted">{t.settings.ifsc}</dt><dd>{billing.ifsc}</dd>
            <dt className="text-muted">{t.settings.bankName}</dt><dd>{billing.bankName}, {billing.branch}</dd>
          </dl>
          {billing.verificationStatus === 'pending' && (
            <form className="space-y-2" onSubmit={(e) => {
              e.preventDefault();
              const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
              decide(submitter?.value ?? 'verified', fieldValue(e, 'note'));
            }}>
              <Field label={t.ops.billingNote} name="note" />
              <div className="flex gap-2">
                <Button type="submit" value="verified">{t.ops.verify}</Button>
                <Button type="submit" ghost value="rejected">{t.ops.reject}</Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
