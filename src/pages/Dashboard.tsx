import { useState } from 'react';
import { BookOpen, Clock3, Eye, Glasses, Heart, Library, Timer, UserRoundCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import EditBookDialog from '@/components/EditBookDialog';
import { api } from '@/lib/auth';
import { fetchCatalog } from '@/lib/catalog';
import { UserBook } from '@/types/book';

export default function Dashboard() {
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data: recent, isLoading, error } = useQuery({
    queryKey: ['catalog', 'dashboard-recent'],
    queryFn: () => fetchCatalog({ status: ['owned'], pageSize: 4, sort: 'dateAdded', direction: 'desc' }),
  });
  const { data: reading } = useQuery({
    queryKey: ['catalog', 'dashboard-reading'],
    queryFn: () => fetchCatalog({ readStatus: ['reading'], pageSize: 4, sort: 'title' }),
  });
  const { data: catalogStats } = useQuery({
    queryKey: ['catalog-stats'],
    queryFn: () => api<{ stats: { works: number; editions: number; copies: number; wishlist: number; active_loans: number; overdue_loans: number } }>('/api/catalog/stats'),
  });
  const { data: personalStats } = useQuery({
    queryKey: ['reading-statistics'],
    queryFn: () => api<{ totals: { booksCompleted: number; pagesRead: number; minutesRead: number; readingStreakDays: number } }>('/api/reading/statistics'),
  });
  const { data: activity } = useQuery({
    queryKey: ['catalog-activity'],
    queryFn: () => api<Record<'recentlyMoved' | 'recentlyLoaned' | 'recentlyRead' | 'previouslyOwned', {
      title: string;
      author: string;
      at: string;
      detail: string;
    }[]>>('/api/catalog/activity'),
  });
  const stats = [
    { label: 'Household works', value: catalogStats?.stats.works || 0, icon: BookOpen },
    { label: 'Owned copies', value: catalogStats?.stats.copies || 0, icon: Library },
    { label: 'Books completed', value: personalStats?.totals.booksCompleted || 0, icon: Eye },
    { label: 'Currently reading', value: reading?.pagination.total || 0, icon: Glasses },
    { label: 'Pages read', value: personalStats?.totals.pagesRead || 0, icon: Clock3 },
    { label: 'Minutes read', value: personalStats?.totals.minutesRead || 0, icon: Timer },
    { label: 'Wishlist', value: catalogStats?.stats.wishlist || 0, icon: Heart },
    { label: 'Overdue loans', value: catalogStats?.stats.overdue_loans || 0, icon: UserRoundCheck },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Private reading progress and shared household inventory at a glance</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map(stat => (
          <div key={stat.label} className="rounded-lg border border-border bg-card p-4 shadow-card">
            <stat.icon className="mb-2 h-5 w-5 text-primary" />
            <p className="text-2xl font-heading font-bold">{stat.value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading the dashboard…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load the dashboard'}
        </div>
      ) : null}

      {(reading?.items.length || 0) > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-heading font-semibold">Currently reading</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {reading?.items.map(book => <BookCard key={book.id} userBook={book} onSelect={setEditingBook} />)}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-heading font-semibold">Recently added copies</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {recent?.items.length ? recent.items.map(book => (
            <BookCard key={book.id} userBook={book} onSelect={setEditingBook} />
          )) : (
            <p className="col-span-full py-8 text-center text-muted-foreground">The collection is empty.</p>
          )}
        </div>
      </section>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {([
          ['Recently moved', activity?.recentlyMoved || []],
          ['Recently read', activity?.recentlyRead || []],
          ['Recently loaned', activity?.recentlyLoaned || []],
          ['Previously owned', activity?.previouslyOwned || []],
        ] as const).map(([label, rows]) => (
          <div key={label} className="rounded-lg border border-border bg-card p-4">
            <h2 className="font-heading font-semibold">{label}</h2>
            {rows.slice(0, 5).map((row, index) => (
              <div key={`${row.title}:${row.at}:${index}`} className="mt-3 border-t border-border pt-2 text-sm first:border-0">
                <p className="font-medium">{row.title}</p>
                <p className="text-xs text-muted-foreground">{row.detail} · {new Date(row.at).toLocaleDateString()}</p>
              </div>
            ))}
            {!rows.length && <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>}
          </div>
        ))}
      </section>
      <EditBookDialog book={editingBook} open={Boolean(editingBook)} onOpenChange={open => { if (!open) setEditingBook(null); }} />
    </div>
  );
}
