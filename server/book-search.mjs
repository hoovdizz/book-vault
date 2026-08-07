const googleBooksEndpoint = "https://www.googleapis.com/books/v1/volumes";
const openLibraryEndpoint = "https://openlibrary.org/search.json";
const hardcoverEndpoint = "https://api.hardcover.app/v1/graphql";
const coverHosts = new Set([
  "books.google.com",
  "books.googleusercontent.com",
  "covers.openlibrary.org",
  "assets.hardcover.app",
]);
const googleCoverSizes = ["extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"];

function cleanText(value, max = 5000) {
  return String(value || "").trim().slice(0, max);
}

export function seriesDisplayName(value) {
  const clean = cleanText(value, 150).replace(/\s+/g, " ");
  if (!clean) return "";
  // Provider names retain their intentional casing. Normalize only all-lower/all-upper
  // fallback values (usually the user's search text) into readable title case.
  if (clean !== clean.toLocaleLowerCase() && clean !== clean.toLocaleUpperCase()) return clean;
  const minor = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"]);
  return clean.toLocaleLowerCase().split(" ").map((word, index) => {
    if (index > 0 && minor.has(word)) return word;
    return word.replace(/[\p{L}]/u, letter => letter.toLocaleUpperCase());
  }).join(" ");
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
  if (/^97[89]\d{10}$/.test(normalized)) {
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

function hardcoverAuthorization(token) {
  const value = cleanText(token, 4000);
  return value && (/^Bearer\s/i.test(value) ? value : `Bearer ${value}`);
}

function hardcoverContributors(value) {
  return (Array.isArray(value) ? value : [])
    .map(contribution => cleanText(contribution?.author?.name || contribution?.name, 300))
    .filter(Boolean);
}

function hardcoverCoverOptions(book) {
  const values = [
    typeof book?.cached_image === "string" ? book.cached_image : book?.cached_image?.url,
    ...(Array.isArray(book?.images) ? book.images.map(image => image?.url) : []),
  ];
  return uniqueCovers(values.map((url, index) =>
    coverOption(url, "Hardcover", index ? `Hardcover cover ${index + 1}` : "Hardcover cover")
  ));
}

export function normalizeHardcoverBooks(payload) {
  const editionsByBook = new Map();
  for (const edition of payload?.data?.editions || []) {
    if (!editionsByBook.has(edition?.book_id)) editionsByBook.set(edition?.book_id, edition);
  }
  return (payload?.data?.books || []).flatMap(book => {
    const title = cleanText(book?.title, 300);
    if (!title) return [];
    const edition = editionsByBook.get(book.id) || {};
    const identifiers = [edition.isbn_13, edition.isbn_10].map(normalizeIsbn).filter(Boolean);
    const contributors = hardcoverContributors(book.cached_contributors);
    const coverOptions = hardcoverCoverOptions(book);
    return [{
      source: "manual",
      sourceLabel: "Hardcover",
      sourceId: cleanText(book.id, 100),
      isbn: identifiers.find(value => value.length === 13) || identifiers[0],
      identifiers,
      title,
      author: contributors.join(", ") || "Unknown author",
      publishedYear: year(book.release_year || book.release_date),
      pageCount: Number.isInteger(book.pages) && book.pages > 0 ? book.pages : undefined,
      genre: cleanText(first(book?.cached_tags?.Genre)?.tag || first(book?.cached_tags?.Genre), 150) || undefined,
      description: cleanText(book.description, 5000) || undefined,
      series: cleanText(book.series, 150) || undefined,
      seriesNumber: book.seriesNumber == null ? undefined : cleanText(book.seriesNumber, 30),
      coverUrl: coverOptions[0]?.url,
      coverOptions,
    }];
  });
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

function googlePriceOptions(saleInfo = {}) {
  return [
    [saleInfo.retailPrice, "Google Books retail price"],
    [saleInfo.listPrice, "Google Books list price"],
  ].flatMap(([price, label]) => {
    const amount = Number(price?.amount);
    const currency = cleanText(price?.currencyCode, 3).toUpperCase();
    return Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency)
      ? [{ amount, currency, label }]
      : [];
  });
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
      priceOptions: googlePriceOptions(item?.saleInfo),
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
    priceOptions: [...(primary.priceOptions || []), ...(secondary.priceOptions || [])]
      .filter((price, index, all) => all.findIndex(candidate => candidate.amount === price.amount && candidate.currency === price.currency) === index)
      .slice(0, 6),
  };
}

export function mergeBookResults(googleResults, openLibraryResults, hardcoverResults = []) {
  const merged = [];
  for (const candidate of [...googleResults, ...openLibraryResults]) {
    const index = merged.findIndex(existing => sameBook(existing, candidate));
    if (index === -1) merged.push(candidate);
    else merged[index] = mergeResult(merged[index], candidate);
  }
  for (const candidate of hardcoverResults) {
    const index = merged.findIndex(existing => sameBook(existing, candidate));
    if (index !== -1) merged[index] = mergeResult(merged[index], candidate);
  }
  return merged.slice(0, 12).map(result => ({
    ...result,
    coverUrl: result.coverOptions[0]?.url,
  }));
}

function mergeConfiguredResults(resultSets, providerOrder, hardcoverResults) {
  const merged = [];
  for (const provider of providerOrder) {
    for (const candidate of resultSets[provider] || []) {
      const index = merged.findIndex(existing => sameBook(existing, candidate));
      if (index === -1) merged.push(candidate);
      else merged[index] = mergeResult(merged[index], candidate);
    }
  }
  for (const candidate of hardcoverResults) {
    const index = merged.findIndex(existing => sameBook(existing, candidate));
    if (index !== -1) merged[index] = mergeResult(merged[index], candidate);
  }
  return merged.slice(0, 12).map(result => ({ ...result, coverUrl: result.coverOptions[0]?.url }));
}

async function fetchJson(url, provider, timeoutMs, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "BookVault/1.0 (+https://github.com/hoovdizz/book-vault)",
      ...options.headers,
    },
    method: options.method || "GET",
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 3_000_000) throw new Error(`${provider} response was too large`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 3_000_000) throw new Error(`${provider} response was too large`);
  return JSON.parse(text);
}

