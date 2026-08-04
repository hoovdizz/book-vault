import { describe, expect, it } from 'vitest';
import { isbnFromBarcode, normalizeIsbn } from '@/lib/isbn';

describe('ISBN scanning', () => {
  it('accepts valid ISBN-13 Bookland barcodes', () => {
    expect(isbnFromBarcode('978-0-261-10357-3')).toBe('9780261103573');
    expect(isbnFromBarcode('9780306406157')).toBe('9780306406157');
  });

  it('rejects non-book and invalid barcodes', () => {
    expect(isbnFromBarcode('4006381333931')).toBe('');
    expect(isbnFromBarcode('9780306406158')).toBe('');
  });

  it('keeps valid ISBN-10 available for typed searches but not barcode scans', () => {
    expect(normalizeIsbn('0-261-10357-1')).toBe('0261103571');
    expect(isbnFromBarcode('0261103571')).toBe('');
  });
});
