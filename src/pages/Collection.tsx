import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Book, Filter, Grid3X3, Headphones, List, Plus, ScanLine, Search, TableProperties, Tablet } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import BookCard from '@/components/BookCard';
import AddBookDialog from '@/components/AddBookDialog';
import EditBookDialog from '@/components/EditBookDialog';
import BatchScanDialog from '@/components/BatchScanDialog';
import { Button } from '@/components/ui/button';
import { BookFormat, UserBook } from '@/types/book';
import { api } from '@/lib/auth';
import { fetchCatalog } from '@/lib/catalog';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';

type CatalogView = 'cover' | 'detailed' | 'compact';
type Preferences = {
  catalogView: CatalogView;
  catalogSort: string;
  catalogFilters: Record<string, unknown>;
  visibleColumns: string[];
};
type Location = { id: string; breadcrumb: string; levelType: string };

const defaultColumns = ['cover', 'title', 'author', 'series', 'isbn', 'edition', 'owner', 'location', 'format', 'condition', 'readingStatus', 'loan'];
const columnLabels: Record<string, string> = {
  cover: 'Cover', title: 'Title', author: 'Author', series: 'Series', isbn: 'ISBN',
  edition: 'Edition', copies: 'Copies', owner: 'Owner', location: 'Location',
  format: 'Format', condition: 'Condition', readingStatus: 'Reading status',
  rating: 'Rating', loan: 'Loan', dateAdded: 'Date added',
};

function Highlighted({ value, query }: { value?: string | number; query: string }) {
  const text = String(value ?? '');
  if (!query.trim()) return <>{text}</>;
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-primary/20 text-foreground">{text.slice(index, index + query.trim().length)}</mark>
      {text.slice(index + query.trim().length)}
    </>
  );
}

