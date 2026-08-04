import { FormEvent, useMemo, useState } from 'react';
import { BookOpen, Check, ImageOff, Loader2, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { BookFormat, BookSearchResult, CoverOption } from '@/types/book';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type SearchType = 'auto' | 'title' | 'isbn';
type Providers = { googleBooks: 'available' | 'unavailable'; openLibrary: 'available' | 'unavailable' };
type SearchResponse = { results: BookSearchResult[]; providers: Providers };

type Draft = {
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  pageCount: string;
  genre: string;
  description: string;
  collection: string;
  series: string;
  seriesNumber: string;
  coverUrl: string;
  coverOptions: CoverOption[];
  source: 'google_books' | 'open_library' | 'manual';
  sourceId: string;
  formats: BookFormat[];
};

const emptyDraft: Draft = {
  title: '',
  author: '',
  isbn: '',
  publisher: '',
  publishedYear: '',
  pageCount: '',
  genre: '',
  description: '',
  collection: '',
  series: '',
  seriesNumber: '',
  coverUrl: '',
  coverOptions: [],
  source: 'manual',
  sourceId: '',
  formats: ['physical'],
};

const formatLabels: Record<BookFormat, string> = {
  physical: 'Physical',
  ebook: 'eBook',
  audiobook: 'Audiobook',
};

function CoverChoice({
  cover,
  selected,
  onSelect,
}: {
  cover: CoverOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative overflow-hidden rounded-md border-2 bg-muted text-left transition-colors focus:outline-none focus:ring-2 focus:ring-ring',
        selected ? 'border-primary' : 'border-border hover:border-primary/60',
      )}
      aria-label={`Use ${cover.label}`}
    >
      <div className="aspect-[2/3]">
        {failed ? (
          <div className="grid h-full place-items-center text-muted-foreground"><ImageOff className="h-6 w-6" /></div>
        ) : (
          <img
            src={cover.url}
            alt={cover.label}
            className="h-full w-full object-cover"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <div className="truncate border-t border-border bg-card px-1.5 py-1 text-[10px] text-muted-foreground">
        {cover.source}
      </div>
      {selected && (
        <span className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}

export default function AddBookDialog({
  open,
  onOpenChange,
  collections,
  seriesNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: string[];
  seriesNames: string[];
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'search' | 'details'>('search');
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('auto');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [searched, setSearched] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const sourceMessage = useMemo(() => {
    if (!providers) return '';
    if (providers.googleBooks === 'unavailable' && providers.openLibrary === 'available') {
      return 'Google Books was unavailable, so these results came from Open Library.';
    }
    if (providers.openLibrary === 'unavailable' && providers.googleBooks === 'available') {
      return 'Open Library cover enrichment was unavailable; Google Books results are shown.';
    }
    return 'Google Books results are prioritized and Open Library supplies fallback metadata and cover editions.';
  }, [providers]);

  function reset() {
    setStep('search');
    setQuery('');
    setSearchType('auto');
    setSearching(false);
    setSaving(false);
    setResults([]);
    setProviders(null);
    setSearched(false);
    setDraft(emptyDraft);
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  async function searchBooks(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      toast.error('Enter a book title or ISBN');
      return;
    }
    setSearching(true);
    setSearched(false);
    setResults([]);
    setProviders(null);
    try {
      const response = await api<SearchResponse>(
        `/api/book-search?q=${encodeURIComponent(query.trim())}&type=${searchType}`,
      );
      setResults(response.results);
      setProviders(response.providers);
      setSearched(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Book search failed');
    } finally {
      setSearching(false);
    }
  }

  function selectResult(result: BookSearchResult) {
    setDraft({
      title: result.title,
      author: result.author,
      isbn: result.isbn || '',
      publisher: result.publisher || '',
      publishedYear: result.publishedYear ? String(result.publishedYear) : '',
      pageCount: result.pageCount ? String(result.pageCount) : '',
      genre: result.genre || '',
      description: result.description || '',
      collection: '',
      series: result.series || '',
      seriesNumber: result.seriesNumber ? String(result.seriesNumber) : '',
      coverUrl: result.coverUrl || result.coverOptions[0]?.url || '',
      coverOptions: result.coverOptions,
      source: result.source,
      sourceId: result.sourceId,
      formats: ['physical'],
    });
    setStep('details');
  }

  function startManual() {
    const compact = query.toUpperCase().replace(/[^0-9X]/g, '');
    const queryLooksLikeIsbn = /^(?:\d{9}[\dX]|\d{13})$/.test(compact);
    const useAsIsbn = searchType === 'isbn' || (searchType === 'auto' && queryLooksLikeIsbn);
    setDraft({ ...emptyDraft, title: useAsIsbn ? '' : query.trim(), isbn: useAsIsbn ? query.trim() : '' });
    setStep('details');
  }

  function update<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft(current => ({ ...current, [field]: value }));
  }

  function toggleFormat(format: BookFormat) {
    setDraft(current => {
      const selected = current.formats.includes(format);
      if (selected && current.formats.length === 1) return current;
      return {
        ...current,
        formats: selected ? current.formats.filter(value => value !== format) : [...current.formats, format],
      };
    });
  }

  async function saveBook(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api('/api/books', {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          publishedYear: draft.publishedYear || null,
          pageCount: draft.pageCount || null,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['books'] });
      toast.success(`Added “${draft.title}” to your collection`);
      handleOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add book');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === 'search' ? 'Find a book' : 'Add book details'}</DialogTitle>
          <DialogDescription>
            {step === 'search'
              ? 'Search Google Books by title or ISBN. Open Library is used for fallback results and additional covers.'
              : 'Choose a cover and record where this title belongs in your library.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'search' ? (
          <div className="space-y-5">
            <form onSubmit={searchBooks} className="space-y-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Search type">
                {([
                  ['auto', 'Auto detect'],
                  ['title', 'Book title'],
                  ['isbn', 'ISBN'],
                ] as const).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={searchType === value ? 'default' : 'outline'}
                    aria-pressed={searchType === value}
                    onClick={() => setSearchType(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    className="pl-9"
                    maxLength={200}
                    autoFocus
                    placeholder={searchType === 'isbn' ? '9780261103573' : 'Book title or ISBN'}
                  />
                </div>
                <Button type="submit" disabled={searching}>
                  {searching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                  Search
                </Button>
              </div>
            </form>

            {sourceMessage && <p className="text-sm text-muted-foreground">{sourceMessage}</p>}

            {results.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {results.map(result => (
                  <button
                    key={`${result.source}:${result.sourceId}`}
                    type="button"
                    onClick={() => selectResult(result)}
                    className="flex gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <div className="h-28 w-[74px] flex-shrink-0 overflow-hidden rounded bg-muted">
                      {result.coverUrl ? (
                        <img
                          src={result.coverUrl}
                          alt={`${result.title} cover`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
                        />
                      ) : (
                        <div className="grid h-full place-items-center"><BookOpen className="h-7 w-7 text-muted-foreground/50" /></div>
                      )}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <h3 className="line-clamp-2 font-heading font-semibold">{result.title}</h3>
                      <p className="line-clamp-1 text-sm text-muted-foreground">{result.author}</p>
                      {result.isbn && <p className="text-xs text-muted-foreground">ISBN {result.isbn}</p>}
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">{result.sourceLabel}</Badge>
                        {result.publishedYear && <Badge variant="secondary">{result.publishedYear}</Badge>}
                        {result.coverOptions.length > 1 && (
                          <Badge variant="secondary">{result.coverOptions.length} covers</Badge>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {searched && results.length === 0 && (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
                No provider results were found. You can still enter the book manually.
              </div>
            )}

            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={startManual}>Add manually</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={saveBook} className="space-y-6">
            <div className="grid gap-6 md:grid-cols-[220px_1fr]">
              <section className="space-y-3">
                <div>
                  <Label>Cover</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Choose one of the available editions.</p>
                </div>
                {draft.coverOptions.length ? (
                  <div className="grid grid-cols-2 gap-2">
                    {draft.coverOptions.map(cover => (
                      <CoverChoice
                        key={cover.url}
                        cover={cover}
                        selected={draft.coverUrl === cover.url}
                        onSelect={() => update('coverUrl', cover.url)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid aspect-[2/3] place-items-center rounded-md border border-dashed border-border bg-muted text-center text-sm text-muted-foreground">
                    <div><ImageOff className="mx-auto mb-2 h-7 w-7" />No cover available</div>
                  </div>
                )}
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="book-title">Title</Label>
                  <Input id="book-title" required maxLength={300} value={draft.title} onChange={event => update('title', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="book-author">Author</Label>
                  <Input id="book-author" required maxLength={300} value={draft.author} onChange={event => update('author', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-isbn">ISBN</Label>
                  <Input id="book-isbn" maxLength={30} value={draft.isbn} onChange={event => update('isbn', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-publisher">Publisher</Label>
                  <Input id="book-publisher" maxLength={200} value={draft.publisher} onChange={event => update('publisher', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-year">Published year</Label>
                  <Input id="book-year" type="number" min="0" max={new Date().getFullYear() + 5} value={draft.publishedYear} onChange={event => update('publishedYear', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-pages">Page count</Label>
                  <Input id="book-pages" type="number" min="1" max="100000" value={draft.pageCount} onChange={event => update('pageCount', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-collection">Collection</Label>
                  <Input id="book-collection" list="book-collections" maxLength={150} placeholder="e.g. Classics shelf" value={draft.collection} onChange={event => update('collection', event.target.value)} />
                  <datalist id="book-collections">{collections.map(value => <option key={value} value={value} />)}</datalist>
                </div>
                <div>
                  <Label htmlFor="book-genre">Genre</Label>
                  <Input id="book-genre" maxLength={150} value={draft.genre} onChange={event => update('genre', event.target.value)} />
                </div>
                <div>
                  <Label htmlFor="book-series">Series</Label>
                  <Input id="book-series" list="book-series" maxLength={150} placeholder="e.g. The Expanse" value={draft.series} onChange={event => update('series', event.target.value)} />
                  <datalist id="book-series">{seriesNames.map(value => <option key={value} value={value} />)}</datalist>
                </div>
                <div>
                  <Label htmlFor="book-series-number">Series position</Label>
                  <Input id="book-series-number" maxLength={30} placeholder="e.g. 1 or 1.5" value={draft.seriesNumber} onChange={event => update('seriesNumber', event.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <Label>Formats</Label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(Object.keys(formatLabels) as BookFormat[]).map(format => (
                      <Button
                        key={format}
                        type="button"
                        size="sm"
                        variant={draft.formats.includes(format) ? 'default' : 'outline'}
                        aria-pressed={draft.formats.includes(format)}
                        onClick={() => toggleFormat(format)}
                      >
                        {formatLabels[format]}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="book-description">Description</Label>
                  <Textarea id="book-description" maxLength={5000} rows={5} value={draft.description} onChange={event => update('description', event.target.value)} />
                </div>
              </section>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep('search')}>Back to search</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add to collection
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
