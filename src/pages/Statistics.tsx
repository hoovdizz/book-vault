import { FormEvent, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, BookOpen, Clock3, DollarSign, Headphones, Library, RefreshCw, Repeat2, Star, Target } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Personal = {
  totals: {
    booksCompleted: number;
    pagesRead: number;
    minutesRead: number;
    audiobookHours: number;
    readingStreakDays: number;
    averageRating: number | null;
    didNotFinish: number;
    rereads: number;
  };
  byFormat: { label: string; count: number }[];
  byGenre: { label: string; count: number }[];
  byAuthor: { label: string; count: number }[];
  byMonth: { label: string; count: number }[];
  goals: { books?: number; pages?: number; minutes?: number };
  preferredFormats: string[];
};
type Household = {
  inventory: {
    works: number;
    editions: number;
    copies: number;
    active_loans: number;
    overdue: number;
    duplicate_work_groups: number;
    previously_owned: number;
    unread_household_works: number;
    missing_series_volumes: number;
  };
  mostRead: { id: number; title: string; primary_author: string; readers: number }[];
  copiesPerOwner: { label: string; count: number }[];
  copiesPerLocation: { label: string; count: number }[];
  mostLoaned: { label: string; count: number }[];
  mostShared: { label: string; count: number }[];
  recentlyAdded: { label: string; copies: number }[];
};
type CollectionValue = {
  estimatedValue: number;
  estimatedLow: number;
  estimatedHigh: number;
  purchaseCost: number;
  totalCopies: number;
  estimatedCopies: number;
  missingEstimates: number;
  unsupportedCurrencyCopies: number;
  currencies: Record<string, number>;
};

