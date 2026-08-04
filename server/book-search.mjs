const googleBooksEndpoint = "https://www.googleapis.com/books/v1/volumes";
const openLibraryEndpoint = "https://openlibrary.org/search.json";
const coverHosts = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "covers.openlibrary.org",
]);
const googleCoverSizes = ["extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"];

function cleanText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

function first(value) {
  return Array.isArray(value) ? value.find(Boolean) : value;
}

function year(value) {
  const match = cleanText(value, 40).match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : undefined;
}

export function normalizeIsbn(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
  if (/^\d{13}$/.test(normalized)) {
    const sum = [...normalized].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? normalized : "";
  }
  if (/^\d{9}[\dX]$/.test(normalized)) {
    const sum = [...normalized].reduce((total, digit, index) =>
      total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
    return sum % 11 === 0 ? normalized : "";
  }
  return "";
}

export function isIsbnQuery(value) {
  return Boolean(normalizeIsbn(value));
}

export function normalizeCoverUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:" || !coverHosts.has(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function isAllowedCoverUrl(value) {
  return !value || Boolean(normalizeCoverUrl(value));
}

function coverOption(url, source, label) {
  const normalized = normalizeCoverUrl(url);
  return normalized ? { url: normalized, source, label } : null;
}

function uniqueCovers(covers) {
  const seen = new Set();
  return covers.filter(cover => {
    if (!cover?.url || seen.has(cover.url)) return false;
    seen.add(cover.url);
    return true;
  }).slice(0, 12);
}

function googleCoverOptions(imageLinks = {}) {
  const best = googleCoverSizes.map(size => imageLinks[size]).find(Boolean);
  const option = coverOption(best, "Google Books", "Google Books cover");
  return option ? [option] : [];
}

function identifiersFromGoogle(volumeInfo) {
  return (volumeInfo.industryIdentifiers || [])
    .map(identifier => normalizeIsbn(identifier?.identifier))
    .filter(Boolean)
    .slice(0, 30);
}

export function normalizeGoogleVolumes(payload) {
  return (payload?.items || []).flatMap(item => {
    const info = item?.volumeInfo || {};
    const title = cleanText(info.title, 300);
    if (!title) return [];
    const identifiers = identifiersFromGoogle(info);
    const isbn = identifiers.find(value => value.length === 13) || identifiers[0];
    return [{
      source: "google_books",
      sourceLabel: "Google Books",
      sourceId: cleanText(item.id, 100),
      isbn,
      identifiers,
      title,
      author: cleanText((info.authors || []).join(", ") || "Unknown author", 300),
      publisher: cleanText(info.publisher, 200) || undefined,
      publishedYear: year(info.publishedDate),
      pageCount: Number.isInteger(info.pageCount) && info.pageCount > 0 ? info.pageCount : undefined,
      genre: cleanText(first(info.categories), 150) || undefined,
      description: cleanText(info.description, 5000) || undefined,
      series: undefined,
      seriesNumber: undefined,
      coverOptions: googleCoverOptions(info.imageLinks),
    }];
  });
}

function openLibraryCovers(document) {
  const editions = Array.isArray(document?.editions?.docs) ? document.editions.docs : [];
  const coverIds = [document?.cover_i, ...editions.map(edition => edition?.cover_i)]
    .filter(value => Number.isInteger(value) && value > 0);
  return uniqueCovers(coverIds.map((coverId, index) =>
    coverOption(
      `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`,
      "Open Library",
      index ? `Open Library edition ${index + 1}` : "Open Library cover",
    )
  ));
}

export function normalizeOpenLibraryDocs(payload, preferredIsbn = "") {
  return (payload?.docs || []).flatMap(document => {
    const title = cleanText(document?.title, 300);
    if (!title) return [];
    const allIdentifiers = [...new Set((document.isbn || []).map(normalizeIsbn).filter(Boolean))];
    const preferred = normalizeIsbn(preferredIsbn);
    const identifiers = preferred && allIdentifiers.includes(preferred)
      ? [preferred, ...allIdentifiers.filter(value => value !== preferred)].slice(0, 30)
      : allIdentifiers.slice(0, 30);
    const isbn = identifiers.find(value => value.length === 13) || identifiers[0];
    return [{
      source: "open_library",
      sourceLabel: "Open Library",
      sourceId: cleanText(document.key, 100),
      isbn,
      identifiers,
      title,
      author: cleanText((document.author_name || []).join(", ") || "Unknown author", 300),
      publisher: cleanText(first(document.publisher), 200) || undefined,
      publishedYear: year(document.first_publish_year),
      pageCount: Number.isInteger(document.number_of_pages_median) && document.number_of_pages_median > 0
        ? document.number_of_pages_median
        : undefined,
      genre: cleanText(first(document.subject), 150) || undefined,
      description: cleanText(first(document.first_sentence), 5000) || undefined,
      series: cleanText(first(document.series), 150) || undefined,
      seriesNumber: undefined,
      coverOptions: openLibraryCovers(document),
    }];
  });
}

