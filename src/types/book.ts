export interface CoverOption {
  url: string;
  source: string;
  label: string;
}

export interface PriceOption {
  amount: number;
  currency: string;
  label: string;
}

export type BookSource = 'google_books' | 'open_library' | 'manual';
export type BookBinding = 'hardcover' | 'paperback' | 'mass_market_paperback' | 'library_binding' | 'spiral_bound' | 'other';
export type BookCondition = 'new' | 'like_new' | 'good' | 'fair' | 'poor' | 'damaged';

export interface Book {
  id: string;
  isbn?: string;
  isbn10?: string;
  isbn13?: string;
  title: string;
  subtitle?: string;
  author: string;
  series?: string;
  seriesNumber?: string | number;
  collection?: string;
  coverUrl?: string;
  coverOptions?: CoverOption[];
  genre?: string;
  pageCount?: number;
  publishedYear?: number;
  publicationDate?: string;
  publisher?: string;
  description?: string;
  binding?: BookBinding;
  edition?: string;
  source?: BookSource;
  sourceId?: string;
  language?: string;
  readingOrder?: number;
}

export interface BookSearchResult extends Omit<Book, 'id'> {
  source: BookSource;
  sourceLabel: string;
  sourceId: string;
  identifiers?: string[];
  coverOptions: CoverOption[];
  priceOptions?: PriceOption[];
}

export type BookFormat = 'physical' | 'ebook' | 'audiobook';

export interface UserBook {
  id: string;
  kind?: 'copy' | 'list';
  bookId: string;
  workId?: string;
  editionId?: string | null;
  copyId?: string | null;
  book: Book;
  status: 'owned' | 'wishlist' | 'backlog';
  readStatus: 'unread' | 'want_to_read' | 'reading' | 'paused' | 'did_not_finish' | 'read' | 'reference' | 'abandoned' | string;
  formats: BookFormat[];
  conditionGrade?: BookCondition;
  conditionNotes?: string;
  loanedOut: boolean;
  loanedTo?: string;
  loanedAt?: string;
  owner?: { id: string; name: string };
  shared?: boolean;
  canDelete?: boolean;
  rating?: number;
  purchaseDate?: string | null;
  purchasePrice?: number | null;
  purchaseCurrency?: string | null;
  purchaseSource?: string | null;
  estimatedValue?: number | null;
  estimatedCurrency?: string | null;
  customBarcode?: string | null;
  storageLocation?: string;
  notes?: string;
  tags?: string[];
  priority?: 'high' | 'medium' | 'low';
  sortOrder?: number;
  dateAdded: string;
  dateRead?: string;
  location?: {
    id: string;
    name: string;
    breadcrumb: string;
    levelType: string;
  } | null;
  activeLoan?: {
    id: string;
    checkoutAt: string;
    dueAt: string | null;
    status: string;
    borrower: string;
    overdue: boolean;
  } | null;
  counts?: {
    editions: number;
    editionCopies: number;
    workCopies: number;
  };
  list?: {
    scope: 'personal' | 'household';
    priority: 'low' | 'medium' | 'high' | null;
    expectedPrice: number | null;
    expectedCurrency: string | null;
    giftPrivate: boolean;
    intendedRecipientId: string | null;
    purchaseState: string;
    desiredEdition: string | null;
    notes: string;
  } | null;
}

export interface CatalogResponse {
  items: UserBook[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
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