function Bars({ rows }: { rows: { label: string; count: number }[] }) {
  const maximum = Math.max(1, ...rows.map(row => row.count));
  return (
    <div className="space-y-2">
      {rows.map(row => (
        <div key={row.label} className="grid grid-cols-[120px_1fr_40px] items-center gap-2 text-sm">
          <span className="truncate" title={row.label}>{row.label}</span>
          <span className="h-2 overflow-hidden rounded bg-muted"><span className="block h-full rounded bg-primary" style={{ width: `${row.count / maximum * 100}%` }} /></span>
          <span className="text-right text-muted-foreground">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function Statistics() {
  const queryClient = useQueryClient();
  const [goalForm, setGoalForm] = useState({ books: '', pages: '', minutes: '' });
  const [preferredFormats, setPreferredFormats] = useState<string[]>([]);
  const { data: personal, isLoading, error } = useQuery({
    queryKey: ['reading-statistics'],
    queryFn: () => api<Personal>('/api/reading/statistics'),
  });
  const { data: household } = useQuery({
    queryKey: ['household-statistics'],
    queryFn: () => api<Household>('/api/household/statistics'),
  });
  const { data: collectionValue } = useQuery({
    queryKey: ['collection-value'],
    queryFn: () => api<{ value: CollectionValue }>('/api/catalog/value'),
  });
  const [refreshingValues, setRefreshingValues] = useState(false);
  const cards = [
    ['Completed', personal?.totals.booksCompleted || 0, BookOpen],
    ['Pages read', personal?.totals.pagesRead || 0, Library],
    ['Minutes read', personal?.totals.minutesRead || 0, Clock3],
    ['Audiobook hours', personal?.totals.audiobookHours || 0, Headphones],
    ['Streak days', personal?.totals.readingStreakDays || 0, Target],
    ['Average rating', personal?.totals.averageRating?.toFixed(2) || '—', Star],
    ['Re-reads', personal?.totals.rereads || 0, Repeat2],
    ['Did not finish', personal?.totals.didNotFinish || 0, BarChart3],
  ] as const;

  useEffect(() => {
    if (!personal) return;
    setGoalForm({
      books: personal.goals.books == null ? '' : String(personal.goals.books),
      pages: personal.goals.pages == null ? '' : String(personal.goals.pages),
      minutes: personal.goals.minutes == null ? '' : String(personal.goals.minutes),
    });
    setPreferredFormats(personal.preferredFormats || []);
  }, [personal]);

  async function saveGoals(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/reading/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          goal: {
            year: new Date().getFullYear(),
            books: goalForm.books || null,
            pages: goalForm.pages || null,
            minutes: goalForm.minutes || null,
          },
          preferredFormats,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['reading-statistics'] });
      toast.success('Reading goals saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save reading goals');
    }
  }

  async function refreshValues() {
    setRefreshingValues(true);
    try {
      const result = await api<{ value: CollectionValue }>('/api/catalog/value/refresh', {
        method: 'POST',
        body: JSON.stringify({ limit: 10 }),
      });
      queryClient.setQueryData(['collection-value'], { value: result.value });
      toast.success('Updated ' + result.value.estimatedCopies + ' copy estimates');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not refresh collection values');
    } finally {
      setRefreshingValues(false);
    }
  }

  const money = (amount: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(amount || 0);

  if (isLoading) return <div className="py-16 text-center text-muted-foreground">Calculating optional statistics…</div>;
  if (error) return <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-destructive">{error instanceof Error ? error.message : 'Could not load statistics'}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold">Reading statistics</h1>
        <p className="mt-1 text-muted-foreground">Private progress and household inventory insights, calculated only when this page is opened.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map(([label, value, Icon]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <Icon className="mb-2 h-5 w-5 text-primary" />
            <p className="text-2xl font-heading font-bold">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-border bg-card p-5"><h2 className="mb-4 font-heading text-lg font-semibold">By month</h2><Bars rows={personal?.byMonth || []} /></section>
        <section className="rounded-lg border border-border bg-card p-5"><h2 className="mb-4 font-heading text-lg font-semibold">By format</h2><Bars rows={personal?.byFormat || []} /></section>
        <section className="rounded-lg border border-border bg-card p-5"><h2 className="mb-4 font-heading text-lg font-semibold">Top authors</h2><Bars rows={personal?.byAuthor || []} /></section>
        <section className="rounded-lg border border-border bg-card p-5"><h2 className="mb-4 font-heading text-lg font-semibold">By genre or tag</h2><Bars rows={personal?.byGenre || []} /></section>
        <section className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
          <h2 className="mb-4 font-heading text-lg font-semibold">Annual reading goals</h2>
          <form onSubmit={saveGoals} className="grid gap-3 sm:grid-cols-4">
            <Input aria-label="Book goal" type="number" min="0" placeholder="Books" value={goalForm.books} onChange={event => setGoalForm(current => ({ ...current, books: event.target.value }))} />
            <Input aria-label="Page goal" type="number" min="0" placeholder="Pages" value={goalForm.pages} onChange={event => setGoalForm(current => ({ ...current, pages: event.target.value }))} />
            <Input aria-label="Minute goal" type="number" min="0" placeholder="Minutes" value={goalForm.minutes} onChange={event => setGoalForm(current => ({ ...current, minutes: event.target.value }))} />
            <Button type="submit">Save goals</Button>
            <fieldset className="flex flex-wrap gap-3 sm:col-span-4">
              <legend className="mb-2 text-sm font-medium">Preferred formats</legend>
              {['physical', 'ebook', 'audiobook'].map(format => (
                <label key={format} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={preferredFormats.includes(format)}
                    onChange={event => setPreferredFormats(current => event.target.checked
                      ? [...new Set([...current, format])]
                      : current.filter(value => value !== format))}
                  />
                  {format === 'ebook' ? 'eBook' : format[0].toUpperCase() + format.slice(1)}
                </label>
              ))}
            </fieldset>
          </form>
        </section>
      </div>
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-heading text-lg font-semibold"><DollarSign className="h-5 w-5 text-primary" />Estimated collection value</h2>
            <p className="mt-1 text-sm text-muted-foreground">ISBN provider prices when available; otherwise a binding, age, and page-count estimate.</p>
          </div>
          <Button type="button" variant="outline" disabled={refreshingValues} onClick={() => void refreshValues()}>
            <RefreshCw className={'mr-2 h-4 w-4 ' + (refreshingValues ? 'animate-spin' : '')} />Update 10 estimates
          </Button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div><p className="text-2xl font-heading font-bold">{collectionValue?.value.estimatedValue == null ? '—' : money(collectionValue.value.estimatedValue)}</p><p className="text-xs text-muted-foreground">Estimated USD value</p></div>
          <div><p className="text-2xl font-heading font-bold">{collectionValue?.value.estimatedLow == null ? '—' : money(collectionValue.value.estimatedLow) + '–' + money(collectionValue.value.estimatedHigh)}</p><p className="text-xs text-muted-foreground">Rough range</p></div>
          <div><p className="text-2xl font-heading font-bold">{collectionValue?.value.purchaseCost == null ? '—' : money(collectionValue.value.purchaseCost)}</p><p className="text-xs text-muted-foreground">Recorded purchase cost</p></div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {collectionValue?.value.missingEstimates || 0} copies still need estimates. Values are informational and not a resale appraisal.
          {(collectionValue?.value.unsupportedCurrencyCopies || 0) > 0 && ' ' + collectionValue.value.unsupportedCurrencyCopies + ' non-USD copies are excluded from the USD total.'}
        </p>
      </section>
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-heading text-lg font-semibold">Household inventory</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {household?.inventory.works || 0} works · {household?.inventory.editions || 0} editions · {household?.inventory.copies || 0} copies · {household?.inventory.duplicate_work_groups || 0} duplicate work groups · {household?.inventory.overdue || 0} overdue · {household?.inventory.unread_household_works || 0} unread · {household?.inventory.missing_series_volumes || 0} missing series volumes
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div><h3 className="mb-2 text-sm font-medium">Copies per owner</h3><Bars rows={household?.copiesPerOwner || []} /></div>
          <div><h3 className="mb-2 text-sm font-medium">Copies per location</h3><Bars rows={household?.copiesPerLocation || []} /></div>
          <div><h3 className="mb-2 text-sm font-medium">Most-read household books</h3><Bars rows={(household?.mostRead || []).map(row => ({ label: row.title, count: row.readers }))} /></div>
          <div><h3 className="mb-2 text-sm font-medium">Most-loaned books</h3><Bars rows={household?.mostLoaned || []} /></div>
          <div><h3 className="mb-2 text-sm font-medium">Most-shared books</h3><Bars rows={household?.mostShared || []} /></div>
          <div><h3 className="mb-2 text-sm font-medium">Recently added</h3><Bars rows={(household?.recentlyAdded || []).map(row => ({ label: row.label, count: row.copies }))} /></div>
        </div>
      </section>
    </div>
  );
}
