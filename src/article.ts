/**
 * The article contract (SPEC-001; FTES backend SPEC-056).
 *
 * These types and the parser are the single place the two sides agree on a shape. If FTES
 * changes what it sends, this file changes and every consumer sees a type error instead of a
 * silently dropped field.
 */

export interface ArticleSection {
  heading: string;
  content: string;
}

export interface ArticleFaq {
  question: string;
  answer: string;
}

export interface Article {
  /** Stable per article. The UPSERT key — FTES resends it on retries and re-publishes. */
  id: string;
  title: string;
  slug: string;
  meta_description?: string;
  target_query?: string;
  tldr: string[];
  sections: ArticleSection[];
  faq: ArticleFaq[];
  /**
   * The whole post, pre-rendered and escaped by FTES. OPTIONAL by design: a site that renders
   * from `sections` should not be forced to store a second copy of its own content.
   */
  html?: string;
}

export type ParseResult =
  | { ok: true; article: Article }
  | { ok: false; missing: string[] };

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v) => v !== null && v !== undefined && str(v)).map((v) => str(v))
    : [];
}

function sections(value: unknown): ArticleSection[] {
  if (!Array.isArray(value)) return [];
  const out: ArticleSection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const heading = str(r["heading"]);
    const content = str(r["content"]);
    // A heading with no body is KEPT — an empty section is a fact about the article the
    // owner should be able to see, not something to quietly discard.
    if (!heading && !content) continue;
    out.push({ heading, content });
  }
  return out;
}

function faq(value: unknown): ArticleFaq[] {
  if (!Array.isArray(value)) return [];
  const out: ArticleFaq[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const question = str(r["question"]);
    const answer = str(r["answer"]);
    if (!question && !answer) continue;
    out.push({ question, answer });
  }
  return out;
}

/**
 * Validate an incoming body. `id`, `slug` and `title` are required; everything else degrades
 * to a safe empty value rather than being rejected, so a future additive field from FTES can
 * never break a deployed site.
 */
export function parseArticle(body: unknown): ParseResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = str(b["id"]);
  const slug = str(b["slug"]);
  const title = str(b["title"]);

  const missing: string[] = [];
  if (!id) missing.push("id");
  if (!slug) missing.push("slug");
  if (!title) missing.push("title");
  if (missing.length) return { ok: false, missing };

  const article: Article = {
    id,
    slug,
    title,
    tldr: strList(b["tldr"]),
    sections: sections(b["sections"]),
    faq: faq(b["faq"]),
  };
  const meta = str(b["meta_description"]);
  if (meta) article.meta_description = meta;
  const query = str(b["target_query"]);
  if (query) article.target_query = query;
  const html = typeof b["html"] === "string" ? b["html"] : "";
  if (html) article.html = html;

  return { ok: true, article };
}

/** Word count of the article body — computed, never trusted from the payload. */
export function articleWordCount(article: Article): number {
  return article.sections.reduce((n, s) => {
    const t = s.content.trim();
    return n + (t ? t.split(/\s+/).length : 0);
  }, 0);
}
