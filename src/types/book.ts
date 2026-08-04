export interface CoverOption {
  url: string;
  source: string;
  label: string;
}

export type BookSource = 'google_books' | 'open_library' | 'manual';
export type BookBinding = 'hardcover' | 'paperback' | 'mass_market_paperback' | 'library_binding' | 'spiral_bound' | 'other';
export type BookCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'damaged';

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
  binding?: BookBinding;
  edition?: string;
  source?: BookSource;
  sourceId?: string;
}

export interface BookSearchResult extends Omit<Book, 'id'> {
  source: BookSource;
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
  conditionGrade?: BookCondition;
  conditionNotes?: string;
  loanedOut: boolean;
  loanedTo?: string;
  loanedAt?: string;
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
