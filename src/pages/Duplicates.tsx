import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Loader2, RefreshCw, ScanSearch } from 'lucide-react';
import { api } from '@/lib/auth';
import { UserBook } from '@/types/book';
import EditBookDialog from '@/components/EditBookDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type DuplicateResponse = {
  groups: {
    work: { id: string; title: string; author: string };
    copyCount: number;
    editionCount: number;
    copies: {
      id: string;
      editionId: string;
      isbn: string | null;
      binding: string | null;
      edition: string | null;
      coverUrl: string | null;
      format: string;
      condition: string | null;
      owner: { id: string | null; name: string };
      loan: { id: string; status: string } | null;
    }[];
  }[];
  totalGroups: number;
  totalCopies: number;
};

export default function Duplicates() {
  const [hasRun, setHasRun] = useState(false);
  const [editingBook, setEditingBook] = useState<UserBook | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['catalog-duplicates'],
    queryFn: () => api<DuplicateResponse>('/api/catalog/duplicate-groups'),
    enabled: false,
  });

  async function openCopy(copyId: string) {
    setOpeningId(copyId);
    try {
      const detail = await api<{ item: UserBook }>(`/api/catalog/copy/${copyId}`);
      setEditingBook(detail.item);
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold">Duplicate finder</h1>
          <p className="mt-1 text-muted-foreground">Review every extra copy of a work, even when editions, bindings, or ISBNs differ.</p>
        </div>
        <Button type="button" className="w-fit gap-2" onClick={() => { setHasRun(true); void refetch(); }} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : hasRun ? <RefreshCw className="h-4 w-4" /> : <ScanSearch className="h-4 w-4" />}
          {hasRun ? 'Rerun scan' : 'Run duplicate scan'}
        </Button>
      </div>

      {!hasRun && (
        <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
          <ScanSearch className="mx-auto h-10 w-10 text-muted-foreground/60" />
          <h2 className="mt-4 font-heading text-lg font-semibold">Ready to scan the normalized collection</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            A duplicate group is based on the conceptual work, so a signed hardcover and an ordinary paperback still appear together.
          </p>
        </div>
      )}
      {hasRun && error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-destructive">
          {error instanceof Error ? error.message : 'Could not scan the collection'}
        </div>
      )}
      {hasRun && data && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{data.totalGroups} duplicate groups</Badge>
            <Badge variant="secondary">{data.totalCopies} matching copies</Badge>
          </div>
          {data.groups.length ? (
            <div className="space-y-6">
              {data.groups.map(group => (
                <section key={group.work.id} className="rounded-lg border border-border bg-card p-4 shadow-card sm:p-5">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary"><Copy className="h-5 w-5" /></span>
                    <div>
                      <h2 className="font-heading text-xl font-semibold">{group.work.title}</h2>
                      <p className="text-sm text-muted-foreground">
                        {group.work.author} · {group.copyCount} copies across {group.editionCount} {group.editionCount === 1 ? 'edition' : 'editions'}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {group.copies.map(copy => (
                      <button
                        key={copy.id}
                        type="button"
                        className="flex gap-3 rounded-md border border-border p-3 text-left hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
                        onClick={() => void openCopy(copy.id)}
                      >
                        <div className="h-24 w-16 flex-none overflow-hidden rounded bg-muted">
                          {copy.coverUrl && <img src={copy.coverUrl} alt="" className="h-full w-full object-cover" />}
                        </div>
                        <div className="min-w-0 text-sm">
                          <p className="font-medium">{copy.binding || copy.format}{copy.edition ? ` · ${copy.edition}` : ''}</p>
                          <p className="text-muted-foreground">{copy.isbn || 'No ISBN'}</p>
                          <p>{copy.owner.name}</p>
                          {copy.condition && <p className="text-muted-foreground">{copy.condition} condition</p>}
                          {copy.loan && <p className="text-amber-700 dark:text-amber-300">Currently loaned</p>}
                          {openingId === copy.id && <Loader2 className="mt-1 h-3.5 w-3.5 animate-spin" />}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
              <Copy className="mx-auto h-10 w-10 text-muted-foreground/60" />
              <h2 className="mt-4 font-heading text-lg font-semibold">No duplicate copies found</h2>
            </div>
          )}
        </>
      )}
      <EditBookDialog book={editingBook} open={Boolean(editingBook)} onOpenChange={open => { if (!open) setEditingBook(null); }} />
    </div>
  );
}
