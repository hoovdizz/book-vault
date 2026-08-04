import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Heart, Plus, ArrowRight, Loader2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import AddBookDialog from '@/components/AddBookDialog';
import EditBookDialog from '@/components/EditBookDialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';

export default function Wishlist() {
  const queryClient = useQueryClient();
  const [showAddBook, setShowAddBook] = useState(false);
  const [movingBookId, setMovingBookId] = useState<string | null>(null);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['books'],
    queryFn: () => api<{ books: UserBook[] }>('/api/books'),
  });
  const books = useMemo(() => data?.books || [], [data?.books]);
  const wishlistBooks = books.filter(book => book.status === 'wishlist');
  const collections = useMemo(
    () => [...new Set(books.map(item => item.book.collection).filter((value): value is string => Boolean(value)))].sort(),
    [books],
  );
  const seriesNames = useMemo(
    () => [...new Set(books.map(item => item.book.series).filter((value): value is string => Boolean(value)))].sort(),
    [books],
  );

  async function handleMoveToCollection(book: UserBook) {
    setMovingBookId(book.id);
    try {
      await api(`/api/books/${book.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'owned' }),
      });
      await queryClient.invalidateQueries({ queryKey: ['books'] });
      toast.success(`Moved “${book.book.title}” to your collection`);
    } catch (moveError) {
      toast.error(moveError instanceof Error ? moveError.message : 'Could not move book');
    } finally {
      setMovingBookId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Wishlist</h1>
          <p className="text-muted-foreground mt-1">{wishlistBooks.length} books you'd love to own</p>
        </div>
        <Button
          type="button"
          className="gradient-warm text-primary-foreground gap-2 w-fit"
          onClick={() => setShowAddBook(true)}
        >
          <Plus className="h-4 w-4" />
          Add to Wishlist
        </Button>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading your wishlist…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load your wishlist'}
        </div>
      ) : wishlistBooks.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {wishlistBooks.map((ub, i) => (
            <motion.div
              key={ub.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              className="relative"
            >
              <BookCard userBook={ub} onSelect={setEditingBook} />
              <div className="mt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full text-xs gap-1 border-border text-foreground hover:bg-accent hover:text-accent-foreground"
                  disabled={movingBookId === ub.id}
                  onClick={() => handleMoveToCollection(ub)}
                >
                  {movingBookId === ub.id
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <ArrowRight className="h-3 w-3" />}
                  Move to Collection
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <Heart className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-lg font-heading">Your wishlist is empty</p>
          <p className="text-sm mt-1">Search for books to add to your wishlist</p>
        </div>
      )}

      <AddBookDialog
        open={showAddBook}
        onOpenChange={setShowAddBook}
        collections={collections}
        seriesNames={seriesNames}
        destination="wishlist"
      />
      <EditBookDialog
        book={editingBook}
        open={Boolean(editingBook)}
        onOpenChange={open => { if (!open) setEditingBook(null); }}
      />
    </div>
  );
}
