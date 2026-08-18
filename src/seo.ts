/**
 * SEO helpers (SPEC-001).
 *
 * These exist because the three things that decide whether a published article is worth
 * anything — a canonical URL, server-rendered JSON-LD, and a sitemap entry — are exactly the
 * three a hand-rolled integration forgets. One call each.
 */

import type { Article } from "./article.js";

export interface SiteOptions {
  /** Origin, no trailing slash. */
  siteUrl: string;
  /** Default "/blog". */
  blogBasePath?: string;
}

function base(opts: SiteOptions): { site: string; path: string } {
  return {
    site: opts.siteUrl.replace(/\/$/, ""),
    path: (opts.blogBasePath ?? "/blog").replace(/\/$/, ""),
  };
}

export function articleUrl(article: Pick<Article, "slug">, opts: SiteOptions): string {
  const { site, path } = base(opts);
  return `${site}${path}/${article.slug}`;
}

/**
 * A Next.js `Metadata` object for the article page.
 *
 * The title is a PLAIN STRING: Next.js applies your layout's title template to it, so
 * returning a pre-decorated title would double up the site name.
 */
export function articleMetadata(article: Article, opts: SiteOptions) {
  const url = articleUrl(article, opts);
  const description = article.meta_description ?? "";
  return {
    title: article.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description,
      url,
      type: "article" as const,
    },
    twitter: {
      card: "summary_large_image" as const,
      title: article.title,
      description,
    },
  };
}

export interface JsonLdOptions extends SiteOptions {
  author?: { name: string; url?: string };
  publisher?: { name: string; logoUrl?: string };
  datePublished?: string | Date;
  dateModified?: string | Date;
}

const iso = (d: string | Date | undefined): string | undefined =>
  d === undefined ? undefined : d instanceof Date ? d.toISOString() : d;

/**
 * `Article` JSON-LD. Render it INLINE in a server component:
 *
 * ```tsx
 * <script type="application/ld+json"
 *   dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd(article, opts)) }} />
 * ```
 *
 * Injecting it from a client effect makes it invisible to AI crawlers, which do not run JS —
 * which would defeat the point of publishing at all.
 */
export function articleJsonLd(article: Article, opts: JsonLdOptions): Record<string, unknown> {
  const url = articleUrl(article, opts);
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
  };
  if (article.meta_description) ld["description"] = article.meta_description;
  const published = iso(opts.datePublished);
  if (published) ld["datePublished"] = published;
  const modified = iso(opts.dateModified);
  if (modified) ld["dateModified"] = modified;
  if (opts.author) {
    ld["author"] = {
      "@type": "Person",
      name: opts.author.name,
      ...(opts.author.url ? { url: opts.author.url } : {}),
    };
  }
  if (opts.publisher) {
    ld["publisher"] = {
      "@type": "Organization",
      name: opts.publisher.name,
      ...(opts.publisher.logoUrl
        ? { logo: { "@type": "ImageObject", url: opts.publisher.logoUrl } }
        : {}),
    };
  }
  return ld;
}

/** FAQ JSON-LD — only when the page actually renders a visible FAQ block. */
export function faqJsonLd(article: Article): Record<string, unknown> | null {
  if (!article.faq.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: article.faq.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

export interface SitemapEntry {
  url: string;
  lastModified?: string | Date;
}

/** Rows for `app/sitemap.ts`. Pass every post — the sitemap is how new articles get found. */
export function ftesSitemapEntries(
  posts: Array<Pick<Article, "slug"> & { updated_at?: string | Date; published_at?: string | Date }>,
  opts: SiteOptions,
): SitemapEntry[] {
  return posts.map((p) => {
    const entry: SitemapEntry = { url: articleUrl(p, opts) };
    const when = p.updated_at ?? p.published_at;
    if (when) entry.lastModified = when;
    return entry;
  });
}
