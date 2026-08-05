import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import BookCard from '@/components/BookCard';
import EditBookDialog from '@/components/EditBookDialog';
import { fetchCatalog } from '@/lib/catalog';
import { UserBook } from '@/types/book';

export default function Backlog() {
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['catalog', 'backlog'],
    queryFn: () => fetchCatalog({ status: ['backlog'], pageSize: 100, sort: 'dateAdded', direction: 'desc' }),
  });
  const books = data?.items || [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold">Reading backlog</h1>
        <p className="mt-1 text-muted-foreground">{data?.pagination.total || 0} books queued for later</p>
      </div>
      {isLoading ? (
        <div className="py-16 text-center text-muted-foreground">Loading the backlog…</div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not load the backlog'}
        </div>
      ) : books.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {books.map(book => <BookCard key={book.id} userBook={book} onSelect={setEditingBook} />)}
        </div>
      ) : (
        <div className="py-16 text-center text-muted-foreground">
          <p className="text-lg font-heading">Your backlog is empty</p>
        </div>
      )}
      <EditBookDialog book={editingBook} open={Boolean(editingBook)} onOpenChange={open => { if (!open) setEditingBook(null); }} />
    </div>
  );
}
