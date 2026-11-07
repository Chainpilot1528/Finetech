'use client';

import { useQuery } from '@tanstack/react-query';
import { notFound } from 'next/navigation';
import { t } from '@/shared/messages';
import { Button, ErrorState, Skeleton } from '@/shared/ui';

interface Mail { to: string; subject: string; text: string; at: string }

/** Linkify the only URL our test emails contain. */
function Body({ text }: { text: string }) {
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  if (!url) return <p className="whitespace-pre-wrap text-sm">{text}</p>;
  const [before, after] = text.split(url);
  return <p className="whitespace-pre-wrap break-all text-sm">{before}<a className="text-brand underline" href={url}>{url}</a>{after}</p>;
}

export default function DevInboxPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const mail = useQuery({
    queryKey: ['dev-mail'],
    refetchInterval: 2000,
    queryFn: async () => {
      const res = await fetch('/api/v1/dev/mail');
      if (!res.ok) throw new Error('unavailable');
      return (await res.json()).data as Mail[];
    },
  });
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t.inbox.title}</h1>
          <p className="text-sm text-muted">{t.inbox.note}</p>
        </div>
        <Button ghost onClick={() => mail.refetch()}>{t.common.retry}</Button>
      </div>
      {mail.isPending && <Skeleton />}
      {mail.isError && <ErrorState onRetry={() => mail.refetch()} />}
      {mail.data?.length === 0 && <p className="text-sm text-muted">{t.inbox.empty}</p>}
      {mail.data?.map((m) => (
        <article key={m.at + m.to} className="rounded-xl border border-line bg-white p-4">
          <p className="font-semibold">{m.subject}</p>
          <p className="mb-2 text-xs text-muted">To {m.to}</p>
          <Body text={m.text} />
        </article>
      ))}
    </main>
  );
}
