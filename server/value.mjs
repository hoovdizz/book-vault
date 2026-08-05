import { configuredLookup } from "./metadata.mjs";

const heuristicValues = {
  hardcover: 26.99,
  library_binding: 24.99,
  paperback: 16.99,
  mass_market_paperback: 10.99,
  spiral_bound: 18.99,
  ebook: 9.99,
  audiobook: 24.99,
  other: 18.99,
};

function cents(value) {
  return Math.max(0, Math.round(Number(value) * 100));
}

function heuristicAmount(edition) {
  const format = String(edition.media_format || "").toLocaleLowerCase();
  const binding = String(edition.binding || "other").toLocaleLowerCase();
  let amount = heuristicValues[format] || heuristicValues[binding] || heuristicValues.other;
  const year = Number.parseInt(String(edition.publication_date || "").slice(0, 4), 10);
  const age = Number.isInteger(year) ? new Date().getFullYear() - year : 0;
  if (age > 30) amount *= 0.6;
  else if (age > 15) amount *= 0.75;
  else if (age > 5) amount *= 0.9;
  const pages = Number(edition.page_count);
  if (pages > 800) amount *= 1.25;
  else if (pages > 500) amount *= 1.15;
  return amount;
}

function providerPrice(results) {
  for (const result of results || []) {
    for (const price of result.priceOptions || []) {
      const amount = Number(price.amount);
      const currency = String(price.currency || "").toUpperCase();
      if (Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency)) {
        return { amount, currency, source: price.label || result.sourceLabel || "Book provider" };
      }
    }
  }
  return null;
}

export function estimateEditionValue(edition, results = []) {
  const provider = providerPrice(results);
  const amount = provider?.amount ?? heuristicAmount(edition);
  const isProvider = Boolean(provider);
  return {
    valueCents: cents(amount),
    lowCents: cents(isProvider ? amount * 0.75 : amount * 0.7),
    highCents: cents(isProvider ? amount * 1.25 : amount * 1.35),
    currency: provider?.currency || "USD",
    source: provider?.source || "Binding and edition heuristic",
    confidence: isProvider ? "provider" : "low",
    updatedAt: new Date().toISOString(),
  };
}

function publicEstimate(row) {
  return {
    editionId: String(row.edition_id),
    isbn: row.isbn13 || row.isbn10 || null,
    value: row.estimated_value_cents == null ? null : row.estimated_value_cents / 100,
    low: row.estimated_value_low_cents == null ? null : row.estimated_value_low_cents / 100,
    high: row.estimated_value_high_cents == null ? null : row.estimated_value_high_cents / 100,
    currency: row.estimated_value_currency || "USD",
    source: row.estimated_value_source || null,
    confidence: row.estimated_value_confidence || null,
    updatedAt: row.estimated_value_updated_at || null,
  };
}

export function collectionValue(db, householdId) {
  const rows = db.prepare(`
    SELECT edition.id AS edition_id, edition.isbn10, edition.isbn13,
      edition.estimated_value_cents, edition.estimated_value_low_cents,
      edition.estimated_value_high_cents, edition.estimated_value_currency,
      edition.estimated_value_source, edition.estimated_value_confidence,
      edition.estimated_value_updated_at,
      COUNT(copy.id) AS copy_count,
      COALESCE(SUM(copy.purchase_price_cents), 0) AS purchase_cost_cents
    FROM editions edition
    JOIN copies copy ON copy.edition_id = edition.id
      AND copy.household_id = ? AND copy.archived_at IS NULL AND copy.copy_status = 'active'
    WHERE edition.household_id = ? AND edition.archived_at IS NULL
    GROUP BY edition.id
  `).all(householdId, householdId);
  const totals = {
    totalCopies: 0,
    estimatedCopies: 0,
    missingEstimates: 0,
    estimatedValueCents: 0,
    estimatedLowCents: 0,
    estimatedHighCents: 0,
    purchaseCostCents: 0,
    unsupportedCurrencyCopies: 0,
  };
  const currencies = {};
  for (const row of rows) {
    const copies = Number(row.copy_count) || 0;
    totals.totalCopies += copies;
    totals.purchaseCostCents += Number(row.purchase_cost_cents) || 0;
    if (row.estimated_value_cents == null) {
      totals.missingEstimates += copies;
      continue;
    }
    totals.estimatedCopies += copies;
    const currency = row.estimated_value_currency || "USD";
    currencies[currency] = (currencies[currency] || 0) + copies;
    if (currency !== "USD") {
      totals.unsupportedCurrencyCopies += copies;
      continue;
    }
    totals.estimatedValueCents += Number(row.estimated_value_cents) * copies;
    totals.estimatedLowCents += Number(row.estimated_value_low_cents || row.estimated_value_cents) * copies;
    totals.estimatedHighCents += Number(row.estimated_value_high_cents || row.estimated_value_cents) * copies;
  }
  return {
    ...totals,
    estimatedValue: totals.estimatedValueCents / 100,
    estimatedLow: totals.estimatedLowCents / 100,
    estimatedHigh: totals.estimatedHighCents / 100,
    purchaseCost: totals.purchaseCostCents / 100,
    currencies,
    estimates: rows.map(publicEstimate),
  };
}

export async function refreshEditionValue(db, context, editionId, options = {}) {
  const id = Number(editionId);
  const edition = db.prepare(`
    SELECT * FROM editions
    WHERE id = ? AND household_id = ? AND archived_at IS NULL
  `).get(id, context.household_id);
  if (!edition) throw Object.assign(new Error("Edition not found"), { status: 404 });
  let results = [];
  let providerError = null;
  if (edition.isbn13 || edition.isbn10) {
    try {
      const lookup = await configuredLookup(db, context, edition.isbn13 || edition.isbn10, "isbn", options);
      results = lookup.results || [];
    } catch (error) {
      providerError = String(error?.message || error).slice(0, 300);
    }
  }
  const estimate = estimateEditionValue(edition, results);
  db.prepare(`
    UPDATE editions SET estimated_value_cents = ?, estimated_value_low_cents = ?,
      estimated_value_high_cents = ?, estimated_value_currency = ?,
      estimated_value_source = ?, estimated_value_confidence = ?,
      estimated_value_updated_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND household_id = ?
  `).run(
    estimate.valueCents,
    estimate.lowCents,
    estimate.highCents,
    estimate.currency,
    estimate.source,
    estimate.confidence,
    estimate.updatedAt,
    id,
    context.household_id,
  );
  return { ...estimate, editionId: String(id), isbn: edition.isbn13 || edition.isbn10 || null, providerError };
}

export async function refreshMissingValues(db, context, options = {}) {
  const limit = Math.min(25, Math.max(1, Number(options.limit) || 10));
  const rows = db.prepare(`
    SELECT edition.id
    FROM editions edition
    WHERE edition.household_id = ? AND edition.archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM copies copy
        WHERE copy.edition_id = edition.id AND copy.household_id = ?
          AND copy.archived_at IS NULL AND copy.copy_status = 'active'
      )
      AND (edition.estimated_value_updated_at IS NULL
        OR edition.estimated_value_updated_at < datetime('now', '-30 days'))
    ORDER BY edition.estimated_value_updated_at IS NOT NULL, edition.id
    LIMIT ?
  `).all(context.household_id, context.household_id, limit);
  const refreshed = [];
  for (const row of rows) {
    refreshed.push(await refreshEditionValue(db, context, row.id, options));
  }
  return { refreshed, value: collectionValue(db, context.household_id) };
}
