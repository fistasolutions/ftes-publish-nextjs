/**
 * Postgres adapter (SPEC-001).
 *
 * Takes a plain `query(text, params)` function rather than a tagged-template client, on
 * purpose: tagged templates bind EVERY `${}` as a parameter, and a table name cannot be a
 * bound parameter. A query function is the one shape every Postgres client offers, so this
 * single adapter covers Neon, Vercel Postgres, node-postgres, postgres.js and self-hosted —
 * with real placeholders ($1, $2, …) for all values.
 *
 *   Neon / Vercel:   postgresStore((t, p) => sql.query(t, p))
 *   node-postgres:   postgresStore((t, p) => pool.query(t, p))
 *   postgres.js:     postgresStore((t, p) => sql.unsafe(t, p))
 */

import type { Article } from "./article.js";
import type { ArticleStore, UpsertResult } from "./route.js";

/** `(text, params) => rows` — an array of rows, or `{ rows }`. Both are handled. */
export type QueryFn = (text: string, params: unknown[]) => Promise<unknown>;

export interface PostgresStoreOptions {
  /** Table name. Default "posts". Validated, because it is interpolated, not bound. */
  table?: string;
}

/** Create the table with this, so you don't have to design a schema. */
export const POSTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS posts (
  id               text PRIMARY KEY,
  slug             text UNIQUE NOT NULL,
  title            text NOT NULL,
  meta_description text,
  target_query     text,
  tldr             jsonb NOT NULL DEFAULT '[]'::jsonb,
  sections         jsonb NOT NULL DEFAULT '[]'::jsonb,
  faq              jsonb NOT NULL DEFAULT '[]'::jsonb,
  html             text,
  published_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);`;

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The table name is the only value in this package that reaches SQL uninterpolated by the
 * driver, so it is the only place injection could enter. Constrain it hard, up front.
 */
export function assertSafeTableName(table: string): string {
  if (!TABLE_RE.test(table)) {
    throw new Error(
      `@ftes/publish-nextjs: unsafe table name ${JSON.stringify(table)} — ` +
        "lowercase letters, digits and underscores only",
    );
  }
  return table;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as { rows?: unknown };
  return Array.isArray(r?.rows) ? (r.rows as Array<Record<string, unknown>>) : [];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function rowToArticle(row: Record<string, unknown>): Article {
  const article: Article = {
    id: String(row["id"] ?? ""),
    slug: String(row["slug"] ?? ""),
    title: String(row["title"] ?? ""),
    tldr: parseJson(row["tldr"], [] as string[]),
    sections: parseJson(row["sections"], [] as Article["sections"]),
    faq: parseJson(row["faq"], [] as Article["faq"]),
  };
  if (row["meta_description"]) article.meta_description = String(row["meta_description"]);
  if (row["target_query"]) article.target_query = String(row["target_query"]);
  if (row["html"]) article.html = String(row["html"]);
  return article;
}

export function postgresStore(query: QueryFn, options: PostgresStoreOptions = {}): ArticleStore {
  const table = assertSafeTableName(options.table ?? "posts");

  const UPSERT = `INSERT INTO ${table}
      (id, slug, title, meta_description, target_query, tldr, sections, faq, html, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, now())
    ON CONFLICT (id) DO UPDATE SET
      slug = EXCLUDED.slug,
      title = EXCLUDED.title,
      meta_description = EXCLUDED.meta_description,
      target_query = EXCLUDED.target_query,
      tldr = EXCLUDED.tldr,
      sections = EXCLUDED.sections,
      faq = EXCLUDED.faq,
      html = EXCLUDED.html,
      updated_at = now()
    RETURNING (xmax = 0) AS is_insert`;

  return {
    async upsert(article: Article): Promise<UpsertResult> {
      // One statement that both upserts and reports which it did: `xmax = 0` is true only for
      // a freshly inserted row, so 201-vs-200 needs no second query.
      const rows = rowsOf(
        await query(UPSERT, [
          article.id,
          article.slug,
          article.title,
          article.meta_description ?? null,
          article.target_query ?? null,
          JSON.stringify(article.tldr),
          JSON.stringify(article.sections),
          JSON.stringify(article.faq),
          article.html ?? null,
        ]),
      );
      return { isInsert: rows[0]?.["is_insert"] === true };
    },

    async get(slug: string): Promise<Article | null> {
      const rows = rowsOf(
        await query(`SELECT * FROM ${table} WHERE slug = $1 LIMIT 1`, [slug]),
      );
      const row = rows[0];
      return row ? rowToArticle(row) : null;
    },

    async list(): Promise<Article[]> {
      const rows = rowsOf(
        await query(`SELECT * FROM ${table} ORDER BY published_at DESC`, []),
      );
      return rows.map(rowToArticle);
    },

    async delete(slug: string): Promise<void> {
      // SPEC-002: only ever used to remove verifyInstall()'s probe. Deleting by slug (not id)
      // because the probe is identified by its fixed slug, and the table name is already
      // validated by assertSafeTableName — the slug itself is parameterised.
      await query(`DELETE FROM ${table} WHERE slug = $1`, [slug]);
    },
  };
}
