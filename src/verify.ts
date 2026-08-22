/**
 * Install verification (SPEC-002).
 *
 * This package makes it easy to install the half that RECEIVES an article and forget the half
 * that RENDERS one. That omission is invisible: the route stores the article, answers 201 with
 * a URL, and the URL 404s. FTES's liveness check then reports "failed" against a URL, which
 * tells the developer nothing about the file they never created.
 *
 * `verifyInstall()` walks the same round trip FTES will — write, read back, render, index,
 * sitemap — and names the missing piece instead of the symptom.
 *
 * It is a DEVELOPMENT-TIME tool. Nothing in the publish path calls it: a route that fetches its
 * own server deadlocks on a single-worker dev server, and this package runs on other people's
 * infrastructure, where it does not get to be clever.
 *
 * It writes a probe article to a live store, so removing it is mandatory, not best-effort.
 */

import type { Article } from "./article.js";
import type { ArticleStore, UpsertResult } from "./route.js";

/** Fixed on purpose: a leaked probe is greppable and obviously ours. */
export const PROBE_SLUG = "ftes-install-check";

export type VerifyStepName =
  | "write"
  | "read-back"
  | "render"
  /** SPEC-003: is a failing render actually a cached negative result? */
  | "cache"
  | "index"
  | "sitemap"
  | "cleanup";

export interface VerifyStep {
  step: VerifyStepName;
  status: "ok" | "failed" | "skipped";
  /** One line a human can act on. */
  detail: string;
  /** What to DO about it — the file to create or the export to add. */
  fix?: string;
}

export interface VerifyResult {
  /** True when every step that ran passed. Skipped steps do not fail the run. */
  ok: boolean;
  /** The probe URL that was fetched. */
  url: string;
  steps: VerifyStep[];
  /** One line, safe to print. */
  summary: string;
}

