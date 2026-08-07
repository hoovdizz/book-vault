import { FormEvent, useMemo, useState } from 'react';
import { BookOpen, Loader2, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { BookSearchResult, UserBook } from '@/types/book';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Choice = 'skip' | 'owned' | 'wishlist';
type SeriesProvider = 'auto' | 'hardcover' | 'open_library';
type SeriesResponse = { seriesName: string; provider: string; books: BookSearchResult[] };

function identity(book: Pick<BookSearchResult, 'title' | 'author' | 'isbn'>) {
  if (book.isbn) return `isbn:${book.isbn.replace(/[^0-9X]/gi, '').toUpperCase()}`;
  return `text:${book.title.toLocaleLowerCase()}|${book.author.toLocaleLowerCase()}`;
}

function rowKey(book: BookSearchResult, index: number) {
  return `${book.source}:${book.sourceId || identity(book)}:${index}`;
}

function canonicalSeriesName(result: SeriesResponse, searchText: string) {
  const query = searchText.toLocaleLowerCase().replace(/\b(?:series|books?|saga|novels?)\b/g, '').replace(/[^\p{L}\p{Number}]+/gu, ' ').trim();
  const counts = new Map<string, number>();
  for (const book of result.books) {
    const name = book.series?.trim();
    if (!name) continue;
    const normalized = name.toLocaleLowerCase();
    if (query && !normalized.includes(query) && !query.includes(normalized)) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)[0]?.[0]
    || result.seriesName.trim()
    || searchText.trim();
}

export default function AddSeriesDialog({
  open,
  onOpenChange,
  existingBooks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingBooks: UserBook[];
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<SeriesProvider>('auto');
  const [result, setResult] = useState<SeriesResponse | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [positions, setPositions] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);

  const existingByIdentity = useMemo(
    () => new Map(existingBooks.map(book => [identity(book.book), book])),
    [existingBooks],
  );

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setResult(null);
      setChoices({});
      setPositions({});
      setSearching(false);
      setImporting(false);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setResult(null);
    setChoices({});
    setPositions({});
    try {
      const response = await api<SeriesResponse>(
        `/api/series-search?q=${encodeURIComponent(query.trim())}&provider=${provider}`,
      );
      setResult(response);
      setChoices(Object.fromEntries(response.books.map((book, index) => [rowKey(book, index), 'skip'])));
      setPositions(Object.fromEntries(response.books.map((book, index) => [
        rowKey(book, index),
        book.seriesNumber == null ? String(index + 1) : String(book.seriesNumber),
      ])));
      if (!response.books.length) toast.info('No books were found for that series');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Series search failed');
    } finally {
      setSearching(false);
    }
  }

  function setAll(choice: Choice) {
    if (!result) return;
    setChoices(Object.fromEntries(result.books.map((book, index) => [
      rowKey(book, index),
      existingByIdentity.has(identity(book)) ? 'skip' : choice,
    ])));
  }

  async function importBooks() {
    if (!result) return;
    const actualSeriesName = canonicalSeriesName(result, query);
    const selected = result.books.flatMap((book, index) => {
      const status = choices[rowKey(book, index)];
      if (status !== 'owned' && status !== 'wishlist') return [];
      return [{
        ...book,
        status,
        series: actualSeriesName,
        seriesNumber: positions[rowKey(book, index)] || null,
        formats: ['physical'],
        readStatus: 'unread',
      }];
    });
    if (!selected.length) {
      toast.error('Mark at least one new book as Collection or Wishlist');
      return;
    }
    setImporting(true);
    try {
      const review = await api<{ results: { index: number; duplicates: unknown[] }[] }>('/api/catalog/batch', {
        method: 'POST',
        body: JSON.stringify({ mode: 'review', entries: selected }),
      });
      const reviewed = selected.map((entry, index) => ({
        ...entry,
        duplicateAction: review.results.find(result => result.index === index)?.duplicates.length ? 'cancel' : undefined,
      }));
      const response = await api<{ results: { state: string; skipped?: boolean }[] }>('/api/catalog/batch', {
        method: 'POST',
        body: JSON.stringify({ mode: 'save', entries: reviewed }),
      });
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      const added = response.results.filter(item => item.state === 'success' && !item.skipped).length;
      const skipped = response.results.length - added;
      const failures = response.results.filter(item => item.state === 'failure') as { state: string; error?: string }[];
      if (failures.length && !added) {
        throw new Error(failures[0].error || 'No series books could be saved');
      }
      toast.success(`Added ${added} series book${added === 1 ? '' : 's'}${skipped ? `; ${skipped} already existed or were skipped` : ''}`);
      close(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not import series');
    } finally {
      setImporting(false);
    }
  }

  const selectedCount = Object.values(choices).filter(choice => choice !== 'skip').length;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a whole book series</DialogTitle>
          <DialogDescription>
            Find the series, review every volume, then mark each new book for your Collection, Wishlist, or Skip.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={search} className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Series source">
            {([
              ['auto', 'Auto'],
              ['hardcover', 'Hardcover'],
              ['open_library', 'Open Library'],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={provider === value ? 'default' : 'outline'}
                aria-pressed={provider === value}
                onClick={() => setProvider(value)}
              >
                {label}{value === 'hardcover' && ' · best positions'}
              </Button>
            ))}
            <Button type="button" size="sm" variant="outline" disabled title="Goodreads retired its public API">
              Goodreads · unavailable
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Goodreads no longer provides a supported public API. Auto uses Hardcover when its token is configured, then Open Library.
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={event => setQuery(event.target.value)} maxLength={150} className="pl-9" placeholder="Series name, e.g. The Expanse" autoFocus />
            </div>
            <Button type="submit" disabled={searching || !query.trim()}>
              {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              Find series
            </Button>
          </div>
        </form>

        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div>
                <h3 className="font-heading font-semibold">{canonicalSeriesName(result, query)}</h3>
                <p className="text-sm text-muted-foreground">{result.books.length} books found via {result.provider}</p>
                {result.provider === 'Open Library' && (
                  <p className="mt-1 text-xs text-muted-foreground">Missing positions are inferred from publication order and can be corrected below.</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setAll('owned')}>All Collection</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setAll('wishlist')}>All Wishlist</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAll('skip')}>Clear</Button>
              </div>
            </div>

            <div className="space-y-2">
              {result.books.map((book, index) => {
                const key = rowKey(book, index);
                const existing = existingByIdentity.get(identity(book));
                const choice = choices[key] || 'skip';
                return (
                  <div key={key} className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-[56px_1fr_auto] sm:items-center">
                    <div className="h-20 w-14 overflow-hidden rounded bg-muted">
                      {book.coverUrl ? (
                        <img src={book.coverUrl} alt={`${book.title} cover`} loading="lazy" className="h-full w-full object-cover" onError={event => { event.currentTarget.src = '/placeholder.svg'; }} />
                      ) : (
                        <div className="grid h-full place-items-center"><BookOpen className="h-5 w-5 text-muted-foreground/50" /></div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {positions[key] && <Badge variant="secondary">#{positions[key]}</Badge>}
                        <h4 className="font-heading font-semibold">{book.title}</h4>
                      </div>
                      <p className="text-sm text-muted-foreground">{book.author}</p>
                      {book.isbn && <p className="text-xs text-muted-foreground">ISBN {book.isbn}</p>}
                      <div className="mt-2 flex max-w-48 items-center gap-2">
                        <label htmlFor={`series-position-${index}`} className="whitespace-nowrap text-xs text-muted-foreground">Series position</label>
                        <Input
                          id={`series-position-${index}`}
                          value={positions[key] || ''}
                          maxLength={30}
                          className="h-8 w-20"
                          onChange={event => setPositions(current => ({ ...current, [key]: event.target.value }))}
                        />
                      </div>
                    </div>
                    {existing ? (
                      <Badge variant="outline">
                        Already in {existing.status === 'owned' ? 'Collection' : existing.status === 'wishlist' ? 'Wishlist' : 'Backlog'}
                      </Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {([
                          ['skip', 'Skip'],
                          ['owned', 'Collection'],
                          ['wishlist', 'Wishlist'],
                        ] as const).map(([value, label]) => (
                          <Button
                            key={value}
                            type="button"
                            size="sm"
                            variant={choice === value ? 'default' : 'outline'}
                            className={cn(choice === value && value === 'wishlist' && 'bg-accent text-accent-foreground')}
                            onClick={() => setChoices(current => ({ ...current, [key]: value }))}
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>Cancel</Button>
          {result && (
            <Button type="button" onClick={importBooks} disabled={importing || selectedCount === 0}>
              {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add selected ({selectedCount})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
