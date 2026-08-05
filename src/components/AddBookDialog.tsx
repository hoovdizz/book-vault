import { FormEvent, useEffect, useMemo, useState } from 'react';
import { BookOpen, Camera, Check, ImageOff, Loader2, Search } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { BookBinding, BookCondition, BookFormat, BookSearchResult, CoverOption } from '@/types/book';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';
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
import { Switch } from '@/components/ui/switch';
import IsbnScannerDialog from '@/components/IsbnScannerDialog';

type SearchType = 'auto' | 'title' | 'isbn';
type Providers = {
  googleBooks: 'available' | 'unavailable' | 'disabled';
  openLibrary: 'available' | 'unavailable' | 'disabled';
  hardcover: 'available' | 'unavailable' | 'disabled';
};
type SearchResponse = { results: BookSearchResult[]; providers: Providers };
type DuplicateWarning = {
  matchType: string;
  work: { id: string; title: string; author: string };
  edition: {
    id: string;
    isbn10: string | null;
    isbn13: string | null;
    label: string | null;
    binding: string | null;
    coverUrl: string | null;
  };
  copyCount: number;
  copies: {
    id: string;
    owner: { id: string | null; name: string };
    format: string;
    location: string | null;
    loan: { id: string; status: string; dueAt: string | null } | null;
  }[];
  lists: { id: string; type: string; requestedBy: { id: string; name: string } }[];
};

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
  binding: BookBinding | '';
  edition: string;
  storageLocation: string;
  locationId: string;
  conditionGrade: BookCondition | '';
  conditionNotes: string;
  loanedOut: boolean;
  loanedTo: string;
  loanedAt: string;
  scope: 'personal' | 'household';
  priority: '' | 'low' | 'medium' | 'high';
  expectedPrice: string;
  notes: string;
  giftPrivate: boolean;
  intendedRecipientId: string;
  ownerUserId: string;
  copyCount: string;
  purchaseDate: string;
  purchasePrice: string;
  purchaseCurrency: string;
  purchaseSource: string;
  customBarcode: string;
  copyNotes: string;
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
  binding: '',
  edition: '',
  storageLocation: '',
  locationId: '',
  conditionGrade: '',
  conditionNotes: '',
  loanedOut: false,
  loanedTo: '',
  loanedAt: '',
  scope: 'personal',
  priority: '',
  expectedPrice: '',
  notes: '',
  giftPrivate: false,
  intendedRecipientId: '',
  ownerUserId: '',
  copyCount: '1',
  purchaseDate: '',
  purchasePrice: '',
  purchaseCurrency: 'USD',
  purchaseSource: '',
  customBarcode: '',
  copyNotes: '',
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
  destination = 'owned',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: string[];
  seriesNames: string[];
  destination?: 'owned' | 'wishlist';
}) {
  const queryClient = useQueryClient();
  const isWishlist = destination === 'wishlist';
  const [step, setStep] = useState<'search' | 'details'>('search');
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('auto');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<BookSearchResult[]>([]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [searched, setSearched] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [duplicateWarnings, setDuplicateWarnings] = useState<DuplicateWarning[]>([]);
  const [duplicateAction, setDuplicateAction] = useState('');
  const { data: householdData } = useQuery({
    queryKey: ['household'],
    queryFn: () => api<{
      household: { defaults: { locationId: string | null; binding: string; condition: string } };
      members: { id: number; name: string; disabled: boolean }[];
      permissions: { manageHousehold: boolean };
    }>('/api/household'),
    enabled: open,
  });
  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ locations: { id: string; breadcrumb: string; archived: boolean }[] }>('/api/locations?archived=false'),
    enabled: open,
  });

  function withDefaults(value: Draft): Draft {
    return {
      ...value,
      binding: value.binding || householdData?.household.defaults.binding || '',
      locationId: value.locationId || (isWishlist ? '' : householdData?.household.defaults.locationId || ''),
      conditionGrade: value.conditionGrade || (isWishlist ? '' : householdData?.household.defaults.condition || ''),
    };
  }

  useEffect(() => {
    if (!open || !householdData) return;
    setDraft(current => ({
      ...current,
      binding: current.binding || householdData.household.defaults.binding,
      locationId: current.locationId || (isWishlist ? '' : householdData?.household.defaults.locationId || ''),
      conditionGrade: current.conditionGrade || (isWishlist ? '' : householdData.household.defaults.condition),
    }));
  }, [open, isWishlist, householdData]);

  const sourceMessage = useMemo(() => {
    if (!providers) return '';
    if (providers.googleBooks === 'unavailable' && providers.openLibrary === 'available') {
      return 'Google Books was unavailable, so these results came from Open Library.';
    }
    if (providers.openLibrary === 'unavailable' && providers.googleBooks === 'available') {
      return 'Open Library cover enrichment was unavailable; Google Books results are shown.';
    }
    const hardcover = providers.hardcover === 'available' ? ' Hardcover supplied additional cover choices.' : '';
    return `Results use the metadata-provider order configured by your administrator, with another enabled provider used when needed.${hardcover}`;
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
    setDraft(withDefaults({ ...emptyDraft }));
    setScannerOpen(false);
    setDuplicateWarnings([]);
    setDuplicateAction('');
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  async function searchBooks(event: FormEvent) {
    event.preventDefault();
    await runSearch(query, searchType);
  }

  async function runSearch(searchQuery: string, type: SearchType) {
    if (!searchQuery.trim()) {
      toast.error('Enter a book title or ISBN');
      return;
    }
    setSearching(true);
    setSearched(false);
    setResults([]);
    setProviders(null);
    try {
      const response = await api<SearchResponse>(
        `/api/book-search?q=${encodeURIComponent(searchQuery.trim())}&type=${type}`,
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

  function handleScannedIsbn(isbn: string) {
    setQuery(isbn);
    setSearchType('isbn');
    toast.success(`Scanned ISBN ${isbn}`);
    void runSearch(isbn, 'isbn');
  }

  function selectResult(result: BookSearchResult) {
    setDraft(withDefaults({
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
      binding: '',
      edition: '',
      storageLocation: '',
      locationId: '',
      conditionGrade: '',
      conditionNotes: '',
      loanedOut: false,
      loanedTo: '',
      loanedAt: '',
    }));
    setStep('details');
  }

  function startManual() {
    const compact = query.toUpperCase().replace(/[^0-9X]/g, '');
    const queryLooksLikeIsbn = /^(?:\d{9}[\dX]|\d{13})$/.test(compact);
    const useAsIsbn = searchType === 'isbn' || (searchType === 'auto' && queryLooksLikeIsbn);
    setDraft(withDefaults({ ...emptyDraft, title: useAsIsbn ? '' : query.trim(), isbn: useAsIsbn ? query.trim() : '' }));
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
      if (!duplicateAction) {
        const duplicateReview = await api<{ warnings: DuplicateWarning[] }>('/api/catalog/duplicates', {
          method: 'POST',
          body: JSON.stringify(draft),
        });
        if (duplicateReview.warnings.length) {
          setDuplicateWarnings(duplicateReview.warnings);
          return;
        }
      }
      const created = await api<{ created: { type: string; id: number }[] }>('/api/catalog', {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          status: destination,
          publishedYear: draft.publishedYear || null,
          pageCount: draft.pageCount || null,
          forceNewEdition: duplicateAction === 'add_different_edition',
          moveWishlistToOwned: duplicateAction === 'move_wishlist_to_owned',
          ownerUserId: draft.ownerUserId && draft.ownerUserId !== 'household' ? draft.ownerUserId : undefined,
          householdOwned: draft.ownerUserId === 'household',
          copyCount: Number(draft.copyCount || 1),
        }),
      });
      if (draft.loanedOut && destination === 'owned') {
        const physicalCopy = created.created.find(item => item.type === 'copy');
        if (physicalCopy) {
          await api('/api/loans', {
            method: 'POST',
            body: JSON.stringify({
              copyId: physicalCopy.id,
              externalName: draft.loanedTo || 'Unspecified borrower',
              checkoutAt: draft.loanedAt || undefined,
            }),
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-duplicates'] });
      await queryClient.invalidateQueries({ queryKey: ['catalog-series'] });
      toast.success(`Added “${draft.title}” to your ${isWishlist ? 'wishlist' : 'collection'}`);
      handleOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add book');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'search'
              ? `Find a book${isWishlist ? ' for your wishlist' : ''}`
              : `Add book to ${isWishlist ? 'wishlist' : 'collection'}`}
          </DialogTitle>
          <DialogDescription>
            {step === 'search'
              ? 'Search Google Books by title or ISBN. Open Library provides fallback results, and optional Hardcover integration adds covers.'
              : isWishlist
                ? 'Choose a cover and optionally record its collection or series before saving it to your wishlist.'
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
                <Button type="button" variant="outline" size="icon" aria-label="Scan ISBN with camera" title="Scan ISBN with camera" onClick={() => setScannerOpen(true)}>
                  <Camera className="h-4 w-4" />
                </Button>
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
                        {result.priceOptions?.[0] && (
                          <Badge variant="secondary">~{result.priceOptions[0].currency} {result.priceOptions[0].amount.toFixed(2)}</Badge>
                        )}
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
            {duplicateWarnings.length > 0 && !duplicateAction && (
              <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4" aria-live="polite">
                <h3 className="font-heading font-semibold">This book may already be in the household</h3>
                {duplicateWarnings.slice(0, 3).map(warning => (
                  <div key={warning.edition.id} className="mt-3 flex gap-3 rounded-md bg-background/70 p-3">
                    <div className="h-20 w-14 flex-none overflow-hidden rounded bg-muted">
                      {warning.edition.coverUrl && (
                        <img src={warning.edition.coverUrl} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{warning.work.title}</p>
                      <p className="text-muted-foreground">
                        {[warning.edition.binding, warning.edition.label, warning.edition.isbn13 || warning.edition.isbn10]
                          .filter(Boolean).join(' · ')}
                      </p>
                      <p>{warning.copyCount} owned {warning.copyCount === 1 ? 'copy' : 'copies'}</p>
                      {warning.copies.map(copy => (
                        <p key={copy.id} className="text-xs text-muted-foreground">
                          {copy.owner.name} · {copy.format}{copy.location ? ` · ${copy.location}` : ''}{copy.loan ? ' · currently loaned' : ''}
                        </p>
                      ))}
                      {warning.lists.map(list => (
                        <p key={list.id} className="text-xs text-muted-foreground">
                          {list.requestedBy.name}: {list.type}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" size="sm" onClick={() => setDuplicateAction('add_another_copy')}>
                    Add another copy
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setDuplicateAction('add_different_edition')}>
                    Add different edition
                  </Button>
                  {duplicateWarnings.some(warning => warning.lists.some(list => list.type === 'wishlist'))
                    && destination === 'owned' && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setDuplicateAction('move_wishlist_to_owned')}>
                        Move wishlist item to owned
                      </Button>
                    )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      handleOpenChange(false);
                      window.history.pushState({}, '', `/collection?q=${encodeURIComponent(duplicateWarnings[0].work.title)}`);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                  >
                    View existing
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDuplicateWarnings([])}>
                    Cancel
                  </Button>
                </div>
              </section>
            )}
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
                {isWishlist && (
                  <>
                    <div className="sm:col-span-2 border-t border-border pt-2">
                      <h3 className="font-heading font-semibold">Wishlist request</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Purchasing details belong to this request, not to the general work record.</p>
                    </div>
                    <div>
                      <Label htmlFor="wishlist-scope">Visibility</Label>
                      <select id="wishlist-scope" value={draft.scope} onChange={event => update('scope', event.target.value as Draft['scope'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="personal">Personal</option>
                        <option value="household">Household</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="wishlist-priority">Priority</Label>
                      <select id="wishlist-priority" value={draft.priority} onChange={event => update('priority', event.target.value as Draft['priority'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">Not set</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="wishlist-price">Expected price</Label>
                      <Input id="wishlist-price" type="number" min="0" step="0.01" value={draft.expectedPrice} onChange={event => update('expectedPrice', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="wishlist-recipient">Intended recipient</Label>
                      <select id="wishlist-recipient" value={draft.intendedRecipientId} onChange={event => update('intendedRecipientId', event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">No recipient</option>
                        {(householdData?.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="wishlist-notes">Purchase or gift notes</Label>
                      <Textarea id="wishlist-notes" maxLength={3000} rows={3} value={draft.notes} onChange={event => update('notes', event.target.value)} />
                    </div>
                    <label className="sm:col-span-2 flex items-center gap-2 rounded-md border border-border p-3 text-sm">
                      <input type="checkbox" checked={draft.giftPrivate} onChange={event => update('giftPrivate', event.target.checked)} />
                      Hide this gift entry from its intended recipient until revealed
                    </label>
                  </>
                )}
                <div className="sm:col-span-2 border-t border-border pt-2">
                  <h3 className="font-heading font-semibold">Copy details</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Describe this specific copy so other editions remain distinct.</p>
                </div>
                <div>
                  <Label htmlFor="book-binding">Binding</Label>
                  <select id="book-binding" value={draft.binding} onChange={event => update('binding', event.target.value as Draft['binding'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                    <option value="">Not set</option>
                    {(Object.entries(bindingLabels) as [BookBinding, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <Label htmlFor="book-edition">Edition</Label>
                  <Input id="book-edition" maxLength={150} placeholder="e.g. First edition or Limited edition" value={draft.edition} onChange={event => update('edition', event.target.value)} />
                </div>
                {!isWishlist && (
                  <>
                    <div className="sm:col-span-2">
                      <Label htmlFor="book-storage-location">Physical location</Label>
                      <select
                        id="book-storage-location"
                        value={draft.locationId}
                        onChange={event => update('locationId', event.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">No physical location</option>
                        {(locationsData?.locations || []).map(location => (
                          <option key={location.id} value={location.id}>{location.breadcrumb}</option>
                        ))}
                      </select>
                      {!locationsData?.locations.length && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Add hierarchical rooms, shelves, or bins in Settings.
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="book-condition">Condition</Label>
                      <select id="book-condition" value={draft.conditionGrade} onChange={event => update('conditionGrade', event.target.value as Draft['conditionGrade'])} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                        <option value="">Not set</option>
                        {(Object.entries(conditionLabels) as [BookCondition, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="book-copy-owner">Copy owner</Label>
                      <select id="book-copy-owner" value={draft.ownerUserId} onChange={event => update('ownerUserId', event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                        <option value="">My account</option>
                        {householdData?.permissions.manageHousehold && <option value="household">Shared household copy</option>}
                        {householdData?.permissions.manageHousehold && (householdData.members || []).filter(member => !member.disabled).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor="book-copy-count">Number of copies per selected format</Label>
                      <Input id="book-copy-count" type="number" min="1" max="100" value={draft.copyCount} onChange={event => update('copyCount', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="book-purchase-date">Purchase date</Label>
                      <Input id="book-purchase-date" type="date" value={draft.purchaseDate} onChange={event => update('purchaseDate', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="book-purchase-price">Purchase price</Label>
                      <div className="flex gap-2">
                        <Input id="book-purchase-price" type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={event => update('purchasePrice', event.target.value)} />
                        <Input aria-label="Purchase currency" maxLength={3} className="w-20 uppercase" value={draft.purchaseCurrency} onChange={event => update('purchaseCurrency', event.target.value.toUpperCase())} />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="book-purchase-source">Purchase source</Label>
                      <Input id="book-purchase-source" maxLength={150} value={draft.purchaseSource} onChange={event => update('purchaseSource', event.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="book-custom-barcode">Custom copy barcode</Label>
                      <Input id="book-custom-barcode" maxLength={100} value={draft.customBarcode} onChange={event => update('customBarcode', event.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="book-copy-notes">Copy notes</Label>
                      <Textarea id="book-copy-notes" maxLength={2000} rows={2} value={draft.copyNotes} onChange={event => update('copyNotes', event.target.value)} />
                    </div>
                    <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
                      <div>
                        <Label htmlFor="book-loaned">Loaned out</Label>
                        <p className="text-xs text-muted-foreground">Track who has this copy.</p>
                      </div>
                      <Switch id="book-loaned" checked={draft.loanedOut} onCheckedChange={value => update('loanedOut', value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="book-condition-notes">Condition / damage notes</Label>
                      <Textarea id="book-condition-notes" maxLength={2000} rows={3} placeholder="e.g. Bent corners, broken spine, highlighting" value={draft.conditionNotes} onChange={event => update('conditionNotes', event.target.value)} />
                    </div>
                    {draft.loanedOut && (
                      <>
                        <div>
                          <Label htmlFor="book-loaned-to">Loaned to</Label>
                          <Input id="book-loaned-to" maxLength={150} placeholder="Name or note" value={draft.loanedTo} onChange={event => update('loanedTo', event.target.value)} />
                        </div>
                        <div>
                          <Label htmlFor="book-loaned-at">Loaned date</Label>
                          <Input id="book-loaned-at" type="date" value={draft.loanedAt} onChange={event => update('loanedAt', event.target.value)} />
                        </div>
                      </>
                    )}
                  </>
                )}
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
              <Button type="submit" disabled={saving || (duplicateWarnings.length > 0 && !duplicateAction)}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add to {isWishlist ? 'wishlist' : 'collection'}
              </Button>
            </DialogFooter>
          </form>
        )}
        </DialogContent>
      </Dialog>
      <IsbnScannerDialog open={scannerOpen} onOpenChange={setScannerOpen} onDetected={handleScannedIsbn} />
    </>
  );
}