export default function Collection() {
  const queryClient = useQueryClient();
  const initialQuery = new URLSearchParams(window.location.search).get('q') || '';
  const [search, setSearch] = useState(initialQuery);
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [formatFilters, setFormatFilters] = useState<BookFormat[]>([]);
  const [readingFilters, setReadingFilters] = useState<string[]>([]);
  const [locationId, setLocationId] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showAddBook, setShowAddBook] = useState(false);
  const [showBatchScan, setShowBatchScan] = useState(false);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const [smartShelfName, setSmartShelfName] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedCopyIds, setSelectedCopyIds] = useState<string[]>([]);
  const [bulkLocationId, setBulkLocationId] = useState('');
  const filtersHydrated = useRef(false);

  const { data: preferenceData } = useQuery({
    queryKey: ['preferences'],
    queryFn: () => api<{ preferences: Preferences }>('/api/preferences'),
  });
  const preferences = preferenceData?.preferences;
  const view = preferences?.catalogView || 'cover';
  const sort = preferences?.catalogSort || 'title';
  const visibleColumns = preferences?.visibleColumns.length ? preferences.visibleColumns : defaultColumns;

  const catalogQuery = {
    page,
    pageSize: 50,
    q: deferredSearch,
    status: ['owned'],
    format: formatFilters,
    readStatus: readingFilters,
    locationId: locationId || undefined,
    sort,
    direction: 'asc' as const,
  };
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['catalog', catalogQuery],
    queryFn: () => fetchCatalog(catalogQuery),
    placeholderData: previous => previous,
  });
  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ locations: Location[] }>('/api/locations?archived=false'),
  });
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api<{ collections: {
      id: string;
      name: string;
      scope: string;
      smartFilter: {
        q?: string;
        format?: BookFormat[];
        readStatus?: string[];
        locationId?: string;
      } | null;
    }[] }>('/api/collections'),
  });
  const { data: seriesData } = useQuery({
    queryKey: ['catalog-series'],
    queryFn: () => api<{ series: { name: string }[] }>('/api/catalog/series'),
  });

  useEffect(() => setPage(1), [deferredSearch, formatFilters, readingFilters, locationId, sort]);

  useEffect(() => {
    if (initialQuery) setSearch(current => current === initialQuery ? current : initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!preferences || filtersHydrated.current) return;
    const saved = preferences.catalogFilters || {};
    setSearch(typeof saved.q === 'string' ? saved.q : initialQuery);
    setFormatFilters(Array.isArray(saved.format) ? saved.format.filter(value => ['physical', 'ebook', 'audiobook'].includes(String(value))) as BookFormat[] : []);
    setReadingFilters(Array.isArray(saved.readStatus) ? saved.readStatus.map(String) : []);
    setLocationId(typeof saved.locationId === 'string' ? saved.locationId : '');
    filtersHydrated.current = true;
  }, [initialQuery, preferences]);

  useEffect(() => {
    if (!filtersHydrated.current) return;
    const timer = window.setTimeout(() => {
      void api('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify({
          catalogFilters: {
            q: search,
            format: formatFilters,
            readStatus: readingFilters,
            locationId,
          },
        }),
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [search, formatFilters, readingFilters, locationId]);

  async function savePreferences(changes: Partial<Preferences>) {
    await api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify(changes),
    });
    await queryClient.invalidateQueries({ queryKey: ['preferences'] });
  }

  function toggleFormat(format: BookFormat) {
    setFormatFilters(current => current.includes(format)
      ? current.filter(value => value !== format)
      : [...current, format]);
  }

  function toggleReadingStatus(status: string) {
    setReadingFilters(current => current.includes(status)
      ? current.filter(value => value !== status)
      : [...current, status]);
  }

  function applySmartShelf(filter: NonNullable<NonNullable<typeof collectionsData>['collections'][number]['smartFilter']>) {
    setSearch(filter.q || '');
    setFormatFilters(filter.format || []);
    setReadingFilters(filter.readStatus || []);
    setLocationId(filter.locationId || '');
    setPage(1);
  }

  async function createSmartShelf() {
    const name = smartShelfName.trim();
    if (!name) return;
    try {
      await api('/api/collections', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scope: 'personal',
          smartFilter: { q: search, format: formatFilters, readStatus: readingFilters, locationId },
        }),
      });
      setSmartShelfName('');
      await queryClient.invalidateQueries({ queryKey: ['collections'] });
      toast.success('Smart shelf saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save smart shelf');
    }
  }

  function toggleCopySelection(copyId: string | null | undefined) {
    if (!copyId) return;
    setSelectedCopyIds(current => current.includes(copyId)
      ? current.filter(value => value !== copyId)
      : [...current, copyId]);
  }

  async function bulkMoveCopies() {
    if (!selectedCopyIds.length) return;
    try {
      await api('/api/catalog/copies/move', {
        method: 'POST',
        body: JSON.stringify({ copyIds: selectedCopyIds, locationId: bulkLocationId || null }),
      });
      setSelectedCopyIds([]);
      setBulkMode(false);
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast.success(`Moved ${selectedCopyIds.length} copies`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not move selected copies');
    }
  }

  const collectionNames = useMemo(() => collectionsData?.collections.map(item => item.name) || [], [collectionsData]);
  const seriesNames = useMemo(() => seriesData?.series.map(item => item.name) || [], [seriesData]);
  const items = data?.items || [];
  const pagination = data?.pagination;

  const formatOptions: { value: BookFormat; icon: typeof Book; label: string }[] = [
    { value: 'physical', icon: Book, label: 'Physical' },
    { value: 'ebook', icon: Tablet, label: 'eBook' },
    { value: 'audiobook', icon: Headphones, label: 'Audio' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Collection</h1>
          <p className="mt-1 text-muted-foreground">
            {pagination?.total ?? 0} physical or digital copies in this household
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={bulkMode ? 'default' : 'outline'} className="w-fit" onClick={() => {
            setBulkMode(current => !current);
            setSelectedCopyIds([]);
          }}>
            {bulkMode ? 'Cancel selection' : 'Select copies'}
          </Button>
          <Button type="button" variant="outline" className="w-fit gap-2" onClick={() => setShowBatchScan(true)}>
            <ScanLine className="h-4 w-4" />Batch scan
          </Button>
          <Button type="button" className="gradient-warm w-fit gap-2 text-primary-foreground" onClick={() => setShowAddBook(true)}>
            <Plus className="h-4 w-4" />Add book
          </Button>
        </div>
      </div>

      {bulkMode && (
        <section className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <span className="text-sm font-medium">{selectedCopyIds.length} selected</span>
          <select value={bulkLocationId} onChange={event => setBulkLocationId(event.target.value)} className="h-9 min-w-[220px] rounded-md border border-input bg-background px-3 text-sm">
            <option value="">No physical location</option>
            {(locationsData?.locations || []).map(location => <option key={location.id} value={location.id}>{location.breadcrumb}</option>)}
          </select>
          <Button type="button" size="sm" disabled={!selectedCopyIds.length} onClick={() => void bulkMoveCopies()}>Move selected copies</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setSelectedCopyIds(items.map(item => item.copyId).filter((value): value is string => Boolean(value)))}>Select this page</Button>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] max-w-xl flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search title, author, contributor, ISBN, series, tag, note, location, or custom field"
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {isFetching && <span className="sr-only" aria-live="polite">Updating results</span>}
        </div>
        <Button
          type="button"
          variant={showFilters ? 'default' : 'outline'}
          aria-expanded={showFilters}
          onClick={() => setShowFilters(current => !current)}
        >
          <Filter className="mr-2 h-4 w-4" />Filters
        </Button>
        <select
          aria-label="Sort collection"
          value={sort}
          onChange={event => void savePreferences({ catalogSort: event.target.value })}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="title">Title</option>
          <option value="author">Author</option>
          <option value="series">Series</option>
          <option value="seriesNumber">Series position</option>
          <option value="publicationDate">Publication date</option>
          <option value="dateAdded">Date added</option>
          <option value="owner">Owner</option>
          <option value="location">Location</option>
          <option value="format">Format</option>
          <option value="readingStatus">Reading status</option>
          <option value="rating">Rating</option>
        </select>
        <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Catalog view">
          {([
            ['cover', Grid3X3, 'Cover grid'],
            ['detailed', List, 'Detailed list'],
            ['compact', TableProperties, 'Compact list'],
          ] as const).map(([value, Icon, label]) => (
            <button
              key={value}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={view === value}
              onClick={() => void savePreferences({ catalogView: value })}
              className={`p-2 ${view === value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {(collectionsData?.collections.some(collection => collection.smartFilter) || showFilters) && (
        <section className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3" aria-label="Saved smart shelves">
          <span className="text-sm font-medium">Smart shelves</span>
          {collectionsData?.collections.filter(collection => collection.smartFilter).map(collection => (
            <Button key={collection.id} type="button" size="sm" variant="outline" onClick={() => applySmartShelf(collection.smartFilter!)}>
              {collection.name}
            </Button>
          ))}
          {showFilters && (
            <div className="ml-auto flex min-w-[240px] gap-2">
              <input
                value={smartShelfName}
                onChange={event => setSmartShelfName(event.target.value)}
                placeholder="Name current filter"
                maxLength={100}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              />
              <Button type="button" size="sm" disabled={!smartShelfName.trim()} onClick={() => void createSmartShelf()}>Save</Button>
            </div>
          )}
        </section>
      )}

      {showFilters && (
        <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label="Catalog filters">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Format</span>
            {formatOptions.map(option => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={formatFilters.includes(option.value) ? 'default' : 'outline'}
                aria-pressed={formatFilters.includes(option.value)}
                onClick={() => toggleFormat(option.value)}
              >
                <option.icon className="mr-1 h-3.5 w-3.5" />{option.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Reading</span>
            {[
              ['unread', 'Unread'], ['want_to_read', 'Want to read'], ['reading', 'Reading'],
              ['paused', 'Paused'], ['did_not_finish', 'Did not finish'], ['read', 'Read'],
              ['reference', 'Reference'], ['abandoned', 'Abandoned'],
            ].map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={readingFilters.includes(value) ? 'default' : 'outline'}
                aria-pressed={readingFilters.includes(value)}
                onClick={() => toggleReadingStatus(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="collection-location" className="text-sm font-medium">Location and descendants</label>
            <select
              id="collection-location"
              value={locationId}
              onChange={event => setLocationId(event.target.value)}
              className="h-9 max-w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All locations</option>
              {(locationsData?.locations || []).map(location => (
                <option key={location.id} value={location.id}>{location.breadcrumb}</option>
              ))}
            </select>
            {(formatFilters.length > 0 || readingFilters.length > 0 || locationId) && (
              <Button type="button" size="sm" variant="ghost" onClick={() => {
                setFormatFilters([]);
                setReadingFilters([]);
                setLocationId('');
              }}>
                Clear filters
              </Button>
            )}
          </div>
          {view !== 'cover' && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">Visible columns</summary>
              <div className="mt-2 flex flex-wrap gap-3">
                {Object.entries(columnLabels).map(([column, label]) => (
                  <label key={column} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={visibleColumns.includes(column)}
                      onChange={() => {
                        const next = visibleColumns.includes(column)
                          ? visibleColumns.filter(value => value !== column)
                          : [...visibleColumns, column];
                        void savePreferences({ visibleColumns: next });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading the household collection…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load the collection'}
        </div>
      ) : view === 'cover' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map(item => (
            <div key={item.id} className="relative">
              {bulkMode && (
                <label className="absolute left-2 top-2 z-20 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-background shadow">
                  <input type="checkbox" aria-label={`Select ${item.book.title}`} checked={Boolean(item.copyId && selectedCopyIds.includes(item.copyId))} onChange={() => toggleCopySelection(item.copyId)} />
                </label>
              )}
              <BookCard userBook={item} onSelect={bulkMode ? selected => toggleCopySelection(selected.copyId) : setEditingBook} />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className={`w-full text-left ${view === 'compact' ? 'text-xs' : 'text-sm'}`}>
            <thead className="border-b border-border bg-muted/60">
              <tr>
                {bulkMode && <th className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>}
                {visibleColumns.map(column => <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">{columnLabels[column]}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr
                  key={item.id}
                  tabIndex={0}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
                  onClick={() => bulkMode ? toggleCopySelection(item.copyId) : setEditingBook(item)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (bulkMode) toggleCopySelection(item.copyId);
                      else setEditingBook(item);
                    }
                  }}
                >
                  {bulkMode && <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${item.book.title}`} checked={Boolean(item.copyId && selectedCopyIds.includes(item.copyId))} onChange={() => toggleCopySelection(item.copyId)} onClick={event => event.stopPropagation()} /></td>}
                  {visibleColumns.map(column => (
                    <td key={column} className="max-w-[260px] px-3 py-2 align-top">
                      {column === 'cover' && (
                        <div className={`${view === 'compact' ? 'h-10 w-7' : 'h-16 w-11'} overflow-hidden rounded bg-muted`}>
                          {item.book.coverUrl && <img src={item.book.coverUrl} alt="" className="h-full w-full object-cover" />}
                        </div>
                      )}
                      {column === 'title' && <span className="font-medium"><Highlighted value={item.book.title} query={deferredSearch} /></span>}
                      {column === 'author' && <Highlighted value={item.book.author} query={deferredSearch} />}
                      {column === 'series' && <Highlighted value={item.book.series ? `${item.book.series}${item.book.seriesNumber ? ` #${item.book.seriesNumber}` : ''}` : ''} query={deferredSearch} />}
                      {column === 'isbn' && <Highlighted value={item.book.isbn} query={deferredSearch} />}
                      {column === 'edition' && [item.book.binding && bindingLabels[item.book.binding], item.book.edition].filter(Boolean).join(' · ')}
                      {column === 'copies' && `${item.counts?.workCopies || 0} / ${item.counts?.editions || 0} editions`}
                      {column === 'owner' && item.owner?.name}
                      {column === 'location' && <Highlighted value={item.storageLocation} query={deferredSearch} />}
                      {column === 'format' && item.formats.join(', ')}
                      {column === 'condition' && [item.conditionGrade && conditionLabels[item.conditionGrade], item.conditionNotes].filter(Boolean).join(' · ')}
                      {column === 'readingStatus' && item.readStatus.replaceAll('_', ' ')}
                      {column === 'rating' && (item.rating == null ? '' : item.rating)}
                      {column === 'loan' && (item.activeLoan ? `${item.activeLoan.borrower}${item.activeLoan.overdue ? ' · overdue' : ''}` : '')}
                      {column === 'dateAdded' && new Date(item.dateAdded).toLocaleDateString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="py-16 text-center text-muted-foreground">
          <p className="text-lg font-heading">No matching copies</p>
          <p className="mt-1 text-sm">{pagination?.total ? 'Try another page.' : 'Change the search or filters, or add a book.'}</p>
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="Catalog pages">
          <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</span>
          <Button type="button" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage(value => value + 1)}>Next</Button>
        </nav>
      )}

      <AddBookDialog
        open={showAddBook}
        onOpenChange={setShowAddBook}
        collections={collectionNames}
        seriesNames={seriesNames}
      />
      <BatchScanDialog open={showBatchScan} onOpenChange={setShowBatchScan} />
      <EditBookDialog
        book={editingBook}
        open={Boolean(editingBook)}
        onOpenChange={open => { if (!open) setEditingBook(null); }}
      />
    </div>
  );
}