async function hardcoverGraphql(query, variables, token, timeoutMs) {
  const authorization = hardcoverAuthorization(token);
  if (!authorization) throw new Error("Hardcover API token is not configured");
  const payload = await fetchJson(hardcoverEndpoint, "Hardcover", timeoutMs, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (payload?.errors?.length) throw new Error(`Hardcover: ${cleanText(payload.errors[0]?.message, 300)}`);
  return payload;
}

async function lookupHardcoverBooks(query, token, timeoutMs) {
  const searchPayload = await hardcoverGraphql(`
    query BookVaultSearch($query: String!) {
      search(query: $query, query_type: "Book", per_page: 12, page: 1) { ids }
    }
  `, { query }, token, timeoutMs);
  const ids = (searchPayload?.data?.search?.ids || [])
    .map(Number)
    .filter(Number.isSafeInteger)
    .slice(0, 12);
  if (!ids.length) return [];
  const booksPayload = await hardcoverGraphql(`
    query BookVaultCovers($ids: [Int!]!) {
      books(where: {id: {_in: $ids}}, limit: 12) {
        id
        title
        description
        release_year
        pages
        cached_contributors
        cached_tags
        cached_image(path: "url")
        images(limit: 6) { url }
      }
      editions(
        where: {book_id: {_in: $ids}}
        distinct_on: book_id
        order_by: [{book_id: asc}, {score: desc_nulls_last}]
      ) {
        book_id
        isbn_10
        isbn_13
      }
    }
  `, { ids }, token, timeoutMs);
  return normalizeHardcoverBooks(booksPayload);
}

function inferredSeriesPosition(seriesValues, seriesName, title = "") {
  const matching = (Array.isArray(seriesValues) ? seriesValues : [])
    .find(value => cleanText(value, 200).toLocaleLowerCase().includes(seriesName.toLocaleLowerCase()));
  const value = cleanText(matching, 200);
  const marked = value.match(/(?:#|\bbook\s*|\bvol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)\b/i)
    || cleanText(title, 300).match(/(?:#|\bbook\s*|\bvol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)\b/i);
  const trailing = value.match(/(?:[,;:\s]|^)(\d+(?:\.\d+)?)\s*$/);
  return marked?.[1] || trailing?.[1];
}

function seriesBaseName(value) {
  return cleanText(value, 150)
    .replace(/\s*[,;:-]?\s*(?:#|books?\s*|vol(?:ume)?\.?\s*)?\d+(?:\.\d+)?\s*$/i, "")
    .trim();
}

function withInferredSeriesPositions(books) {
  const decorated = books.map((book, index) => ({ book, index }));
  decorated.sort((left, right) => {
    const leftPosition = Number(left.book.seriesNumber);
    const rightPosition = Number(right.book.seriesNumber);
    if (Number.isFinite(leftPosition) && Number.isFinite(rightPosition)) return leftPosition - rightPosition;
    const leftYear = Number(left.book.publishedYear) || Number.MAX_SAFE_INTEGER;
    const rightYear = Number(right.book.publishedYear) || Number.MAX_SAFE_INTEGER;
    return leftYear - rightYear || left.index - right.index;
  });
  const used = new Set(decorated
    .map(item => Number(item.book.seriesNumber))
    .filter(value => Number.isInteger(value) && value > 0));
  let nextPosition = 1;
  return decorated.map(({ book }) => {
    if (book.seriesNumber) return book;
    while (used.has(nextPosition)) nextPosition += 1;
    const seriesNumber = String(nextPosition);
    used.add(nextPosition);
    nextPosition += 1;
    return { ...book, seriesNumber };
  });
}

export function normalizeOpenLibrarySeries(payload, requestedSeries) {
  const candidateNames = (payload?.docs || [])
    .flatMap(document => Array.isArray(document.series) ? document.series : [])
    .map(seriesBaseName)
    .filter(Boolean);
  const queryCore = cleanText(requestedSeries, 150)
    .replace(/\b(?:series|books?|saga|novels?)\b/gi, " ")
    .replace(/[^\p{L}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
  const counts = new Map();
  for (const candidate of candidateNames) {
    const normalized = candidate.toLocaleLowerCase();
    if (!queryCore || normalized.includes(queryCore) || queryCore.includes(normalized)) {
      counts.set(candidate, (counts.get(candidate) || 0) + 1);
    }
  }
  const bestCandidate = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)[0]?.[0]
    || candidateNames[0];
  const seriesName = seriesDisplayName(bestCandidate || requestedSeries);
  return (payload?.docs || []).flatMap(document =>
    normalizeOpenLibraryDocs({ docs: [document] }).map(result => ({
      ...result,
      series: seriesName,
      seriesNumber: inferredSeriesPosition(document.series, seriesName, document.title),
      coverUrl: result.coverOptions[0]?.url,
    }))
  );
}

async function lookupOpenLibrarySeries(query, timeoutMs) {
  const url = new URL(openLibraryEndpoint);
  const escaped = query.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  url.searchParams.set("q", `series:"${escaped}"`);
  url.searchParams.set("limit", "50");
  url.searchParams.set(
    "fields",
    "key,title,author_name,isbn,first_publish_year,publisher,number_of_pages_median,cover_i,editions,series,subject,first_sentence",
  );
  const payload = await fetchJson(url, "Open Library", timeoutMs);
  const books = withInferredSeriesPositions(normalizeOpenLibrarySeries(payload, query));
  return {
    seriesName: seriesDisplayName(books[0]?.series || query),
    books,
    provider: "Open Library",
  };
}

async function lookupHardcoverSeries(query, token, timeoutMs) {
  const searchPayload = await hardcoverGraphql(`
    query BookVaultSeriesSearch($query: String!) {
      search(query: $query, query_type: "Series", per_page: 5, page: 1) { ids results }
    }
  `, { query }, token, timeoutMs);
  const ids = (searchPayload?.data?.search?.ids || []).map(Number).filter(Number.isSafeInteger);
  const searchResults = Array.isArray(searchPayload?.data?.search?.results)
    ? searchPayload.data.search.results
    : [];
  const exactIndex = searchResults.findIndex(result =>
    cleanText(result?.name, 150).toLocaleLowerCase() === query.toLocaleLowerCase());
  const id = ids[exactIndex >= 0 ? exactIndex : 0];
  if (!id) return { seriesName: seriesDisplayName(query), books: [], provider: "Hardcover" };
  const seriesPayload = await hardcoverGraphql(`
    query BookVaultSeries($id: Int!) {
      series_by_pk(id: $id) {
        id
        name
        book_series(
          limit: 100
          distinct_on: position
          order_by: [{position: asc}, {book: {users_count: desc}}]
          where: {
            book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}
            compilation: {_eq: false}
          }
        ) {
          position
          book {
            id
            title
            description
            release_year
            pages
            cached_contributors
            cached_tags
            cached_image(path: "url")
          }
        }
      }
    }
  `, { id }, token, timeoutMs);
  const series = seriesPayload?.data?.series_by_pk;
  const rows = Array.isArray(series?.book_series) ? series.book_series : [];
  const bookIds = rows.map(row => Number(row?.book?.id)).filter(Number.isSafeInteger);
  let editions = [];
  if (bookIds.length) {
    const editionPayload = await hardcoverGraphql(`
      query BookVaultSeriesEditions($ids: [Int!]!) {
        editions(
          where: {book_id: {_in: $ids}}
          distinct_on: book_id
          order_by: [{book_id: asc}, {score: desc_nulls_last}]
        ) {
          book_id
          isbn_10
          isbn_13
        }
      }
    `, { ids: bookIds }, token, timeoutMs);
    editions = editionPayload?.data?.editions || [];
  }
  const booksPayload = {
    data: {
      books: rows.map(row => ({
        ...row.book,
        series: cleanText(series?.name, 150) || query,
        seriesNumber: row.position,
      })),
      editions,
    },
  };
  return {
    seriesName: seriesDisplayName(cleanText(series?.name, 150) || query),
    books: normalizeHardcoverBooks(booksPayload),
    provider: "Hardcover",
  };
}

export async function lookupSeries(query, options = {}) {
  const cleanQuery = cleanText(query, 150);
  if (!cleanQuery) throw Object.assign(new Error("Enter a series name"), { status: 400 });
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(10_000, Math.max(2_000, requestedTimeout))
    : 6_000;
  const provider = ["auto", "hardcover", "open_library"].includes(options.provider)
    ? options.provider
    : "auto";
  if (provider === "hardcover" && !options.hardcoverToken) {
    throw Object.assign(new Error("Hardcover series search requires HARDCOVER_API_TOKEN in the container settings"), { status: 400 });
  }
  if (provider !== "open_library" && options.hardcoverToken) {
    try {
      const hardcover = await lookupHardcoverSeries(cleanQuery, options.hardcoverToken, timeoutMs);
      if (hardcover.books.length || provider === "hardcover") return hardcover;
    } catch (error) {
      if (provider === "hardcover") {
        if (!error.status) error.status = 502;
        throw error;
      }
      // Open Library remains available when the optional Hardcover integration fails.
    }
  }
  return lookupOpenLibrarySeries(cleanQuery, timeoutMs);
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

  const enabledProviders = new Set(
    Array.isArray(options.enabledProviders)
      ? options.enabledProviders.filter(provider => ["google_books", "open_library"].includes(provider))
      : ["google_books", "open_library"],
  );
  const providerOrder = [
    ...new Set(
      (Array.isArray(options.providerOrder) ? options.providerOrder : ["google_books", "open_library"])
        .filter(provider => enabledProviders.has(provider)),
    ),
  ];
  for (const provider of enabledProviders) {
    if (!providerOrder.includes(provider)) providerOrder.push(provider);
  }
  const hardcoverPromise = options.hardcoverToken
    ? lookupHardcoverBooks(type === "isbn" ? isbn : cleanQuery, options.hardcoverToken, timeoutMs)
    : Promise.resolve([]);
  const [google, openLibrary, hardcover] = await Promise.allSettled([
    enabledProviders.has("google_books")
      ? fetchJson(googleUrl, "Google Books", timeoutMs)
      : Promise.resolve({ items: [] }),
    enabledProviders.has("open_library")
      ? fetchJson(openLibraryUrl, "Open Library", timeoutMs)
      : Promise.resolve({ docs: [] }),
    hardcoverPromise,
  ]);
  const enabledFailures = [
    enabledProviders.has("google_books") && google.status === "rejected",
    enabledProviders.has("open_library") && openLibrary.status === "rejected",
  ];
  if (!enabledProviders.size || enabledFailures.filter(Boolean).length === enabledProviders.size) {
    const error = new Error(enabledProviders.size
      ? "Configured metadata providers are temporarily unavailable"
      : "No metadata provider is enabled; use manual entry");
    error.status = 502;
    throw error;
  }

  const googleResults = google.status === "fulfilled" ? normalizeGoogleVolumes(google.value) : [];
  const openLibraryResults = openLibrary.status === "fulfilled" ? normalizeOpenLibraryDocs(openLibrary.value, isbn) : [];
  const hardcoverResults = hardcover.status === "fulfilled" ? hardcover.value : [];
  return {
    results: mergeConfiguredResults(
      { google_books: googleResults, open_library: openLibraryResults },
      providerOrder,
      hardcoverResults,
    ),
    providers: {
      googleBooks: !enabledProviders.has("google_books") ? "disabled" : google.status === "fulfilled" ? "available" : "unavailable",
      openLibrary: !enabledProviders.has("open_library") ? "disabled" : openLibrary.status === "fulfilled" ? "available" : "unavailable",
      hardcover: options.hardcoverToken
        ? (hardcover.status === "fulfilled" ? "available" : "unavailable")
        : "disabled",
    },
  };
}
