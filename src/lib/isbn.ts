export function normalizeIsbn(value: unknown) {
  const normalized = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (/^97[89]\d{10}$/.test(normalized)) {
    const sum = [...normalized].reduce(
      (total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1),
      0,
    );
    return sum % 10 === 0 ? normalized : '';
  }
  if (/^\d{9}[\dX]$/.test(normalized)) {
    const sum = [...normalized].reduce(
      (total, digit, index) => total + (digit === 'X' ? 10 : Number(digit)) * (10 - index),
      0,
    );
    return sum % 11 === 0 ? normalized : '';
  }
  return '';
}

export function isbnFromBarcode(value: unknown) {
  const normalized = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  const candidates = [normalized, normalized.slice(0, 13)];
  return candidates
    .map(candidate => normalizeIsbn(candidate))
    .find(candidate => candidate.length === 13) || '';
}
