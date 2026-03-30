import { useState } from 'react';
import { motion } from 'framer-motion';
import { Search, Filter, Grid3X3, List, Plus, Book, Tablet, Headphones } from 'lucide-react';
import { mockUserBooks } from '@/data/mockData';
import BookCard from '@/components/BookCard';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { BookFormat } from '@/types/book';

export default function Collection() {
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [formatFilter, setFormatFilter] = useState<BookFormat | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const ownedBooks = mockUserBooks.filter(ub => ub.status === 'owned');
  const filtered = ownedBooks.filter(ub => {
    const matchesSearch =
      ub.book.title.toLowerCase().includes(search.toLowerCase()) ||
      ub.book.author.toLowerCase().includes(search.toLowerCase());
    const matchesFormat = !formatFilter || ub.formats.includes(formatFilter);
    return matchesSearch && matchesFormat;
  });

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
          onClick={() => toast.info('Add Book dialog coming soon — connect Lovable Cloud for full functionality.')}
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
            placeholder="Search by title or author..."
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
        </div>
      )}

      {/* Book Grid */}
      {view === 'grid' ? (
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

      {filtered.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg font-heading">No books found</p>
          <p className="text-sm mt-1">Try a different search or filter</p>
        </div>
      )}
    </div>
  );
}
