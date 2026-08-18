# @ftes/publish-nextjs

Receive and publish [FTES.AI](https://ftes.ai) articles on your Next.js site — the route
handler, a Postgres adapter, and the SEO essentials.

FTES.AI writes articles and POSTs each approved one to an endpoint on your site. This package
is that endpoint, so you don't hand-roll it.

```bash
npm i @ftes/publish-nextjs
```

## Quick start

**1. Create the table** (any Postgres — Neon, Vercel Postgres, Supabase, self-hosted):

```ts
import { POSTS_TABLE_SQL } from "@ftes/publish-nextjs/postgres"
// run it once, however you run migrations
```

**2. The route** — `app/api/ftes/publish/route.ts`:

```ts
import { createPublishRoute } from "@ftes/publish-nextjs"
import { postgresStore } from "@ftes/publish-nextjs/postgres"
import { neon } from "@neondatabase/serverless"

const sql = neon(process.env.DATABASE_URL!)

export const { POST } = createPublishRoute({
  secret: process.env.FTES_PUBLISH_SECRET!,
  siteUrl: "https://example.com",
  store: postgresStore((text, params) => sql.query(text, params)),
})
```

**3. The article page** — `app/blog/[slug]/page.tsx`:

```tsx
import { articleMetadata, articleJsonLd } from "@ftes/publish-nextjs"
import { FtesArticle } from "@ftes/publish-nextjs/react"

const opts = { siteUrl: "https://example.com" }

export async function generateMetadata({ params }) {
  const post = await store.get((await params).slug)
  return articleMetadata(post, opts)          // plain title + canonical
}

export default async function Page({ params }) {
  const post = await store.get((await params).slug)
  return (
    <>
      <FtesArticle article={post} />
      <script type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd(post, opts)) }} />
    </>
  )
}
```

**4. The sitemap** — `app/sitemap.ts`:

```ts
import { ftesSitemapEntries } from "@ftes/publish-nextjs"

export default async function sitemap() {
  return ftesSitemapEntries(await store.list(), { siteUrl: "https://example.com" })
}
```

**5. Connect it in FTES** — Setup → Integrations → Site publishing:
your endpoint URL, and the same secret you put in `FTES_PUBLISH_SECRET`.

## What it does for you

Three mistakes are easy to make by hand and **invisible once made**. This package prevents all
three:

| Mistake | Consequence | Handled |
|---|---|---|
| Rendering the article in the browser | AI crawlers see an empty page; the SEO value is zero | `FtesArticle` is a server component; nothing in this package is client-side |
| Appending instead of upserting | duplicate posts, because FTES resends the same id on retries | upsert on `id`, and the `Idempotency-Key` header is verified |
| Forgetting the sitemap | the article is live but undiscoverable | `/sitemap.xml` is revalidated on every publish |

It also compares your bearer token in constant time, keeps driver errors out of responses
(FTES shows the response body to the user), and answers `201` vs `200` correctly so FTES can
tell a new article from an update.

## Bring your own storage

No Postgres? Supply an upsert function and skip the adapter entirely:

```ts
export const { POST } = createPublishRoute({
  secret: process.env.FTES_PUBLISH_SECRET!,
  siteUrl: "https://example.com",
  upsert: async (article) => {
    const created = await myStore.save(article)   // Prisma, Mongo, KV, a CMS…
    return { isInsert: created }                  // drives 201 vs 200
  },
})
```

## Options

| Option | Default | |
|---|---|---|
| `secret` | — | required. Unset ⇒ 500, never a misleading 401 |
| `siteUrl` | — | required, origin only |
| `store` / `upsert` | — | one of the two is required |
| `blogBasePath` | `"/blog"` | where articles live |
| `revalidate` | `true` | set `false` if you don't use ISR |
| `onPublished` | — | `(article, url) => void` for logging or cache warming |

## Responses

| | |
|---|---|
| `201` / `200` | `{ url }` — created / updated |
| `400` | `malformed_json`, `missing_fields` (with `fields`), `idempotency_mismatch` |
| `401` | `unauthorized` |
| `500` | `publish_secret_not_configured`, `store_not_configured`, `store_failed` |

FTES records a failure's status and body against the article, so these are what you'll see in
the workspace when something is wrong.

## Requirements

Next.js 14+ (App Router), Node 18.17+. React is only needed for `/react`.

Your endpoint must be **HTTPS and publicly reachable** — FTES rejects private or loopback
addresses, and does not follow redirects, so register the exact final URL.

## License

MIT
