/** SPEC-001 — SEO helpers (AC 11). These three things decide whether publishing is worth anything. */

import { describe, expect, it } from "vitest";
import {
  articleJsonLd, articleMetadata, articleUrl, faqJsonLd, ftesSitemapEntries,
} from "../src/seo.js";
import type { Article } from "../src/index.js";

const A: Article = {
  id: "a1", slug: "best-crm", title: "Best CRM for Startups",
  meta_description: "A practical guide.", target_query: "best crm",
  tldr: ["x"], sections: [{ heading: "H", content: "C" }],
  faq: [{ question: "Q1", answer: "A1" }, { question: "Q2", answer: "A2" }],
};
const OPTS = { siteUrl: "https://example.com", blogBasePath: "/blog" };

describe("articleUrl", () => {
  it("builds the canonical path and tolerates trailing slashes", () => {
    expect(articleUrl(A, OPTS)).toBe("https://example.com/blog/best-crm");
    expect(articleUrl(A, { siteUrl: "https://example.com/", blogBasePath: "/blog/" }))
      .toBe("https://example.com/blog/best-crm");
  });

  it("defaults blogBasePath to /blog", () => {
    expect(articleUrl(A, { siteUrl: "https://example.com" })).toBe("https://example.com/blog/best-crm");
  });
});

describe("articleMetadata", () => {
  it("returns a PLAIN-STRING title so the layout template is not doubled up", () => {
    const m = articleMetadata(A, OPTS);
    expect(typeof m.title).toBe("string");
    expect(m.title).toBe("Best CRM for Startups");
    expect(m.title).not.toContain("|");
  });

  it("sets the canonical URL — the thing that stops duplicate-content problems", () => {
    expect(articleMetadata(A, OPTS).alternates.canonical).toBe("https://example.com/blog/best-crm");
  });

  it("fills OG and Twitter from the same source of truth", () => {
    const m = articleMetadata(A, OPTS);
    expect(m.openGraph.url).toBe("https://example.com/blog/best-crm");
    expect(m.openGraph.type).toBe("article");
    expect(m.twitter.title).toBe(A.title);
    expect(m.description).toBe("A practical guide.");
  });

  it("degrades to an empty description rather than undefined", () => {
    const { meta_description, ...noDesc } = A;
    expect(articleMetadata(noDesc as Article, OPTS).description).toBe("");
  });
});

describe("articleJsonLd", () => {
  it("produces valid Article JSON-LD pointing at the canonical URL", () => {
    const ld = articleJsonLd(A, OPTS);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Article");
    expect(ld["headline"]).toBe(A.title);
    expect(ld["url"]).toBe("https://example.com/blog/best-crm");
    expect(ld["mainEntityOfPage"]).toEqual({
      "@type": "WebPage", "@id": "https://example.com/blog/best-crm",
    });
  });

  it("omits fields it was not given rather than emitting nulls", () => {
    const ld = articleJsonLd(A, OPTS);
    expect("author" in ld).toBe(false);
    expect("publisher" in ld).toBe(false);
    expect("datePublished" in ld).toBe(false);
  });

  it("includes author, publisher and dates when supplied, normalising Date objects", () => {
    const ld = articleJsonLd(A, {
      ...OPTS,
      author: { name: "Sam", url: "https://example.com/about" },
      publisher: { name: "Example", logoUrl: "https://example.com/logo.png" },
      datePublished: new Date("2026-08-18T00:00:00Z"),
      dateModified: "2026-08-19",
    });
    expect((ld["author"] as any).name).toBe("Sam");
    expect((ld["publisher"] as any)["@type"]).toBe("Organization");
    expect(ld["datePublished"]).toBe("2026-08-18T00:00:00.000Z");
    expect(ld["dateModified"]).toBe("2026-08-19");
  });

  it("serializes to JSON safely for inline rendering", () => {
    expect(() => JSON.stringify(articleJsonLd(A, OPTS))).not.toThrow();
  });
});

describe("faqJsonLd", () => {
  it("emits FAQPage only when there IS a visible FAQ", () => {
    const ld = faqJsonLd(A)!;
    expect(ld["@type"]).toBe("FAQPage");
    expect((ld["mainEntity"] as any[]).length).toBe(2);
    // No FAQ block on the page ⇒ no FAQ schema. Claiming one would be schema spam.
    expect(faqJsonLd({ ...A, faq: [] })).toBeNull();
  });
});

describe("ftesSitemapEntries", () => {
  it("includes every post — this is how new articles get discovered", () => {
    const entries = ftesSitemapEntries(
      [{ slug: "a", updated_at: "2026-08-18" }, { slug: "b" }, { slug: "c", published_at: "2026-08-01" }],
      OPTS,
    );
    expect(entries.map((e) => e.url)).toEqual([
      "https://example.com/blog/a", "https://example.com/blog/b", "https://example.com/blog/c",
    ]);
  });

  it("prefers updated_at, falls back to published_at, omits the field when neither exists", () => {
    const [a, b, c] = ftesSitemapEntries(
      [
        { slug: "a", updated_at: "2026-08-18", published_at: "2026-01-01" },
        { slug: "b", published_at: "2026-08-01" },
        { slug: "c" },
      ],
      OPTS,
    );
    expect(a!.lastModified).toBe("2026-08-18");
    expect(b!.lastModified).toBe("2026-08-01");
    expect("lastModified" in c!).toBe(false);
  });

  it("returns an empty list for no posts instead of throwing", () => {
    expect(ftesSitemapEntries([], OPTS)).toEqual([]);
  });
});
