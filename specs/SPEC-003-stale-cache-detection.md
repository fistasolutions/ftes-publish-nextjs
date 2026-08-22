# SPEC-003 — Detect a cached 404, and document the rendering mode

## Purpose

A site published an article successfully and the URL kept returning 404 for two days. The
store was correct, the route was correct, the page was correct. The cause was **caching**:

`/blog/[slug]` used `generateStaticParams()` to prerender its file-based posts. That makes the
route statically rendered. `dynamicParams` defaults to `true`, so a slug absent at build time
*is* rendered on demand — but the result is then cached with no expiry. The URL had been
fetched repeatedly while the article did not yet exist, Next.js cached the `notFound()`, and
kept serving that cached 404 long after the row appeared. `export const dynamic =
"force-dynamic"` fixed it.

Two failures of ours made that expensive:

1. **The README never mentions rendering mode.** Step 4's example page has no
   `generateStaticParams`, no `dynamic`, no `revalidate` — and in that minimal form it works.
   But almost no real site looks like that. A site with an existing file-based blog *already*
   has `generateStaticParams`, which is exactly the combination that breaks. We documented the
   shape that works and left the common one undocumented.

2. **`verifyInstall()` (SPEC-002) would have passed.** It writes its probe under a fresh slug
   that has never been requested, so nothing is cached for it; the page renders on demand and
   the check reports `ok: true` — while the customer's real article stays poisoned. The tool
   built to catch "stored but not rendered" cannot catch this variant of it.

This spec closes both.

**Non-goals.** No attempt to purge the customer's cache — this package must never mutate a
site's caching state as a side effect of a diagnostic. No `next.config` inspection (we run in
the app, not over its source).

## Business Rules

### 1. Fetch the probe URL BEFORE writing

`verifyInstall` fetches the probe URL first, then writes, then fetches again. The
before-and-after pair is what makes the result interpretable:

- **404 before, 2xx after** — the page renders on demand. Correct.
- **404 before, 404 after, and the row is readable** — the page will not serve an article that
  demonstrably exists. That is the failure this spec exists for.

The pre-fetch is also a deliberate reproduction: on a statically-cached route it is exactly the
request that poisons the cache, which is what makes the second fetch diagnostic rather than
merely repeated.

### 2. A new `cache` step, reported only when it can mean something

It runs **only** when `render` failed *and* `read-back` succeeded — the one combination where
the store is proven correct and the page is proven not to serve it. Any other time it is
`skipped`, because a cache verdict on a site whose write failed would be noise.

It re-fetches with a cache-busting query string:

- **cache-busted request succeeds while the plain URL fails** → the plain URL is serving a
  **cached** response. Definitive. The fix is the rendering mode.
- **both fail** → we cannot distinguish a cached 404 from a missing page, and we say so. The
  `fix` names both causes, caching first, because the store read proves the data is there.

**It never claims certainty it does not have.** Query strings are not a reliable cache-buster
across every host, so an inconclusive result is reported as inconclusive.

### 3. The render step's `fix` stops assuming one cause

Today it says only "no page renders `/blog/[slug]` — create it". That was wrong for this
incident and sent the reader to build a file that already existed. It now branches on whether
the row was readable:

- **row NOT readable** → the page is likely missing (unchanged advice).
- **row readable** → the page exists and will not serve it. Lead with the rendering mode, name
  `export const dynamic = "force-dynamic"` and `revalidate`, and mention a stale cached 404.

### 4. The README documents rendering mode as a first-class step

A short section under step 4: if `/blog/[slug]` uses `generateStaticParams` — which any site
with an existing blog does — a new article can be served a cached 404 forever. State the two
remedies (`force-dynamic`, or a `revalidate` window) and why `revalidatePath` alone is not
enough for a negative result that was cached before the article existed.

## Data / API

`VerifyStepName` gains `"cache"`. Additive: existing consumers reading `steps[].step` see one
more value; nothing is renamed or removed.

`VerifyResult` is otherwise unchanged.

## Acceptance Criteria

1. A healthy site (404 before, 2xx after) passes, and `cache` is `skipped`.
2. Row readable + render fails + cache-busted fetch succeeds → `cache` **failed**, with a `fix`
   naming `dynamic = "force-dynamic"`.
3. Row readable + render fails + cache-busted fetch also fails → `cache` **failed**, inconclusive,
   `fix` naming both causes with caching first.
4. Row NOT readable + render fails → `cache` is `skipped`, and `render`'s `fix` keeps the
   missing-page advice.
5. The pre-fetch happens before the write, and its result is reported in the render step's
   detail.
6. Write failure → no fetching at all, `cache` skipped (unchanged from SPEC-002).
7. No fetch available → network steps and `cache` all `skipped`.
8. The probe is still always cleaned up (SPEC-002 rule 3 is unchanged).
9. `npm test` and `npm run typecheck` green.

## Patches

None yet.
