import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import EditBookDialog from '@/components/EditBookDialog';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';

export default function Backlog() {
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['books'],
    queryFn: () => api<{ books: UserBook[] }>('/api/books'),
  });
  const backlogBooks = (data?.books || []).filter(book => book.status === 'backlog');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold text-foreground">Reading Backlog</h1>
        <p className="text-muted-foreground mt-1">{backlogBooks.length} books waiting to be read</p>
      </div>

      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading your backlog…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load your backlog'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {backlogBooks.map((book, index) => (
            <motion.div
              key={book.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
            >
              <BookCard userBook={book} onSelect={setEditingBook} />
            </motion.div>
          ))}
        </div>
      )}

      {!isLoading && !error && backlogBooks.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg font-heading">Your backlog is empty</p>
          <p className="text-sm mt-1">Add books you want to read next</p>
        </div>
      )}

      <EditBookDialog
        book={editingBook}
        open={Boolean(editingBook)}
        onOpenChange={open => { if (!open) setEditingBook(null); }}
      />
    </div>
  );
}
