'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { kycDocumentsReady } from '@vittora/product-schemas';
import { useState } from 'react';
import { api, unwrap, uploadFile } from '@/shared/api';
import { t } from '@/shared/messages';
import { Alert, Button, ErrorState, Skeleton } from '@/shared/ui';

const TYPES = ['pan', 'gst_certificate', 'address_proof', 'bank_details'];

export default function KycPage() {
  const queries = useQueryClient();
  const kyc = useQuery({ queryKey: ['kyc'], queryFn: () => unwrap(api.GET('/kyc')) });
  const agreement = useQuery({
    queryKey: ['agreement'],
    queryFn: () => unwrap(api.GET('/partner/agreement')) as Promise<unknown> as Promise<{ version: string; text: string }>,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  async function run(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await work();
      await queries.invalidateQueries({ queryKey: ['kyc'] });
      await queries.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function view(id: string) {
    const { url } = await unwrap(api.GET('/kyc/documents/{id}/url', { params: { path: { id } } }));
    window.location.assign(url);
  }

  if (kyc.isPending) return <Skeleton className="h-96" />;
  if (kyc.isError) return <ErrorState onRetry={() => kyc.refetch()} />;
  const k = kyc.data;
  const locked = k.status === 'submitted' || k.status === 'approved';
  const ready = k.agreementAccepted && kycDocumentsReady(k.documents);

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.kyc.title}</h1>
        <p className="mt-1 text-sm text-muted">{t.kyc.subtitle}</p>
      </div>
      <Alert tone={k.status === 'approved' ? 'success' : 'info'}>{t.kyc.status[k.status]}</Alert>
      {error && <Alert>{error}</Alert>}

      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="font-semibold">{t.kyc.agreement}</h2>
        {k.agreementAccepted ? (
          <p className="mt-2 text-sm text-emerald-800">{t.kyc.accepted}</p>
        ) : (
          <>
            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-paper p-3 font-sans text-sm">{agreement.data?.text}</pre>
            <Button className="mt-3" busy={busy === 'agreement'} disabled={!agreement.data}
              onClick={() => run('agreement', () => unwrap(api.POST('/partner/agreement', { body: { version: agreement.data!.version } })))}>
              {t.kyc.accept}
            </Button>
          </>
        )}
      </section>

      <section className="rounded-xl border border-line bg-white p-5">
        <h2 className="font-semibold">{t.kyc.documents}</h2>
        <p className="text-sm text-muted">{t.kyc.formats}</p>
        <ul className="mt-3 divide-y divide-line">
          {TYPES.map((type) => {
            const doc = k.documents.find((d) => d.type === type);
            const canUpload = !locked && doc?.status !== 'approved';
            return (
              <li key={type} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t.kyc.labels[type]}{!k.required.includes(type) && <span className="text-muted"> ({t.kyc.optional})</span>}</p>
                  {doc && <p className="truncate text-xs text-muted">{doc.fileName} · {t.kyc.docStatus[doc.status]}</p>}
                  {doc?.status === 'rejected' && <p className="text-sm text-red-700">{doc.reviewerNote}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {doc && <Button ghost onClick={() => view(doc.id)}>{t.kyc.view}</Button>}
                  {canUpload && (
                    <label className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-4 text-sm font-semibold ${busy === type ? 'opacity-60' : ''}`}>
                      {busy === type ? t.common.loading : doc ? t.kyc.replace : t.kyc.upload}
                      <input type="file" className="sr-only" aria-label={`${t.kyc.upload} ${t.kyc.labels[type]}`} accept="application/pdf,image/png,image/jpeg"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) void run(type, () => uploadFile(`/kyc/documents/${type}`, file));
                        }} />
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {!locked && <Button busy={busy === 'submit'} disabled={!ready} onClick={() => run('submit', () => unwrap(api.POST('/kyc/submit')))}>{t.kyc.submit}</Button>}
    </div>
  );
}
