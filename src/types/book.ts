export interface CoverOption {
  url: string;
  source: string;
  label: string;
}

export interface Book {
  id: string;
  isbn?: string;
  title: string;
  author: string;
  series?: string;
  seriesNumber?: string | number;
  collection?: string;
  coverUrl?: string;
  coverOptions?: CoverOption[];
  genre?: string;
  pageCount?: number;
  publishedYear?: number;
  publisher?: string;
  description?: string;
  source?: 'google_books' | 'open_library' | 'manual';
  sourceId?: string;
}

export interface BookSearchResult extends Omit<Book, 'id'> {
  source: 'google_books' | 'open_library';
  sourceLabel: string;
  sourceId: string;
  identifiers?: string[];
  coverOptions: CoverOption[];
}

export type BookFormat = 'physical' | 'ebook' | 'audiobook';

export interface UserBook {
  id: string;
  bookId: string;
  book: Book;
  status: 'owned' | 'wishlist' | 'backlog';
  readStatus: 'read' | 'unread' | 'reading';
  formats: BookFormat[];
  rating?: number;
  purchasePrice?: number;
  storageLocation?: string;
  notes?: string;
  tags?: string[];
  priority?: 'high' | 'medium' | 'low';
  sortOrder?: number;
  dateAdded: string;
  dateRead?: string;
}

export interface Series {
  id: string;
  name: string;
  totalBooks: number;
  ownedBooks: number;
  readBooks: number;
  books: (UserBook | { book: Book; owned: false })[];
}

export interface CollectionStats {
  totalBooks: number;
  booksRead: number;
  booksUnread: number;
  wishlistCount: number;
  backlogCount: number;
  totalValue: number;
  averageRating: number;
  seriesCount: number;
}
