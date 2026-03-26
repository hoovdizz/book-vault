import { UserBook } from '@/types/book';
import { Star, BookOpen, MapPin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface BookCardProps {
  userBook: UserBook;
  compact?: boolean;
}

export default function BookCard({ userBook, compact }: BookCardProps) {
  const { book, readStatus, rating, storageLocation, priority, tags } = userBook;

  return (
    <div className="group bg-card rounded-lg border border-border shadow-card hover:shadow-card-hover transition-all duration-300 overflow-hidden">
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
        {priority && (
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
      </div>

      {/* Info */}
      {!compact && (
        <div className="p-3 space-y-1.5">
          <h3 className="font-heading font-semibold text-sm text-foreground leading-tight line-clamp-2">{book.title}</h3>
          <p className="text-xs text-muted-foreground">{book.author}</p>

          {book.series && (
            <p className="text-[10px] text-primary font-medium">{book.series} #{book.seriesNumber}</p>
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
