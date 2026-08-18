# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Monorepo context:** this is one of **six** independently-versioned repos (git submodules)
> under `ftesaiapp_main/`. The shared playbook is `../CLAUDE.md`. This repo —
> `ftes-publish-nextjs` — is the **only PUBLIC, npm-published** one: it is the customer-side
> half of FTES publishing, installed into *their* Next.js site. Treat every export as a
> published API.

## What this is

`@ftes/publish-nextjs` implements the receiving end of the publish contract that
`fteapp_backend` **SPEC-056** defines. FTES POSTs an approved article to a customer's endpoint;
this package IS that endpoint, plus the SEO helpers and an unstyled renderer.

**The contract is the shared truth.** `src/article.ts` mirrors SPEC-056's payload. If that spec
changes, this file changes in the same breath — a field added on one side and missed on the
other is silent data loss.

## Commands

```bash
npm install
npm test           # Vitest, node env, tests/**/*.test.ts
npm run test:watch
npm run typecheck  # tsc --noEmit — the real gate
npm run build      # tsc -p tsconfig.build.json → dist/
```

`prepublishOnly` runs typecheck + tests + build, so a broken package cannot be published.

## Structure

```
src/
  index.ts      public server-safe entry: route + article + seo re-exports
  route.ts      createPublishRoute() — auth, validation, upsert, revalidation
  article.ts    the CONTRACT: types + parseArticle()
  seo.ts        articleMetadata / articleJsonLd / faqJsonLd / ftesSitemapEntries
  postgres.ts   postgresStore(query, {table}) + POSTS_TABLE_SQL
  react.tsx     <FtesArticle> — server component, unstyled
specs/          SPEC-001 — the source of truth (see Rule 2 in ../CLAUDE.md)
```

Three subpath exports: `.`, `./postgres`, `./react`. Adding a fourth means editing
`package.json#exports` **and** `tsconfig.build.json` coverage.

## Non-negotiables for this repo

1. **No `"use client"`, ever.** The package's entire value is that the article ends up in
   server-rendered HTML, because AI crawlers do not execute JavaScript. A client directive
   anywhere in this module graph silently destroys the product's purpose. `FtesArticle` holds
   no state and no effects for this reason.
2. **Never leak a driver error into a response.** FTES displays the response body to the user
   verbatim; a Postgres message can carry schema, host and credentials. Log the real error,
   return a generic code (`store_failed`).
3. **Timing-safe token comparison.** `!==` leaks how much of a secret a caller guessed.
4. **Upsert, never append.** FTES resends the same `id`/`Idempotency-Key` on retries and manual
   re-publishes.
5. **Revalidate `/sitemap.xml`.** Forgetting it leaves articles live but undiscoverable — this
   was a real defect on the first integration, and the reason this package exists.
6. **The table name is the only uninterpolated SQL value.** It stays behind
   `assertSafeTableName` (`^[a-z_][a-z0-9_]*$`); every other value is a bound parameter.
7. **Additive-only public API.** Users pin versions; a renamed export is a breaking change.
   Optional config with a default, never a required new argument.
8. **Zero runtime dependencies.** `next` and `react` are peers; nothing else. A package this
   small should never pull a tree into a customer's site.

## Testing

Vitest, node env, zero network — the store is a spy and `next/cache` is mocked. Every
acceptance criterion in `specs/SPEC-001` has a test. New behaviour ships with one; a test that
asserts old behaviour after an intentional change must be updated **with a comment saying why**.

## Before publishing

Verified against a real site first (dogfooded on `dynamence.com`: Next 16 +
`@neondatabase/serverless`, no ORM). Do not publish a version that has only ever run against
mocks — every defect found in this product so far surfaced when something real ran through it.
