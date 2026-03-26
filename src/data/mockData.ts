import { Book, UserBook, Series, CollectionStats } from '@/types/book';

const books: Book[] = [
  { id: '1', isbn: '9780261103573', title: 'The Fellowship of the Ring', author: 'J.R.R. Tolkien', series: 'The Lord of the Rings', seriesNumber: 1, genre: 'Fantasy', pageCount: 423, publishedYear: 1954, coverUrl: 'https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=300&h=450&fit=crop' },
  { id: '2', isbn: '9780261102361', title: 'The Two Towers', author: 'J.R.R. Tolkien', series: 'The Lord of the Rings', seriesNumber: 2, genre: 'Fantasy', pageCount: 352, publishedYear: 1954, coverUrl: 'https://images.unsplash.com/photo-1543002588-bfa74002ed7e?w=300&h=450&fit=crop' },
  { id: '3', isbn: '9780261102378', title: 'The Return of the King', author: 'J.R.R. Tolkien', series: 'The Lord of the Rings', seriesNumber: 3, genre: 'Fantasy', pageCount: 416, publishedYear: 1955, coverUrl: 'https://images.unsplash.com/photo-1512820790803-83ca734da794?w=300&h=450&fit=crop' },
  { id: '4', isbn: '9780747532699', title: "Harry Potter and the Philosopher's Stone", author: 'J.K. Rowling', series: 'Harry Potter', seriesNumber: 1, genre: 'Fantasy', pageCount: 332, publishedYear: 1997, coverUrl: 'https://images.unsplash.com/photo-1589998059171-988d887df646?w=300&h=450&fit=crop' },
  { id: '5', isbn: '9780140283334', title: '1984', author: 'George Orwell', genre: 'Dystopian', pageCount: 328, publishedYear: 1949, coverUrl: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?w=300&h=450&fit=crop' },
  { id: '6', isbn: '9780060935467', title: 'To Kill a Mockingbird', author: 'Harper Lee', genre: 'Classic', pageCount: 281, publishedYear: 1960, coverUrl: 'https://images.unsplash.com/photo-1476275466078-4007374efbbe?w=300&h=450&fit=crop' },
  { id: '7', isbn: '9780141187761', title: 'Brave New World', author: 'Aldous Huxley', genre: 'Dystopian', pageCount: 288, publishedYear: 1932, coverUrl: 'https://images.unsplash.com/photo-1524578271613-d550eacf6090?w=300&h=450&fit=crop' },
  { id: '8', isbn: '9780060850524', title: 'Brave New World Revisited', author: 'Aldous Huxley', genre: 'Non-fiction', pageCount: 123, publishedYear: 1958, coverUrl: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=300&h=450&fit=crop' },
];

export const mockUserBooks: UserBook[] = [
  { id: 'ub1', bookId: '1', book: books[0], status: 'owned', readStatus: 'read', rating: 9, purchasePrice: 12.99, storageLocation: 'Living Room Shelf A', tags: ['fantasy', 'favorite'], dateAdded: '2024-01-15', dateRead: '2024-02-20', notes: 'One of the greatest fantasy novels ever written.' },
  { id: 'ub2', bookId: '2', book: books[1], status: 'owned', readStatus: 'read', rating: 8, purchasePrice: 11.99, storageLocation: 'Living Room Shelf A', tags: ['fantasy'], dateAdded: '2024-01-15', dateRead: '2024-03-10' },
  { id: 'ub3', bookId: '3', book: books[2], status: 'owned', readStatus: 'unread', purchasePrice: 13.99, storageLocation: 'Living Room Shelf A', tags: ['fantasy'], dateAdded: '2024-01-15' },
  { id: 'ub4', bookId: '4', book: books[3], status: 'owned', readStatus: 'reading', rating: 7, purchasePrice: 9.99, storageLocation: 'Bedroom Shelf', tags: ['fantasy', 'ya'], dateAdded: '2024-02-01' },
  { id: 'ub5', bookId: '5', book: books[4], status: 'owned', readStatus: 'read', rating: 10, purchasePrice: 8.99, storageLocation: 'Office Desk', tags: ['classic', 'dystopian', 'favorite'], dateAdded: '2023-12-01', dateRead: '2024-01-05' },
  { id: 'ub6', bookId: '6', book: books[5], status: 'wishlist', readStatus: 'unread', dateAdded: '2024-03-01' },
  { id: 'ub7', bookId: '7', book: books[6], status: 'backlog', readStatus: 'unread', priority: 'high', sortOrder: 1, dateAdded: '2024-02-15' },
  { id: 'ub8', bookId: '8', book: books[7], status: 'backlog', readStatus: 'unread', priority: 'medium', sortOrder: 2, dateAdded: '2024-03-10' },
];

export const mockSeries: Series[] = [
  {
    id: 's1',
    name: 'The Lord of the Rings',
    totalBooks: 3,
    ownedBooks: 3,
    readBooks: 2,
    books: mockUserBooks.filter(ub => ub.book.series === 'The Lord of the Rings'),
  },
  {
    id: 's2',
    name: 'Harry Potter',
    totalBooks: 7,
    ownedBooks: 1,
    readBooks: 0,
    books: [
      mockUserBooks.find(ub => ub.book.series === 'Harry Potter')!,
      ...[2,3,4,5,6,7].map(n => ({ book: { id: `hp${n}`, title: `Harry Potter Book ${n}`, author: 'J.K. Rowling', series: 'Harry Potter', seriesNumber: n, genre: 'Fantasy' } as Book, owned: false as const })),
    ],
  },
];

export const mockStats: CollectionStats = {
  totalBooks: mockUserBooks.filter(ub => ub.status === 'owned').length,
  booksRead: mockUserBooks.filter(ub => ub.readStatus === 'read').length,
  booksUnread: mockUserBooks.filter(ub => ub.status === 'owned' && ub.readStatus === 'unread').length,
  wishlistCount: mockUserBooks.filter(ub => ub.status === 'wishlist').length,
  backlogCount: mockUserBooks.filter(ub => ub.status === 'backlog').length,
  totalValue: mockUserBooks.reduce((sum, ub) => sum + (ub.purchasePrice || 0), 0),
  averageRating: (() => { const rated = mockUserBooks.filter(ub => ub.rating); return rated.length ? rated.reduce((s, ub) => s + ub.rating!, 0) / rated.length : 0; })(),
  seriesCount: mockSeries.length,
};
