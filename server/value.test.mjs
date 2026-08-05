import { describe, expect, it } from "vitest";
import { estimateEditionValue } from "./value.mjs";

describe("collection value estimates", () => {
  it("uses provider ISBN pricing with a transparent range", () => {
    const estimate = estimateEditionValue(
      { binding: "paperback", publication_date: "2022-01-01", page_count: 320 },
      [{ priceOptions: [{ amount: 14.99, currency: "USD", label: "Google Books retail price" }] }],
    );
    expect(estimate).toMatchObject({
      valueCents: 1499,
      lowCents: 1124,
      highCents: 1874,
      currency: "USD",
      confidence: "provider",
    });
  });

  it("falls back to a low-confidence binding estimate", () => {
    const estimate = estimateEditionValue({
      binding: "hardcover",
      publication_date: "2020-01-01",
      page_count: 900,
    });
    expect(estimate.confidence).toBe("low");
    expect(estimate.source).toContain("heuristic");
    expect(estimate.lowCents).toBeLessThan(estimate.valueCents);
    expect(estimate.highCents).toBeGreaterThan(estimate.valueCents);
  });
});
