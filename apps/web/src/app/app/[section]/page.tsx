import { t } from '@/shared/messages';

export default function ComingLaterPage() {
  return (
    <div className="rounded-xl border border-dashed border-line bg-white p-10 text-center">
      <h1 className="font-semibold">{t.soon.title}</h1>
      <p className="mt-1 text-sm text-muted">{t.soon.body}</p>
    </div>
  );
}
