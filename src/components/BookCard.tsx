import { UserBook } from '@/types/book';
import { Star, BookOpen, MapPin, Book, Headphones, Tablet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { bindingLabels, conditionLabels } from '@/lib/book-copy';

interface BookCardProps {
  userBook: UserBook;
  compact?: boolean;
  onSelect?: (book: UserBook) => void;
}

const formatIcons = {
  physical: { icon: Book, label: 'Physical' },
  ebook: { icon: Tablet, label: 'eBook' },
  audiobook: { icon: Headphones, label: 'Audiobook' },
} as const;

export default function BookCard({ userBook, compact, onSelect }: BookCardProps) {
  const { book, readStatus, rating, storageLocation, priority, tags, formats } = userBook;

  return (
    <div
      className={`group bg-card rounded-lg border border-border shadow-card hover:shadow-card-hover transition-all duration-300 overflow-hidden ${onSelect ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring' : ''}`}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `Edit ${book.title}` : undefined}
      onClick={() => onSelect?.(userBook)}
      onKeyDown={event => {
        if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(userBook);
        }
      }}
    >
      {/* Cover */}
      <div className="relative aspect-[2/3] overflow-hidden bg-muted">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
        {/* Status badge */}
        <div className="absolute top-2 right-2">
          <Badge
            variant={readStatus === 'read' ? 'default' : readStatus === 'reading' ? 'secondary' : 'outline'}
            className={
              readStatus === 'read'
                ? 'bg-accent text-accent-foreground text-[10px]'
                : readStatus === 'reading'
                ? 'bg-primary text-primary-foreground text-[10px]'
                : 'bg-card/80 text-foreground text-[10px]'
            }
          >
            {readStatus === 'read' ? 'Read' : readStatus === 'reading' ? 'Reading' : 'Unread'}
          </Badge>
        </div>
        {userBook.loanedOut && (
          <div className="absolute left-2 top-2">
            <Badge className="bg-amber-500 text-[10px] text-amber-950 hover:bg-amber-500">
              Loaned
            </Badge>
          </div>
        )}
        {priority && !userBook.loanedOut && (
          <div className="absolute top-2 left-2">
            <Badge className={
              priority === 'high' ? 'bg-destructive text-destructive-foreground text-[10px]' :
              priority === 'medium' ? 'bg-primary text-primary-foreground text-[10px]' :
              'bg-muted text-muted-foreground text-[10px]'
            }>
              {priority}
            </Badge>
          </div>
        )}
        {/* Format icons */}
        {formats && formats.length > 0 && (
          <div className="absolute bottom-2 left-2 flex gap-1">
            {formats.map(f => {
              const FormatIcon = formatIcons[f].icon;
              return (
                <div key={f} className="w-5 h-5 rounded-full bg-card/90 flex items-center justify-center" title={formatIcons[f].label}>
                  <FormatIcon className="h-3 w-3 text-foreground" />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Info */}
      {!compact && (
        <div className="p-3 space-y-1.5">
          <h3 className="font-heading font-semibold text-sm text-foreground leading-tight line-clamp-2">{book.title}</h3>
          <p className="text-xs text-muted-foreground">{book.author}</p>

          {book.series && (
            <p className="text-[10px] text-primary font-medium">
              {book.series}{book.seriesNumber ? ` #${book.seriesNumber}` : ''}
            </p>
          )}
          {book.collection && (
            <p className="text-[10px] text-muted-foreground font-medium">{book.collection}</p>
          )}
          {(book.binding || book.edition) && (
            <p className="line-clamp-1 text-[10px] text-muted-foreground">
              {[book.binding && bindingLabels[book.binding], book.edition].filter(Boolean).join(' · ')}
            </p>
          )}
          {(userBook.conditionGrade || userBook.loanedOut) && (
            <p className="line-clamp-1 text-[10px] font-medium text-muted-foreground">
              {[
                userBook.conditionGrade && `${conditionLabels[userBook.conditionGrade]} condition`,
                userBook.loanedOut && `Loaned${userBook.loanedTo ? ` to ${userBook.loanedTo}` : ''}`,
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          <div className="flex items-center justify-between pt-1">
            {rating && (
              <div className="flex items-center gap-0.5">
                <Star className="h-3 w-3 text-primary fill-primary" />
                <span className="text-xs font-medium text-foreground">{rating}/10</span>
              </div>
            )}
            {storageLocation && (
              <div className="flex items-center gap-0.5 text-muted-foreground">
                <MapPin className="h-3 w-3" />
                <span className="text-[10px] truncate max-w-[80px]">{storageLocation}</span>
              </div>
            )}
          </div>

          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground">{tag}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
