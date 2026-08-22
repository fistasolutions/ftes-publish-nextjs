/**
 * The publish route (SPEC-001).
 *
 * Everything here exists because getting it wrong is invisible: a non-constant-time token
 * compare, an append instead of an upsert, a revalidation that forgets the sitemap. The site
 * owner supplies where to store the article; this owns the rest.
 *
 * Server-only: no "use client", no state, no effects.
 */

import { parseArticle, type Article } from "./article.js";

export interface UpsertResult {
  /** true when the row was created, false when an existing row was updated. */
  isInsert: boolean;
}

export interface ArticleStore {
  upsert(article: Article): Promise<UpsertResult>;
  get?(slug: string): Promise<Article | null>;
  list?(): Promise<Article[]>;
  /**
   * Remove one article (SPEC-002). Optional, so no existing custom store breaks.
   * `verifyInstall()` uses it to clean up its probe; without it the probe must be removed by
   * hand, which the report says loudly rather than leaving an orphan on a live site.
   */
  delete?(slug: string): Promise<void>;
}

export interface PublishRouteConfig {
  /** The shared secret, the same value registered in FTES. Never logged. */
  secret: string | undefined;
  /** Your site's origin, no trailing slash — e.g. "https://example.com". */
  siteUrl: string;
  /** A store adapter… */
  store?: ArticleStore;
  /** …or just an upsert function, if you'd rather write three lines. */
  upsert?: (article: Article) => Promise<UpsertResult | boolean | void>;
  /** Where articles live. Default "/blog". */
  blogBasePath?: string;
  /** Revalidate the post, the index and the sitemap on success. Default true. */
  revalidate?: boolean;
  /** Called after a successful publish — analytics, logging, cache warming. */
  onPublished?: (article: Article, url: string) => void | Promise<void>;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Constant-time string comparison.
 *
 * A plain `!==` returns as soon as two bytes differ, which leaks how much of the secret a
 * caller guessed correctly. Compare every byte, always.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Fold the length difference into the result instead of returning early.
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(header: string | null): string {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/** Build the Next.js route handler. Returns `{ POST }` to re-export from a route file. */
export function createPublishRoute(config: PublishRouteConfig) {
  const blogBasePath = (config.blogBasePath ?? "/blog").replace(/\/$/, "");
  const siteUrl = config.siteUrl.replace(/\/$/, "");
  const shouldRevalidate = config.revalidate !== false;

  async function POST(request: Request): Promise<Response> {
    // A missing secret is OUR misconfiguration, not the caller's — reporting it as 401 would
    // send the operator hunting for a wrong token that doesn't exist.
    if (!config.secret) {
      console.error(
        "[@ftes/publish-nextjs] secret is not configured — set FTES_PUBLISH_SECRET",
      );
      return json({ error: "publish_secret_not_configured" }, 500);
    }
    if (!config.store?.upsert && !config.upsert) {
      console.error("[@ftes/publish-nextjs] no `store` or `upsert` provided");
      return json({ error: "store_not_configured" }, 500);
    }

    const token = bearer(request.headers.get("authorization"));
    if (!token || !timingSafeEqual(token, config.secret)) {
      return json({ error: "unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "malformed_json" }, 400);
    }

    const parsed = parseArticle(body);
    if (!parsed.ok) {
      return json({ error: "missing_fields", fields: parsed.missing }, 400);
    }
    const { article } = parsed;

    // The header is the documented idempotency guarantee; a mismatch means the two sides
    // disagree about which article this is, which is worth refusing rather than guessing.
    const key = request.headers.get("idempotency-key");
    if (key && key !== article.id) {
      return json({ error: "idempotency_mismatch" }, 400);
    }

    let isInsert = false;
    try {
      if (config.store?.upsert) {
        isInsert = (await config.store.upsert(article)).isInsert;
      } else {
        const r = await config.upsert!(article);
        isInsert = typeof r === "boolean" ? r : ((r as UpsertResult | undefined)?.isInsert ?? false);
      }
    } catch (err) {
      // Log the real error; return a generic one. A driver message can carry schema and
      // connection details, and FTES shows this body verbatim to the user.
      console.error("[@ftes/publish-nextjs] store failed:", err);
      return json({ error: "store_failed" }, 500);
    }

    const url = `${siteUrl}${blogBasePath}/${article.slug}`;
    // SPEC-002: reported in the response body, not only to a log nobody is reading. A failed
    // revalidation is the most common reason an article is stored but never rendered.
    const warnings: string[] = [];

    if (shouldRevalidate) {
      try {
        const { revalidatePath } = await import("next/cache");
        revalidatePath(blogBasePath);
        revalidatePath(`${blogBasePath}/${article.slug}`);
        // The one everybody forgets. Without it the article is live but undiscoverable.
        revalidatePath("/sitemap.xml");
      } catch (err) {
        // The article IS saved. A revalidation failure must not turn a successful publish
        // into a failure — FTES would mark it failed and the owner would chase a ghost.
        const detail = err instanceof Error ? err.message : String(err);
        console.warn("[@ftes/publish-nextjs] revalidation failed (article saved):", err);
        warnings.push(
          `revalidation failed (${detail}) — the article is saved but the page may not regenerate. ` +
            "Run verifyInstall() to check the read path.",
        );
      }
    }

    if (config.onPublished) {
      try {
        await config.onPublished(article, url);
      } catch (err) {
        console.warn("[@ftes/publish-nextjs] onPublished hook threw:", err);
      }
    }

    // `warnings` is OMITTED when empty, never sent as []. An empty array reads as "we checked
    // and found none", which is a different and stronger claim than "nothing to report".
    // Additive either way: FTES reads only `url` from this body and ignores the rest.
    return json(warnings.length ? { url, warnings } : { url }, isInsert ? 201 : 200);
  }

  return { POST };
}
