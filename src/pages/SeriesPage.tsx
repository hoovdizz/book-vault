import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { BookOpen, Layers } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';
import { Badge } from '@/components/ui/badge';

function seriesPosition(book: UserBook) {
  const raw = book.book.seriesNumber;
  if (raw == null || raw === '') return Number.POSITIVE_INFINITY;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

export default function SeriesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['books'],
    queryFn: () => api<{ books: UserBook[] }>('/api/books'),
  });

  const groups = useMemo(() => {
    const bySeries = new Map<string, UserBook[]>();
    for (const item of data?.books || []) {
      if (item.status !== 'owned' || !item.book.series) continue;
      const books = bySeries.get(item.book.series) || [];
      books.push(item);
      bySeries.set(item.book.series, books);
    }
    return [...bySeries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, books]) => ({
        name,
        books: books.sort((left, right) =>
          seriesPosition(left) - seriesPosition(right) || left.book.title.localeCompare(right.book.title)),
      }));
  }, [data?.books]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Series</h1>
        <p className="mt-1 text-muted-foreground">Books grouped by the series metadata in your collection</p>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading your series…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load series'}
        </div>
      ) : groups.length ? (
        <div className="space-y-5">
          {groups.map((series, groupIndex) => (
            <motion.section
              key={series.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: groupIndex * 0.05 }}
              className="overflow-hidden rounded-xl border border-border bg-card shadow-card"
            >
              <header className="flex items-center justify-between border-b border-border px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
                    <Layers className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="font-heading text-xl font-bold text-foreground">{series.name}</h2>
                    <p className="text-sm text-muted-foreground">
                      {series.books.length} {series.books.length === 1 ? 'book' : 'books'} in your collection
                    </p>
                  </div>
                </div>
              </header>

              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {series.books.map(item => (
                  <div key={item.id} className="flex gap-3 rounded-lg border border-border bg-background/50 p-3">
                    <div className="h-24 w-16 flex-shrink-0 overflow-hidden rounded bg-muted">
                      {item.book.coverUrl ? (
                        <img
                          src={item.book.coverUrl}
                          alt={`${item.book.title} cover`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={event => { event.currentTarget.src = '/placeholder.svg'; }}
                        />
                      ) : (
                        <div className="grid h-full place-items-center">
                          <BookOpen className="h-6 w-6 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap gap-1">
                        {item.book.seriesNumber && <Badge variant="secondary">#{item.book.seriesNumber}</Badge>}
                        {item.book.collection && <Badge variant="outline">{item.book.collection}</Badge>}
                      </div>
                      <h3 className="line-clamp-2 font-heading font-semibold text-foreground">{item.book.title}</h3>
                      <p className="line-clamp-1 text-sm text-muted-foreground">{item.book.author}</p>
                    </div>
                  </div>
                ))}
              </div>
            </motion.section>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-muted-foreground">
          <Layers className="mx-auto mb-3 h-9 w-9 opacity-50" />
          <p className="font-heading text-lg">No series yet</p>
          <p className="mt-1 text-sm">Add a series name when saving a book and it will appear here.</p>
        </div>
      )}
    </div>
  );
}
