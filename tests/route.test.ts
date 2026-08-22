/**
 * SPEC-001 — the publish route.
 *
 * Every test here maps to a failure mode that is invisible in production: a leaky token
 * compare, an append instead of an upsert, a forgotten sitemap, a driver error leaking to a
 * user-visible field.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublishRoute, timingSafeEqual } from "../src/route.js";
import type { Article, UpsertResult } from "../src/index.js";

const SECRET = "s3cret-token";
const SITE = "https://example.com";

const VALID = {
  id: "art-1",
  title: "Best CRM",
  slug: "best-crm",
  meta_description: "A guide.",
  target_query: "best crm",
  tldr: ["one", "two"],
  sections: [{ heading: "H", content: "C" }],
  faq: [{ question: "Q", answer: "A" }],
  html: "<article>x</article>",
};

/** Revalidation is a Next.js import; capture the paths it would touch. */
const revalidated: string[] = [];
/** Set to make revalidatePath throw — the "static export / wrong runtime" case (SPEC-002). */
let revalidateError: Error | null = null;
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    if (revalidateError) throw revalidateError;
    revalidated.push(p);
  },
}));

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SITE}/api/ftes/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const auth = (token = SECRET) => ({ authorization: `Bearer ${token}` });

function makeStore(result: UpsertResult = { isInsert: true }) {
  const calls: Article[] = [];
  return {
    calls,
    store: {
      upsert: async (a: Article) => {
        calls.push(a);
        return result;
      },
    },
  };
}

beforeEach(() => {
  revalidated.length = 0;
  revalidateError = null;
});

describe("auth (AC 2, 3)", () => {
  it("stores nothing and returns 401 for a wrong token", async () => {
    const { calls, store } = makeStore();
    const { POST } = createPublishRoute({ secret: SECRET, siteUrl: SITE, store });
    const res = await POST(post(VALID, auth("wrong")));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls).toHaveLength(0); // never touch the store on a failed auth
  });

  it("returns 401 for a missing or malformed header", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    expect((await POST(post(VALID))).status).toBe(401);
    expect((await POST(post(VALID, { authorization: SECRET }))).status).toBe(401); // no "Bearer "
    expect((await POST(post(VALID, { authorization: "Bearer " }))).status).toBe(401);
  });

  it("distinguishes an unconfigured secret (500) from a wrong token (401)", async () => {
    // Reporting a missing secret as 401 would send the operator hunting for a wrong token
    // that does not exist.
    const { POST } = createPublishRoute({
      secret: undefined,
      siteUrl: SITE,
      store: makeStore().store,
    });
    const res = await POST(post(VALID, auth()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "publish_secret_not_configured" });
  });

  it("compares tokens without short-circuiting on the first differing byte", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false); // length difference folded in, not early-returned
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a", "")).toBe(false);
  });
});

describe("validation (AC 4, 5)", () => {
  it("names every missing required field", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    const res = await POST(post({ title: "T" }, auth()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields", fields: ["id", "slug"] });
  });

  it("SUCCEEDS without html — a site rendering from sections must not be forced to store it", async () => {
    const { calls, store } = makeStore();
    const { POST } = createPublishRoute({ secret: SECRET, siteUrl: SITE, store });
    const { html, ...noHtml } = VALID;
    const res = await POST(post(noHtml, auth()));
    expect(res.status).toBe(201);
    expect(calls[0]!.html).toBeUndefined();
  });

  it("rejects malformed JSON", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    const res = await POST(post("{not json", auth()));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "malformed_json" });
  });

  it("accepts a matching Idempotency-Key and refuses a mismatching one", async () => {
    const { store } = makeStore();
    const { POST } = createPublishRoute({ secret: SECRET, siteUrl: SITE, store });
    expect((await POST(post(VALID, { ...auth(), "idempotency-key": "art-1" }))).status).toBe(201);

    const bad = await POST(post(VALID, { ...auth(), "idempotency-key": "other" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "idempotency_mismatch" });
  });
});

