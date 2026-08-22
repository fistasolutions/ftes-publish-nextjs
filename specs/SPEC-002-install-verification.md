# SPEC-002 — Make a half-installed site fail loudly, not silently

## Purpose

A real publish failed on a customer site, and the diagnosis took a database query to reach.
The chain was:

1. FTES POSTed an approved article to the site's endpoint.
2. The route stored it, revalidated, and answered `201` with the article's URL.
3. The URL 404'd. It was also absent from the blog index and the sitemap.
4. FTES's liveness check refused to claim success, so the workspace showed **failed** with
   "your endpoint reported success but the URL did not respond".

Nothing was wrong with the write path. The site had installed the **receiving** half of this
package (the publish route) and not the **reading** half — the `[slug]` page and the sitemap
that read back from the same store. Three read surfaces were missing at once, which is the
signature of a store that nothing renders from.

The README documents those steps and even warns the page "is not optional". Documentation was
not enough, and it never is for a step whose omission is invisible.

**The package's own framing is the indictment.** It says: *"Three mistakes are easy to make by
hand and invisible once made. This package prevents all three."* A half-install is a fourth
mistake of exactly that kind — and this package currently *causes* its invisibility by
answering `201` with a confident URL for a page that cannot exist.

This spec makes the failure detectable at install time, and impossible to swallow at run time.

**Non-goals.** No change to the publish contract's request or success semantics — FTES's
liveness check stays the authority on "is it live" (a route cannot reliably fetch its own
server: single-worker dev servers deadlock, and serverless self-calls are neither free nor
guaranteed routable). No scaffolding/codegen of the customer's page. No runtime dependency
added — this package has none and will keep none.

## Users & Roles

The developer installing the package on their own Next.js site. They run the check once,
during setup, from a script or a temporary route. It is a development-time tool: it writes and
then removes a probe article, so it is never something FTES calls.

## Business Rules

### 1. `verifyInstall()` — prove the read path exists before a real article needs it

An exported async function that exercises the full round trip the way FTES will:

1. **write** — upsert a probe article through the configured store;
2. **read back** — `store.get(slug)`, if the store implements it;
3. **render** — fetch `${siteUrl}${blogBasePath}/${slug}` and require a 2xx;
4. **index** — fetch `${blogBasePath}` and report whether the slug appears;
5. **sitemap** — fetch `/sitemap.xml` and report whether the URL appears;
6. **clean up** — always, including on failure (see rule 3).

Each step returns `ok | failed | skipped` with a one-line human reason. The result names the
step that broke, so the developer is not left comparing their site to a README.

### 2. The report says what to DO, not merely what failed

A failed step carries a `fix` string naming the file to create or the export to add. "Step 3
failed" is a symptom; "no page renders `/blog/<slug>` — add `app/blog/[slug]/page.tsx` (README
step 4)" is a fix. The whole reason this bug was expensive is that the failure named a URL
rather than a missing file.

**The order of failures is diagnostic and must be preserved.** Write fails → store/credentials.
Write succeeds and render fails → the page is missing. Render succeeds and sitemap fails → only
step 5 is missing. Reporting all steps rather than stopping at the first is what makes that
distinction visible in one run.

### 3. The probe article must never survive

It is written to the customer's live store, so removal is mandatory and runs in a `finally`.
- Its slug is `ftes-install-check` (fixed, so a leaked probe is greppable and obviously ours).
- It is removed via `store.delete?.(slug)` when the store supports it. When it does not, the
  result says so **loudly** with the slug to remove by hand — a silent orphan on a live site
  would be this spec creating the class of bug it exists to prevent.
- `postgresStore` gains `delete(slug)` so the supported path is the default path.

### 4. Revalidation failure is reported, never swallowed

Today a failed `revalidatePath` is caught and `console.warn`ed, and the route still answers
`201`. That is the single most common cause of "stored but not rendered", and the response says
nothing about it.

The success body gains an optional **`warnings: string[]`**. It is additive — FTES reads only
`url` from the success body and ignores unknown fields — but it puts the reason in the response a
developer is already looking at, instead of in a server log they are not.

The `try/catch` stays: a revalidation failure must still not fail a publish whose article is
genuinely saved. The article is stored either way; the difference is that the caller is now told.

### 5. Verification is opt-in and never runs in the publish path

`verifyInstall()` is only ever called by the developer. Nothing in `createPublishRoute` fetches
anything. A route that self-fetches deadlocks on a single-worker dev server, and this package
runs on other people's infrastructure — it does not get to be clever there.

## Data / API

```ts
// new subpath export: "@ftes/publish-nextjs/verify"
export interface VerifyStep {
  step: "write" | "read-back" | "render" | "index" | "sitemap" | "cleanup";
  status: "ok" | "failed" | "skipped";
  detail: string;
  fix?: string;
}

export interface VerifyResult {
  ok: boolean;          // every non-skipped step passed
  url: string;          // the probe URL that was fetched
  steps: VerifyStep[];
  summary: string;      // one line, safe to print
}

export function verifyInstall(config: VerifyConfig): Promise<VerifyResult>;
```

`VerifyConfig` mirrors the shape of `PublishRouteConfig` (`store`/`upsert`, `siteUrl`,
`blogBasePath`) plus an injectable `fetchImpl` so the suite runs with zero network.

`ArticleStore` gains an optional `delete?(slug: string): Promise<void>`.
`postgresStore` implements it. Optional, so no existing custom store breaks.

**A fourth subpath means editing `package.json#exports` and `tsconfig.build.json` coverage**
(SPEC-001's rule) — verified by a test that imports it, not by inspection.

## Error Handling

- No `store` and no `upsert` → throws immediately with the missing field named.
- A step that throws → captured as `failed` with the message; the run continues so the full
  picture is reported.
- `fetch` unavailable and no `fetchImpl` → the network steps are `skipped`, not `failed`; a
  Node 16 user gets an honest gap rather than a false alarm.
- Cleanup failure → `failed` with the slug to delete by hand, and `ok` is forced false. A live
  site keeping a probe article is a defect, not a footnote.

## Acceptance Criteria

1. `verifyInstall` returns `ok: true` when write, render, index and sitemap all succeed.
2. A site with a working store and **no article page** returns `ok: false`, the `render` step
   `failed`, and a `fix` naming `app/blog/[slug]/page.tsx` — the exact case that caused this.
3. A site whose page renders but whose sitemap omits the URL fails only the `sitemap` step.
4. The probe is deleted on success **and** on failure; a store without `delete` reports the
   manual cleanup with the slug.
5. Cleanup failure forces `ok: false`.
6. A store write failure reports `write` failed and does not fetch anything.
7. Missing `fetch` with no `fetchImpl` marks the network steps `skipped`, and `ok` stays true
   when the store steps passed.
8. `createPublishRoute` includes `warnings` when revalidation fails, still answers 2xx, and
   still returns the same `url` — proving the addition is backward-compatible.
9. No `warnings` key on a clean publish (absent, not an empty array — an empty array reads as
   "we checked and found none", which is a different claim).
10. `@ftes/publish-nextjs/verify` is importable from the built package.
11. `npm test` and `npm run typecheck` green.

## Manual verification

- [ ] On a site missing `app/blog/[slug]/page.tsx`, `verifyInstall` names that file.
- [ ] After adding the page, it returns `ok: true` and leaves no `ftes-install-check` row.

## Patches

None yet.
