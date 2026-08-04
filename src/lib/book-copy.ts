import { BookBinding, BookCondition } from '@/types/book';

export const bindingLabels: Record<BookBinding, string> = {
  hardcover: 'Hardcover',
  paperback: 'Paperback',
  mass_market_paperback: 'Mass-market paperback',
  library_binding: 'Library binding',
  spiral_bound: 'Spiral bound',
  other: 'Other',
};

export const conditionLabels: Record<BookCondition, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
};
