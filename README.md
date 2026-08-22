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

**2. The shared store** — `lib/ftes-store.ts`:

```ts
import { postgresStore } from "@ftes/publish-nextjs/postgres"
import { neon } from "@neondatabase/serverless"

export const SITE = "https://example.com"

const sql = neon(process.env.DATABASE_URL!)

export const store = postgresStore((text, params) => sql.query(text, params))
```

Everything below imports from this one file, so your site URL and your database connection are
defined once. (Any Postgres client works — `postgresStore` takes a `query(text, params)`
function: `pool.query` for node-postgres, `sql.unsafe` for postgres.js, `sql.query` for Neon and
Vercel Postgres.)

**3. The route** — `app/api/ftes/publish/route.ts`:

```ts
import { createPublishRoute } from "@ftes/publish-nextjs"
import { store, SITE } from "@/lib/ftes-store"

export const { POST } = createPublishRoute({
  secret: process.env.FTES_PUBLISH_SECRET!,
  siteUrl: SITE,
  store,
})
```

**4. The article page** — `app/blog/[slug]/page.tsx`:

```tsx
import { articleMetadata, articleJsonLd } from "@ftes/publish-nextjs"
import { FtesArticle } from "@ftes/publish-nextjs/react"
import { store, SITE } from "@/lib/ftes-store"

const opts = { siteUrl: SITE }

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

This page is not optional. FTES fetches the URL it publishes to and records the publish as
**failed** if nothing responds — so without it an article stores successfully and still shows as
a failure in the workspace.

**5. The blog index** — `app/blog/page.tsx` (optional, but easy to get wrong):

```tsx
import { store } from "@/lib/ftes-store"

export default async function Blog() {
  const posts = await store.list()
  return (
    <ul>
      {posts.map((p) => (
        <li key={p.slug}><a href={`/blog/${p.slug}`}>{p.title}</a></li>
      ))}
    </ul>
  )
}
```

If your blog index reads from somewhere else — MDX files, an older CMS — published articles
will never appear on it, even though each one is reachable at its own URL. That is not an error
anywhere; it just quietly looks like nothing was published.

**6. The sitemap** — `app/sitemap.ts`:

```ts
import { ftesSitemapEntries } from "@ftes/publish-nextjs"
import { store, SITE } from "@/lib/ftes-store"

export default async function sitemap() {
  return ftesSitemapEntries(await store.list(), { siteUrl: SITE })
}
```

**7. Connect it in FTES** — Setup → Integrations → Site publishing:
your endpoint URL, and the same secret you put in `FTES_PUBLISH_SECRET`.

**8. Verify the install — do not skip this:**

```ts
import { verifyInstall } from "@ftes/publish-nextjs/verify"
import { store, SITE } from "@/lib/ftes-store"

const result = await verifyInstall({ siteUrl: SITE, store })
console.log(result.summary)
console.table(result.steps)
```

Run it once against your deployed site. It writes a probe article, fetches its URL, checks the
index and the sitemap, then deletes the probe — and names the file to create if a step fails.

Steps 1–3 make FTES's publish succeed. Steps 4–6 are what make the article **exist**. It is
entirely possible to finish step 3, see `201 Created`, and have a site that serves nothing —
`verifyInstall` is how you find that out in a minute instead of after a real article fails.

## What it does for you

Four mistakes are easy to make by hand and **invisible once made**. This package prevents all
four:

| Mistake | Consequence | Handled |
|---|---|---|
| Rendering the article in the browser | AI crawlers see an empty page; the SEO value is zero | `FtesArticle` is a server component; nothing in this package is client-side |
| Appending instead of upserting | duplicate posts, because FTES resends the same id on retries | upsert on `id`, and the `Idempotency-Key` header is verified |
| Forgetting the sitemap | the article is live but undiscoverable | `/sitemap.xml` is revalidated on every publish |
| Installing the publish route but not the article page | FTES stores the article, returns a URL, and the URL 404s | `verifyInstall()` fetches the URL it would publish and names the missing file |

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

Next.js 14+ (**App Router** — `revalidatePath` has no Pages Router equivalent), Node 18.17+.
React is only needed for `/react`.

`postgresStore` is a **Postgres** adapter. On MySQL, MongoDB, an ORM, or Markdown files, skip it
and pass your own `upsert` function instead — `createPublishRoute` accepts
`upsert: async (article) => ({ isInsert })` and owns everything else (auth, validation,
idempotency, revalidation, error masking).

Your endpoint must be **HTTPS and publicly reachable** — FTES rejects private or loopback
addresses, and does not follow redirects, so register the exact final URL.

## License

MIT
