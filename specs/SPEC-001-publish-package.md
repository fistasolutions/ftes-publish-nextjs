# SPEC-001 — `@ftes/publish-nextjs`: the receiving half of FTES publishing

## Purpose

FTES.AI publishes approved articles by POSTing them to an endpoint the site owner hosts
(customer-side contract defined in `fteapp_backend` **SPEC-056**). Building that endpoint by
hand is ~150 lines and has three failure modes that are **invisible when you get them wrong**:

1. **Client-side rendering** — the article arrives, the page "works" in a browser, and AI
   crawlers see an empty shell. The entire point of the product is lost, silently.
2. **Append instead of upsert** — FTES resends the same article id on retries and manual
   re-publishes, so appending produces duplicate posts.
3. **A stale sitemap or index** — the article is live but undiscoverable. Observed on the first
   hand-written integration, where the post rendered at its own URL but the ISR-cached `/blog`
   index kept serving a list that did not contain it.

This package makes the correct behaviour the default. It owns the protocol; the site owner
supplies only where to store the article.

**Non-goals:** no styled blog theme (the owner keeps design control), no CMS/Git backends, no
framework other than Next.js App Router.

## Users

Next.js developers integrating FTES publishing — including agencies, who wire this into a site
template once and reuse it across every client site.

## Public API

```ts
// The route — the whole of the owner's route file
import { createPublishRoute } from "@ftes/publish-nextjs"
export const { POST } = createPublishRoute({
  secret: process.env.FTES_PUBLISH_SECRET!,   // required
  siteUrl: "https://example.com",             // required, no trailing slash
  store,                                      // an adapter …
  upsert,                                     //   … or a bare upsert function
  blogBasePath?: "/blog",                     // default "/blog"
  revalidate?: true,                          // default true
  onPublished?: (article, url) => void,        // optional hook (analytics, logging)
})

// Postgres adapter — Neon, Vercel Postgres, Supabase, self-hosted
import { postgresStore, POSTS_TABLE_SQL } from "@ftes/publish-nextjs/postgres"
const store = postgresStore(sql, { table: "posts" })

// SEO helpers
import { articleMetadata, articleJsonLd, ftesSitemapEntries } from "@ftes/publish-nextjs"

// Unstyled semantic renderer
import { FtesArticle } from "@ftes/publish-nextjs/react"
```

### Types

`FtesArticle` mirrors SPEC-056's payload exactly: `id`, `title`, `slug`, `meta_description`,
`target_query`, `tldr: string[]`, `sections: {heading, content}[]`,
`faq: {question, answer}[]`, `html`. `parseArticle(body)` validates and returns
`{ ok: true, article } | { ok: false, missing: string[] }`.

## Business Rules

### 1. Auth is timing-safe
The bearer token is compared with a constant-time comparison, never `!==`. A missing/blank
`secret` in config is a **500** (server misconfiguration), never a silent 401 — the two are
different problems and must not look alike. Wrong or missing token ⇒ **401**. The secret is
never logged, never echoed in a response.

### 2. Validation is explicit
`id`, `slug`, `title` are required — 400 listing exactly which are missing. **`html` is
optional**: FTES always sends it, but a receiver rendering from `sections` must not be forced
to store it. `tldr`/`sections`/`faq` default to `[]`. Non-object entries are dropped rather
than stored.

### 3. Upsert, never append
Keyed on `article.id`. The `Idempotency-Key` header is read and, when present, must match
`body.id`; a mismatch is a **400** (`idempotency_mismatch`) because it means the two sides
disagree about what is being published. `201` when the row was created, `200` when updated —
`isInsert` comes from the adapter.

### 4. Revalidation includes the sitemap
On success, and only on success:
`revalidatePath(blogBasePath)`, `revalidatePath(\`${blogBasePath}/${slug}\`)`,
`revalidatePath("/sitemap.xml")`. The sitemap is the one people forget; it is not optional
here. Disable the whole set with `revalidate: false` for non-ISR setups.

### 5. The response always carries the URL
`{ url: \`${siteUrl}${blogBasePath}/${slug}\` }`. FTES fetches that URL to confirm the page is
live before recording "Published", so returning it is what makes a publish succeed.

