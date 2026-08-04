import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, Grid3X3, List, Plus, Book, Tablet, Headphones } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import AddBookDialog from '@/components/AddBookDialog';
import { Button } from '@/components/ui/button';
import { BookFormat, UserBook } from '@/types/book';
import { api } from '@/lib/auth';

export default function Collection() {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [formatFilter, setFormatFilter] = useState<BookFormat | null>(null);
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showAddBook, setShowAddBook] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['books'],
    queryFn: () => api<{ books: UserBook[] }>('/api/books'),
  });
  const ownedBooks = (data?.books || []).filter(book => book.status === 'owned');
  const filtered = ownedBooks.filter(ub => {
    const needle = search.toLowerCase();
    const matchesSearch =
      ub.book.title.toLowerCase().includes(needle) ||
      ub.book.author.toLowerCase().includes(needle) ||
      ub.book.isbn?.toLowerCase().includes(needle) ||
      ub.book.collection?.toLowerCase().includes(needle) ||
      ub.book.series?.toLowerCase().includes(needle);
    const matchesFormat = !formatFilter || ub.formats.includes(formatFilter);
    const matchesCollection = !collectionFilter || ub.book.collection === collectionFilter;
    return matchesSearch && matchesFormat && matchesCollection;
  });
  const collections = useMemo(
    () => [...new Set(ownedBooks.map(item => item.book.collection).filter((value): value is string => Boolean(value)))].sort(),
    [ownedBooks],
  );
  const seriesNames = useMemo(
    () => [...new Set(ownedBooks.map(item => item.book.series).filter((value): value is string => Boolean(value)))].sort(),
    [ownedBooks],
  );

  const formatOptions: { value: BookFormat; icon: typeof Book; label: string }[] = [
    { value: 'physical', icon: Book, label: 'Physical' },
    { value: 'ebook', icon: Tablet, label: 'eBook' },
    { value: 'audiobook', icon: Headphones, label: 'Audio' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Collection</h1>
          <p className="text-muted-foreground mt-1">{ownedBooks.length} books in your vault</p>
        </div>
        <Button
          type="button"
          className="gradient-warm text-primary-foreground gap-2 w-fit"
          onClick={() => setShowAddBook(true)}
        >
          <Plus className="h-4 w-4" />
          Add Book
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search title, author, ISBN, collection, or series..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-md bg-card border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="border-border"
          onClick={() => setShowFilters(prev => !prev)}
        >
          <Filter className="h-4 w-4" />
        </Button>
        <div className="flex border border-border rounded-md overflow-hidden">
          <button type="button" onClick={() => setView('grid')} className={`p-2 ${view === 'grid' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'}`}>
            <Grid3X3 className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setView('list')} className={`p-2 ${view === 'list' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'}`}>
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Format filter row */}
      {showFilters && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Format:</span>
          <Button
            type="button"
            variant={formatFilter === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFormatFilter(null)}
          >
            All
          </Button>
          {formatOptions.map(f => (
            <Button
              key={f.value}
              type="button"
              variant={formatFilter === f.value ? 'default' : 'outline'}
              size="sm"
              className="gap-1"
              onClick={() => setFormatFilter(formatFilter === f.value ? null : f.value)}
            >
              <f.icon className="h-3 w-3" />
              {f.label}
            </Button>
          ))}
          {collections.length > 0 && (
            <>
              <span className="ml-2 text-sm text-muted-foreground">Collection:</span>
              <Button
                type="button"
                variant={collectionFilter === null ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCollectionFilter(null)}
              >
                All
              </Button>
              {collections.map(collection => (
                <Button
                  key={collection}
                  type="button"
                  variant={collectionFilter === collection ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setCollectionFilter(collectionFilter === collection ? null : collection)}
                >
                  {collection}
                </Button>
              ))}
            </>
          )}
        </div>
      )}

      {/* Book Grid */}
      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading your collection…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load your collection'}
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filtered.map((ub, i) => (
            <motion.div
              key={ub.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
            >
              <BookCard userBook={ub} />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((ub, i) => (
            <motion.div
              key={ub.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className="flex items-center gap-4 bg-card rounded-lg border border-border p-3 shadow-card hover:shadow-card-hover transition-all"
            >
              <div className="w-12 h-16 rounded overflow-hidden bg-muted flex-shrink-0">
                {ub.book.coverUrl && <img src={ub.book.coverUrl} alt={ub.book.title} className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-heading font-semibold text-foreground truncate">{ub.book.title}</h3>
                <p className="text-sm text-muted-foreground">{ub.book.author}</p>
                {(ub.book.collection || ub.book.series) && (
                  <p className="truncate text-xs text-primary">
                    {[
                      ub.book.collection,
                      ub.book.series && `${ub.book.series}${ub.book.seriesNumber ? ` #${ub.book.seriesNumber}` : ''}`,
                    ].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                {ub.formats.map(f => {
                  const Icon = f === 'physical' ? Book : f === 'ebook' ? Tablet : Headphones;
                  return <span key={f} title={f}><Icon className="h-3.5 w-3.5 text-muted-foreground" /></span>;
                })}
              </div>
              <div className="text-sm text-muted-foreground hidden sm:block">{ub.readStatus}</div>
              {ub.rating && <div className="text-sm font-medium text-primary">{ub.rating}/10</div>}
            </motion.div>
          ))}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg font-heading">No books found</p>
          <p className="text-sm mt-1">
            {ownedBooks.length ? 'Try a different search or filter' : 'Use Add Book to start your persisted collection'}
          </p>
        </div>
      )}

      <AddBookDialog
        open={showAddBook}
        onOpenChange={setShowAddBook}
        collections={collections}
        seriesNames={seriesNames}
      />
    </div>
  );
}
