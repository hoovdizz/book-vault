import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { BookOpen, Eye, Heart, ListTodo, Library, Layers, User, Glasses } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import EditBookDialog from '@/components/EditBookDialog';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';

export default function Dashboard() {
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['books'],
    queryFn: () => api<{ books: UserBook[] }>('/api/books'),
  });
  const books = useMemo(() => data?.books || [], [data?.books]);
  const ownedBooks = books.filter(book => book.status === 'owned');
  const recentBooks = ownedBooks.slice(0, 4);
  const currentlyReading = books.filter(book => book.readStatus === 'reading');
  const stats = useMemo(() => [
    { label: 'Total Books', value: books.length, icon: BookOpen, color: 'text-primary' },
    { label: 'Books Read', value: books.filter(book => book.readStatus === 'read').length, icon: Eye, color: 'text-accent' },
    { label: 'Currently Reading', value: currentlyReading.length, icon: Glasses, color: 'text-primary' },
    { label: 'Collection', value: ownedBooks.length, icon: Library, color: 'text-accent' },
    { label: 'Wishlist', value: books.filter(book => book.status === 'wishlist').length, icon: Heart, color: 'text-chart-wishlist' },
    { label: 'Backlog', value: books.filter(book => book.status === 'backlog').length, icon: ListTodo, color: 'text-chart-backlog' },
    { label: 'Series', value: new Set(books.map(book => book.book.series).filter(Boolean)).size, icon: Layers, color: 'text-primary' },
    { label: 'Loaned Out', value: books.filter(book => book.status === 'owned' && book.loanedOut).length, icon: User, color: 'text-muted-foreground' },
  ], [books, currentlyReading.length, ownedBooks.length]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Your reading life at a glance</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="bg-card rounded-lg p-4 shadow-card border border-border"
          >
            <div className="flex items-center justify-between mb-2">
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
            </div>
            <p className="text-2xl font-heading font-bold text-foreground">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
          </motion.div>
        ))}
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading your dashboard…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load your books'}
        </div>
      ) : currentlyReading.length > 0 && (
        <section>
          <h2 className="text-xl font-heading font-semibold text-foreground mb-4">Currently Reading</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {currentlyReading.map(ub => (
              <BookCard key={ub.id} userBook={ub} onSelect={setEditingBook} />
            ))}
          </div>
        </section>
      )}

      {/* Recent Collection */}
      <section>
        <h2 className="text-xl font-heading font-semibold text-foreground mb-4">Recent Additions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {recentBooks.length ? recentBooks.map(ub => (
            <BookCard key={ub.id} userBook={ub} onSelect={setEditingBook} />
          )) : (
            <p className="col-span-full py-8 text-center text-muted-foreground">Your collection is empty.</p>
          )}
        </div>
      </section>

      <EditBookDialog
        book={editingBook}
        open={Boolean(editingBook)}
        onOpenChange={open => { if (!open) setEditingBook(null); }}
      />
    </div>
  );
}