### 6. Storage errors surface as 500 with a safe message
The adapter's exception is logged server-side; the response body carries a generic message and
never the driver's error text (which can leak schema or connection details). FTES records the
status code and body verbatim into the item's `publish_error`, so the message must be safe to
show a user.

### 7. Server-only by construction
`createPublishRoute` and the SEO helpers are server-safe modules with no `"use client"`.
`FtesArticle` is a plain server component — it holds no state and no effects, so it **cannot**
be the source of a client-rendering mistake.

## The Postgres adapter

`postgresStore(sql, { table = "posts" })` accepts any tagged-template client
(`@neondatabase/serverless`, `@vercel/postgres`, `postgres.js`) and returns
`{ upsert, get, list }`.

`upsert` is a single `INSERT … ON CONFLICT (id) DO UPDATE … RETURNING (xmax = 0) AS is_insert`
— one round trip that also reports insert-vs-update. `POSTS_TABLE_SQL` is exported so the owner
can create the table without designing a schema:

```sql
CREATE TABLE IF NOT EXISTS posts (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  meta_description text,
  target_query text,
  tldr jsonb NOT NULL DEFAULT '[]',
  sections jsonb NOT NULL DEFAULT '[]',
  faq jsonb NOT NULL DEFAULT '[]',
  html text,
  published_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

The table name is interpolated, so it is validated against `^[a-z_][a-z0-9_]*$` before use —
a table name is not a bindable parameter, and this is the one place SQL injection could enter.

## SEO helpers

- `articleMetadata(article, { siteUrl, blogBasePath })` → Next.js `Metadata`: plain-string
  title, description from `meta_description`, and a **canonical** URL.
- `articleJsonLd(article, { siteUrl, blogBasePath, author?, publisher? })` → an `Article`
  JSON-LD object, for the owner to render inline in a server component.
- `ftesSitemapEntries(posts, { siteUrl, blogBasePath })` → `{ url, lastModified }[]` for
  `app/sitemap.ts`.

## Error Handling

| Condition | Status | Body |
|---|---|---|
| `secret` not configured | 500 | `{ error: "publish_secret_not_configured" }` |
| Missing/wrong bearer token | 401 | `{ error: "unauthorized" }` |
| Malformed JSON | 400 | `{ error: "malformed_json" }` |
| Missing required fields | 400 | `{ error: "missing_fields", fields: [...] }` |
| `Idempotency-Key` ≠ `body.id` | 400 | `{ error: "idempotency_mismatch" }` |
| Store threw | 500 | `{ error: "store_failed" }` (details logged, not returned) |
| Success (created / updated) | 201 / 200 | `{ url }` |

## Acceptance Criteria

1. A valid POST with a correct token stores the article and returns `{ url }` — `201` on
   create, `200` on update.
2. Wrong token ⇒ 401; **no** store call is made. Unset `secret` ⇒ 500, distinct from 401.
3. Token comparison does not short-circuit on the first differing byte (timing-safe).
4. Missing `id`/`slug`/`title` ⇒ 400 naming each missing field; **missing `html` succeeds**.
5. `Idempotency-Key` matching `body.id` succeeds; a mismatching one ⇒ 400.
6. The same article posted twice results in **one** stored row, and `200` the second time.
7. On success exactly three paths are revalidated, sitemap included; on failure, **none**.
8. `revalidate: false` performs no revalidation.
9. A throwing store ⇒ 500 whose body does not contain the driver's message.
10. `postgresStore` issues one statement, upserts on `id`, and reports `isInsert` correctly;
    an invalid table name is rejected before any SQL is built.
11. `articleMetadata` produces a plain-string title and a canonical URL;
    `articleJsonLd` produces valid `Article` JSON-LD; `ftesSitemapEntries` includes every post.
12. `FtesArticle` renders exactly one `<h1>`, all sections in order, and the FAQ — with no
    `"use client"` anywhere in the package's server entry points.
13. `npm test` green, `tsc` clean, and the built package's public exports match this spec.
14. Verified against a real deployed site (Next 16 + a real Postgres driver) before the first
    npm publish — no shipping on theory.

## Patches

_(none yet)_