function identity(result) {
  const title = result.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const author = result.author.split(",")[0].toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${title}|${author}`;
}

function sameBook(left, right) {
  const leftIds = new Set(left.identifiers || []);
  return (right.identifiers || []).some(identifier => leftIds.has(identifier)) || identity(left) === identity(right);
}

function mergeResult(primary, secondary) {
  return {
    ...primary,
    isbn: primary.isbn || secondary.isbn,
    identifiers: [...new Set([...(primary.identifiers || []), ...(secondary.identifiers || [])])].slice(0, 30),
    publisher: primary.publisher || secondary.publisher,
    publishedYear: primary.publishedYear || secondary.publishedYear,
    pageCount: primary.pageCount || secondary.pageCount,
    genre: primary.genre || secondary.genre,
    description: primary.description || secondary.description,
    series: primary.series || secondary.series,
    seriesNumber: primary.seriesNumber || secondary.seriesNumber,
    coverOptions: uniqueCovers([...(primary.coverOptions || []), ...(secondary.coverOptions || [])]),
  };
}

export function mergeBookResults(googleResults, openLibraryResults) {
  const merged = [];
  for (const candidate of [...googleResults, ...openLibraryResults]) {
    const index = merged.findIndex(existing => sameBook(existing, candidate));
    if (index === -1) merged.push(candidate);
    else merged[index] = mergeResult(merged[index], candidate);
  }
  return merged.slice(0, 12).map(result => ({
    ...result,
    coverUrl: result.coverOptions[0]?.url,
  }));
}

async function fetchJson(url, provider, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "BookVault/1.0 (+https://github.com/hoovdizz/book-vault)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 3_000_000) throw new Error(`${provider} response was too large`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 3_000_000) throw new Error(`${provider} response was too large`);
  return JSON.parse(text);
}

export async function lookupBooks(query, searchType = "auto", options = {}) {
  const cleanQuery = cleanText(query, 200);
  const isbn = normalizeIsbn(cleanQuery);
  const type = searchType === "isbn" || (searchType === "auto" && isbn) ? "isbn" : "title";
  if (!cleanQuery || (type === "isbn" && !isbn)) {
    const error = new Error(type === "isbn" ? "Enter a valid ISBN-10 or ISBN-13" : "Enter a book title");
    error.status = 400;
    throw error;
  }

  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(10_000, Math.max(2_000, requestedTimeout))
    : 6_000;
  const googleUrl = new URL(googleBooksEndpoint);
  googleUrl.searchParams.set("q", type === "isbn" ? `isbn:${isbn}` : `intitle:${cleanQuery}`);
  googleUrl.searchParams.set("maxResults", "12");
  googleUrl.searchParams.set("printType", "books");
  googleUrl.searchParams.set("projection", "full");
  if (options.googleApiKey) googleUrl.searchParams.set("key", options.googleApiKey);

  const openLibraryUrl = new URL(openLibraryEndpoint);
  openLibraryUrl.searchParams.set(type, type === "isbn" ? isbn : cleanQuery);
  openLibraryUrl.searchParams.set("limit", "12");
  openLibraryUrl.searchParams.set(
    "fields",
    "key,title,author_name,isbn,first_publish_year,publisher,number_of_pages_median,cover_i,editions,series,subject,first_sentence",
  );

  const [google, openLibrary] = await Promise.allSettled([
    fetchJson(googleUrl, "Google Books", timeoutMs),
    fetchJson(openLibraryUrl, "Open Library", timeoutMs),
  ]);
  if (google.status === "rejected" && openLibrary.status === "rejected") {
    const error = new Error("Google Books and Open Library are temporarily unavailable");
    error.status = 502;
    throw error;
  }

  const googleResults = google.status === "fulfilled" ? normalizeGoogleVolumes(google.value) : [];
  const openLibraryResults = openLibrary.status === "fulfilled" ? normalizeOpenLibraryDocs(openLibrary.value, isbn) : [];
  return {
    results: mergeBookResults(googleResults, openLibraryResults),
    providers: {
      googleBooks: google.status === "fulfilled" ? "available" : "unavailable",
      openLibrary: openLibrary.status === "fulfilled" ? "available" : "unavailable",
    },
  };
}
