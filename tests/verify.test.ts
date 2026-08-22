/**
 * SPEC-002 — install verification.
 *
 * The case that motivated all of this: a site installed the publish route, skipped the article
 * page, and every signal said success. `verifyInstall` must turn that into a named missing file
 * — and must never leave its probe article on a live site.
 */

import { describe, expect, it, vi } from "vitest";
import { PROBE_SLUG, verifyInstall } from "../src/verify.js";
import type { VerifyResult, VerifyStep, VerifyStepName } from "../src/verify.js";
import type { Article } from "../src/article.js";
import type { ArticleStore } from "../src/route.js";

/** In-memory store with the full optional surface. */
function memoryStore(): ArticleStore & { rows: Map<string, Article> } {
  const rows = new Map<string, Article>();
  return {
    rows,
    async upsert(a) {
      const isInsert = !rows.has(a.slug);
      rows.set(a.slug, a);
      return { isInsert };
    },
    async get(slug) {
      return rows.get(slug) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async delete(slug) {
      rows.delete(slug);
    },
  };
}

/**
 * A fetch stub keyed by EXACT pathname. Substring matching would be a trap here: "/blog" is a
 * prefix of "/blog/<slug>", so a site with no article page would appear to serve one — which
 * is precisely the bug these tests exist to catch.
 */
function fakeFetch(routes: Array<[string, { status: number; body?: string }]>) {
  const byPath = new Map(routes.map(([path, res]) => [path.replace(/\/$/, ""), res]));
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace(/\/$/, "");
    const res = byPath.get(path);
    return res
      ? new Response(res.body ?? "", { status: res.status })
      : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const SITE = "https://example.com";
const step = (r: VerifyResult, name: VerifyStepName): VerifyStep =>
  r.steps.find((s) => s.step === name)!;

const HEALTHY: Array<[string, { status: number; body?: string }]> = [
  [`/blog/${PROBE_SLUG}`, { status: 200, body: "<h1>FTES install check</h1>" }],
  ["/sitemap.xml", { status: 200, body: `<url><loc>${SITE}/blog/${PROBE_SLUG}</loc></url>` }],
  ["/blog", { status: 200, body: `<a href="/blog/${PROBE_SLUG}">check</a>` }],
];

describe("verifyInstall — the happy path", () => {
  it("passes every step and leaves nothing behind", async () => {
    const store = memoryStore();
    const result = await verifyInstall({
      siteUrl: SITE,
      store,
      fetchImpl: fakeFetch(HEALTHY),
    });

    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${SITE}/blog/${PROBE_SLUG}`);
    expect(result.steps.filter((s) => s.status === "failed")).toEqual([]);
    // The probe must not survive on a live site.
    expect(store.rows.has(PROBE_SLUG)).toBe(false);
    expect(step(result, "cleanup").status).toBe("ok");
  });
});

describe("verifyInstall — the failure this spec exists for", () => {
  it("names the missing article page when the URL 404s", async () => {
    // The real incident: store works, /blog works, the [slug] page was never created.
    const result = await verifyInstall({
      siteUrl: SITE,
      store: memoryStore(),
      fetchImpl: fakeFetch([
        ["/sitemap.xml", { status: 200, body: "<urlset/>" }],
        ["/blog", { status: 200, body: "<h1>Blog</h1>" }],
      ]),
    });

    expect(result.ok).toBe(false);
    const render = step(result, "render");
    expect(render.status).toBe("failed");
    // A URL is a symptom; a filename is a fix. This is the whole point of the spec.
    expect(render.fix).toContain("app/blog/[slug]/page.tsx");
    expect(result.summary).toContain("render");
  });

  it("still reports the store write as OK, so the diagnosis is unambiguous", async () => {
    const result = await verifyInstall({
      siteUrl: SITE,
      store: memoryStore(),
      fetchImpl: fakeFetch([]),
    });
    // write ok + render failed => "your page is missing", not "your database is broken".
    expect(step(result, "write").status).toBe("ok");
    expect(step(result, "read-back").status).toBe("ok");
    expect(step(result, "render").status).toBe("failed");
  });

  it("fails only the sitemap step when the page renders but the sitemap omits it", async () => {
    const result = await verifyInstall({
      siteUrl: SITE,
      store: memoryStore(),
      fetchImpl: fakeFetch([
        [`/blog/${PROBE_SLUG}`, { status: 200, body: "ok" }],
        ["/sitemap.xml", { status: 200, body: "<urlset></urlset>" }],
        ["/blog", { status: 200, body: `<a href="/blog/${PROBE_SLUG}">x</a>` }],
      ]),
    });

    expect(result.ok).toBe(false);
    expect(step(result, "render").status).toBe("ok");
    expect(step(result, "index").status).toBe("ok");
    expect(step(result, "sitemap").status).toBe("failed");
    expect(step(result, "sitemap").fix).toContain("app/sitemap.ts");
  });

  it("flags an index that responds but does not list the article", async () => {
    const result = await verifyInstall({
      siteUrl: SITE,
      store: memoryStore(),
      fetchImpl: fakeFetch([
        [`/blog/${PROBE_SLUG}`, { status: 200, body: "ok" }],
        ["/sitemap.xml", { status: 200, body: `<loc>${SITE}/blog/${PROBE_SLUG}</loc>` }],
        ["/blog", { status: 200, body: "<h1>My hand-written blog</h1>" }],
      ]),
    });
    expect(step(result, "index").status).toBe("failed");
    expect(step(result, "index").fix).toContain("store.list()");
  });
});

describe("verifyInstall — the probe never survives", () => {
  it("cleans up even when every network step failed", async () => {
    const store = memoryStore();
    await verifyInstall({ siteUrl: SITE, store, fetchImpl: fakeFetch([]) });
    expect(store.rows.has(PROBE_SLUG)).toBe(false);
  });

  it("forces ok:false and names the slug when the store cannot delete", async () => {
    const store = memoryStore();
    delete (store as Partial<ArticleStore>).delete;
    const result = await verifyInstall({
      siteUrl: SITE,
      store,
      fetchImpl: fakeFetch(HEALTHY),
    });

    // Everything else passed, but a probe left on a live site is a defect, not a footnote.
    expect(result.ok).toBe(false);
    expect(step(result, "cleanup").status).toBe("failed");
    expect(step(result, "cleanup").fix).toContain(PROBE_SLUG);
  });

  it("forces ok:false when delete throws", async () => {
    const store = memoryStore();
    store.delete = async () => {
      throw new Error("permission denied");
    };
    const result = await verifyInstall({
      siteUrl: SITE,
      store,
      fetchImpl: fakeFetch(HEALTHY),
    });
    expect(result.ok).toBe(false);
    expect(step(result, "cleanup").detail).toContain("permission denied");
  });
});

describe("verifyInstall — degraded environments", () => {
  it("does not fetch anything when the write failed", async () => {
    const fetchImpl = fakeFetch(HEALTHY);
    const result = await verifyInstall({
      siteUrl: SITE,
      store: {
        async upsert() {
          throw new Error("relation \"posts\" does not exist");
        },
      },
      fetchImpl,
    });

    expect(step(result, "write").status).toBe("failed");
    expect(step(result, "write").detail).toContain("does not exist");
    expect(step(result, "render").status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips network steps (not fails them) when no fetch exists", async () => {
    const store = memoryStore();
    // Node 18+ ships a global fetch, so the old-runtime case only appears if we remove it.
    vi.stubGlobal("fetch", undefined);
    const result = await verifyInstall({ siteUrl: SITE, store });
    vi.unstubAllGlobals();
    // An honest gap beats a false alarm on an old runtime.
    for (const name of ["render", "index", "sitemap"] as const) {
      expect(step(result, name).status).toBe("skipped");
    }
    expect(result.ok).toBe(true);
  });

  it("skips read-back and cleanup for a bare upsert, and says so", async () => {
    const result = await verifyInstall({
      siteUrl: SITE,
      upsert: async () => ({ isInsert: true }),
      fetchImpl: fakeFetch(HEALTHY),
    });
    expect(step(result, "read-back").status).toBe("skipped");
    // No store => no delete => the probe is live and the report must not hide it.
    expect(step(result, "cleanup").status).toBe("failed");
    expect(result.ok).toBe(false);
  });

  it("refuses to run with neither store nor upsert", async () => {
    await expect(verifyInstall({ siteUrl: SITE })).rejects.toThrow(/store.*upsert/i);
  });

  it("respects a custom blogBasePath", async () => {
    const result = await verifyInstall({
      siteUrl: SITE,
      blogBasePath: "/insights/",
      store: memoryStore(),
      fetchImpl: fakeFetch([[`/insights/${PROBE_SLUG}`, { status: 200, body: "ok" }]]),
    });
    expect(result.url).toBe(`${SITE}/insights/${PROBE_SLUG}`);
    expect(step(result, "render").status).toBe("ok");
  });
});