export interface VerifyConfig {
  /** Your site's origin, no trailing slash — the same value the route uses. */
  siteUrl: string;
  /** The SAME store the publish route writes to. Using a different one proves nothing. */
  store?: ArticleStore;
  /** Or a bare upsert, matching `createPublishRoute`. Then read-back/cleanup are skipped. */
  upsert?: (article: Article) => Promise<UpsertResult | boolean | void>;
  /** Where articles live. Default "/blog". */
  blogBasePath?: string;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function probeArticle(): Article {
  return {
    // Deterministic id so a re-run updates the same row rather than accumulating probes.
    id: "00000000-0000-4000-8000-ftesinstall".padEnd(36, "0").slice(0, 36),
    title: "FTES install check",
    slug: PROBE_SLUG,
    meta_description: "Temporary article written by verifyInstall(). Safe to delete.",
    target_query: "ftes install check",
    tldr: ["This article is a temporary install check and is removed automatically."],
    sections: [
      {
        heading: "Install check",
        content: "If you can read this in your browser, your article page renders correctly.",
      },
    ],
    faq: [],
    html: "<p>FTES install check.</p>",
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch that never throws — a network error is a step result, not an exception. */
async function tryFetch(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  try {
    const res = await fetchImpl(url, { redirect: "follow" });
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = ""; // a body we cannot read is not a failure of the status check
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: "", error: message(err) };
  }
}

/**
 * Run the install check.
 *
 * Every step is reported, and the run does NOT stop at the first failure — the ORDER of
 * failures is the diagnosis. Write fails => store or credentials. Write passes but render
 * fails => the article page is missing. Render passes but sitemap fails => only the sitemap
 * is missing. Stopping early would hide that distinction and cost another round of guessing.
 */
export async function verifyInstall(config: VerifyConfig): Promise<VerifyResult> {
  const store = config.store;
  const upsert = config.upsert;
  if (!store && !upsert) {
    throw new Error(
      "[@ftes/publish-nextjs] verifyInstall needs `store` or `upsert` — pass the SAME one your publish route uses",
    );
  }

  const siteUrl = config.siteUrl.replace(/\/$/, "");
  const blogBasePath = (config.blogBasePath ?? "/blog").replace(/\/$/, "");
  const url = `${siteUrl}${blogBasePath}/${PROBE_SLUG}`;
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  const steps: VerifyStep[] = [];
  const article = probeArticle();

  // SPEC-003: fetch BEFORE writing. The before/after pair is what makes the render result
  // interpretable — "404 then 2xx" is a page rendering on demand, while "404 then 404 with the
  // row readable" is a page refusing to serve an article that demonstrably exists.
  //
  // On a statically-cached route this request is also the one that caches the miss, which is
  // precisely why the second fetch diagnoses rather than merely repeats.
  const before = fetchImpl ? await tryFetch(fetchImpl, url) : null;

  let wrote = false;
  /** Did the store hand the article back? Proof the data side is correct. */
  let readable = false;
  try {
    if (store) await store.upsert(article);
    else await upsert!(article);
    wrote = true;
    steps.push({ step: "write", status: "ok", detail: `Stored the probe article "${PROBE_SLUG}".` });
  } catch (err) {
    steps.push({
      step: "write",
      status: "failed",
      detail: `Could not store the probe article: ${message(err)}`,
      fix: "Check the store's connection and that the posts table exists (see POSTS_TABLE_SQL).",
    });
  }

  try {
    if (!wrote) {
      steps.push({ step: "read-back", status: "skipped", detail: "Nothing was written." });
    } else if (!store?.get) {
      steps.push({
        step: "read-back",
        status: "skipped",
        detail: "This store has no get(); cannot read the article back.",
      });
    } else {
      const found = await store.get(PROBE_SLUG);
      readable = !!found;
      steps.push(
        found
          ? { step: "read-back", status: "ok", detail: "Read the probe back from the store." }
          : {
              step: "read-back",
              status: "failed",
              detail: "The write reported success but get() returned nothing.",
              fix: "The route and your page are probably reading DIFFERENT stores or tables — make them the same.",
            },
      );
    }

    if (!fetchImpl) {
      // Node 16 and similar: an honest gap beats a false alarm.
      for (const step of ["render", "cache", "index", "sitemap"] as const) {
        steps.push({
          step,
          status: "skipped",
          detail: "No fetch available in this runtime — pass `fetchImpl` to check this.",
        });
      }
    } else if (!wrote) {
      for (const step of ["render", "cache", "index", "sitemap"] as const) {
        steps.push({ step, status: "skipped", detail: "Nothing was written to render." });
      }
    } else {
      // 3. Render — THE step that the failure this spec exists for would have caught.
      const page = await tryFetch(fetchImpl, url);
      const beforeNote = before
        ? ` (before publishing it responded ${before.status})`
        : "";
      steps.push(
        page.ok
          ? {
              step: "render",
              status: "ok",
              detail: `${url} responded ${page.status}${beforeNote}.`,
            }
          : {
              step: "render",
              status: "failed",
              detail: page.error
                ? `${url} could not be reached: ${page.error}`
                : `${url} responded ${page.status}${beforeNote}.`,
              // SPEC-003: the old text assumed one cause and sent a reader to create a file
              // that already existed. Branch on the store read — it is the evidence that
              // separates "no page" from "a page that will not serve what is there".
              fix: readable
                ? `The article IS in your store but ${blogBasePath}/[slug] will not serve it. Most often the route is statically rendered — if it uses generateStaticParams, a 404 produced before the article existed is cached and served forever. Add \`export const dynamic = "force-dynamic"\` (or \`export const revalidate = 0\`) to app${blogBasePath}/[slug]/page.tsx, redeploy, and try again.`
                : `No page renders ${blogBasePath}/[slug]. Create app${blogBasePath}/[slug]/page.tsx reading from the same store (README step 4). If it exists, make sure it is deployed and not exported with dynamicParams = false.`,
            },
      );

      // 4. Cache — reported ONLY when the store is proven right and the page still will not
      // serve it. In any other situation a cache verdict is noise, so it stays `skipped`.
      if (page.ok || !readable) {
        steps.push({
          step: "cache",
          status: "skipped",
          detail: page.ok
            ? "The page rendered, so there is no cached failure to diagnose."
            : "The article was not readable from the store, so a cache verdict would be guesswork.",
        });
      } else {
        const busted = await tryFetch(fetchImpl, `${url}?ftes-cache-check=${article.id}`);
        steps.push(
          busted.ok
            ? {
                step: "cache",
                status: "failed",
                detail:
                  `The same page responded ${busted.status} with a cache-busting query string ` +
                  `but ${page.status} without one — the plain URL is serving a CACHED response.`,
                fix: `Add \`export const dynamic = "force-dynamic"\` (or \`export const revalidate = 0\`) to app${blogBasePath}/[slug]/page.tsx and redeploy. revalidatePath alone does not reliably clear a 404 that was cached before the article existed.`,
              }
            : {
                step: "cache",
                status: "failed",
                // Query strings are not a dependable cache-buster on every host, so an
                // inconclusive result is reported as inconclusive rather than dressed up.
                detail:
                  `Could not tell a cached 404 from a missing page: both the plain URL ` +
                  `(${page.status}) and a cache-busted one (${busted.status}) failed.`,
                fix: `Two causes, in order of likelihood since the article IS in your store: (1) the route is statically rendered and serving a cached 404 — add \`export const dynamic = "force-dynamic"\`; (2) app${blogBasePath}/[slug]/page.tsx does not read this store, or is not deployed.`,
              },
        );
      }

      const index = await tryFetch(fetchImpl, `${siteUrl}${blogBasePath}`);
      steps.push(
        index.ok && index.body.includes(PROBE_SLUG)
          ? { step: "index", status: "ok", detail: `${blogBasePath} lists the article.` }
          : {
              step: "index",
              status: "failed",
              detail: index.ok
                ? `${blogBasePath} responded ${index.status} but does not list the article.`
                : `${blogBasePath} responded ${index.status}.`,
              fix: `Your blog index does not read from this store, so published articles never appear on it. List store.list() in app${blogBasePath}/page.tsx.`,
            },
      );

      const sitemap = await tryFetch(fetchImpl, `${siteUrl}/sitemap.xml`);
      steps.push(
        sitemap.ok && sitemap.body.includes(PROBE_SLUG)
          ? { step: "sitemap", status: "ok", detail: "The sitemap contains the article." }
          : {
              step: "sitemap",
              status: "failed",
              detail: sitemap.ok
                ? `/sitemap.xml responded ${sitemap.status} but omits the article.`
                : `/sitemap.xml responded ${sitemap.status}.`,
              fix: "Add app/sitemap.ts using ftesSitemapEntries(await store.list()) (README step 5) — without it articles are live but undiscoverable.",
            },
      );
    }
  } finally {
    // 6. Cleanup runs whatever happened above. A probe left on a live site would make this
    // function the very kind of silent defect it exists to catch.
    if (!wrote) {
      steps.push({ step: "cleanup", status: "skipped", detail: "Nothing was written." });
    } else if (store?.delete) {
      try {
        await store.delete(PROBE_SLUG);
        steps.push({ step: "cleanup", status: "ok", detail: "Removed the probe article." });
      } catch (err) {
        steps.push({
          step: "cleanup",
          status: "failed",
          detail: `Could not remove the probe article: ${message(err)}`,
          fix: `Delete the row with slug "${PROBE_SLUG}" by hand.`,
        });
      }
    } else {
      steps.push({
        step: "cleanup",
        status: "failed",
        detail: "This store has no delete(), so the probe article is still published.",
        fix: `Delete the row with slug "${PROBE_SLUG}" by hand, or add delete(slug) to your store.`,
      });
    }
  }

  const failed = steps.filter((s) => s.status === "failed");
  const ok = failed.length === 0;
  const summary = ok
    ? "Install looks correct: the article was stored, rendered, listed and added to the sitemap."
    : `Install incomplete — ${failed.length} check(s) failed: ${failed
        .map((s) => s.step)
        .join(", ")}. ${failed[0]?.fix ?? ""}`.trim();

  return { ok, url, steps, summary };
}