describe("upsert + response (AC 1, 6)", () => {
  it("returns 201 on create and 200 on update, with the URL both times", async () => {
    const created = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore({ isInsert: true }).store,
    });
    const a = await created.POST(post(VALID, auth()));
    expect(a.status).toBe(201);
    expect(await a.json()).toEqual({ url: `${SITE}/blog/best-crm` });

    const updated = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore({ isInsert: false }).store,
    });
    const b = await updated.POST(post(VALID, auth()));
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ url: `${SITE}/blog/best-crm` });
  });

  it("passes the parsed article through, dropping junk entries", async () => {
    const { calls, store } = makeStore();
    const { POST } = createPublishRoute({ secret: SECRET, siteUrl: SITE, store });
    await POST(
      post(
        { ...VALID, tldr: ["keep", "", null, 3], sections: [{ heading: "H", content: "C" }, "junk"] },
        auth(),
      ),
    );
    expect(calls[0]!.tldr).toEqual(["keep"]);
    expect(calls[0]!.sections).toEqual([{ heading: "H", content: "C" }]);
  });

  it("honours a bare upsert function as well as a store", async () => {
    const seen: Article[] = [];
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      upsert: async (a) => {
        seen.push(a);
        return { isInsert: false };
      },
    });
    const res = await POST(post(VALID, auth()));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("returns 500 when neither store nor upsert is configured", async () => {
    const { POST } = createPublishRoute({ secret: SECRET, siteUrl: SITE });
    const res = await POST(post(VALID, auth()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "store_not_configured" });
  });

  it("honours a custom blogBasePath and strips trailing slashes", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: `${SITE}/`,
      blogBasePath: "/articles/",
      store: makeStore().store,
    });
    const res = await POST(post(VALID, auth()));
    expect(await res.json()).toEqual({ url: `${SITE}/articles/best-crm` });
  });
});

describe("revalidation (AC 7, 8)", () => {
  it("revalidates the post, the index AND the sitemap on success", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    await POST(post(VALID, auth()));
    // The sitemap is the one hand-rolled integrations forget — it is not optional here.
    expect(revalidated).toEqual(["/blog", "/blog/best-crm", "/sitemap.xml"]);
  });

  it("revalidates NOTHING when the publish failed", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: { upsert: async () => { throw new Error("db down"); } },
    });
    expect((await POST(post(VALID, auth()))).status).toBe(500);
    expect(revalidated).toEqual([]);
  });

  it("skips revalidation entirely when disabled", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      revalidate: false,
      store: makeStore().store,
    });
    await POST(post(VALID, auth()));
    expect(revalidated).toEqual([]);
  });
});

describe("error safety (AC 9)", () => {
  it("never leaks the driver's message — FTES shows this body to the user", async () => {
    const secretish = 'password=hunter2 host=db.internal relation "posts" does not exist';
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: { upsert: async () => { throw new Error(secretish); } },
    });
    const res = await POST(post(VALID, auth()));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toBe(JSON.stringify({ error: "store_failed" }));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.internal");
  });

  it("a throwing onPublished hook does not fail an already-saved publish", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
      onPublished: () => {
        throw new Error("analytics exploded");
      },
    });
    expect((await POST(post(VALID, auth()))).status).toBe(201);
  });

  it("calls onPublished with the article and its URL", async () => {
    const seen: Array<[string, string]> = [];
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
      onPublished: (a, url) => {
        seen.push([a.id, url]);
      },
    });
    await POST(post(VALID, auth()));
    expect(seen).toEqual([["art-1", `${SITE}/blog/best-crm`]]);
  });
});

describe("revalidation failures are reported, not swallowed (SPEC-002)", () => {
  it("returns a warning when revalidation throws, and still succeeds", async () => {
    // A revalidation failure is the most common reason an article is stored but never renders.
    // Previously it went to console.warn only, so the response looked identical to a healthy
    // publish — and the site owner learned about it from a 404 days later.
    revalidateError = new Error("static export: revalidatePath is unavailable");

    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    const res = await POST(post(VALID, auth()));
    const body = (await res.json()) as { url: string; warnings?: string[] };

    // The article IS saved — a revalidation failure must never turn that into a failure,
    // or FTES marks it failed and the owner chases a ghost.
    expect(res.status).toBe(201);
    expect(body.url).toBe(`${SITE}/blog/best-crm`);
    expect(body.warnings?.[0]).toContain("revalidation failed");
    expect(body.warnings?.[0]).toContain("verifyInstall");
    revalidateError = null;
  });

  it("omits `warnings` entirely on a clean publish", async () => {
    const { POST } = createPublishRoute({
      secret: SECRET,
      siteUrl: SITE,
      store: makeStore().store,
    });
    const body = (await (await POST(post(VALID, auth()))).json()) as Record<string, unknown>;
    // Absent, not []. An empty array claims "we checked and found none", which is a different
    // and stronger statement than "nothing to report".
    expect("warnings" in body).toBe(false);
    expect(body).toEqual({ url: `${SITE}/blog/best-crm` });
  });
});
