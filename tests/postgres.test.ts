/** SPEC-001 — the Postgres adapter (AC 10). Zero network: the query function is a spy. */

import { describe, expect, it } from "vitest";
import { assertSafeTableName, POSTS_TABLE_SQL, postgresStore, rowToArticle } from "../src/postgres.js";
import type { Article } from "../src/index.js";

const ARTICLE: Article = {
  id: "a1", slug: "best-crm", title: "Best CRM",
  meta_description: "d", target_query: "best crm",
  tldr: ["one"], sections: [{ heading: "H", content: "C" }],
  faq: [{ question: "Q", answer: "A" }], html: "<p>x</p>",
};

function spy(result: unknown = [{ is_insert: true }]) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = async (text: string, params: unknown[]) => {
    calls.push({ text, params });
    return result;
  };
  return { calls, query };
}

describe("table name safety", () => {
  it("rejects anything that could carry SQL — the one uninterpolated value", () => {
    for (const bad of ['posts; drop table users', 'posts"', "Posts", "1posts", "po sts", ""]) {
      expect(() => assertSafeTableName(bad)).toThrow(/unsafe table name/);
    }
  });

  it("accepts ordinary identifiers", () => {
    for (const ok of ["posts", "ftes_posts", "_p", "p1"]) {
      expect(assertSafeTableName(ok)).toBe(ok);
    }
  });

  it("validates at construction, before any SQL is built", () => {
    const { query } = spy();
    expect(() => postgresStore(query, { table: "posts; drop table users" })).toThrow();
  });
});

describe("upsert", () => {
  it("issues ONE statement, upserting on id with bound parameters", async () => {
    const { calls, query } = spy();
    await postgresStore(query).upsert(ARTICLE);

    expect(calls).toHaveLength(1);
    const { text, params } = calls[0]!;
    expect(text).toContain("INSERT INTO posts");
    expect(text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(text).toContain("RETURNING (xmax = 0) AS is_insert");
    // Every VALUE is a placeholder — nothing interpolated but the validated table name.
    expect(text).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, \$7::jsonb, \$8::jsonb, \$9, now\(\)\)/);
    expect(params[0]).toBe("a1");
    expect(params[1]).toBe("best-crm");
    expect(params[5]).toBe(JSON.stringify(["one"]));   // jsonb as a string param
  });

  it("reports insert vs update from xmax, for 201 vs 200", async () => {
    expect((await postgresStore(spy([{ is_insert: true }]).query).upsert(ARTICLE)).isInsert).toBe(true);
    expect((await postgresStore(spy([{ is_insert: false }]).query).upsert(ARTICLE)).isInsert).toBe(false);
  });

  it("handles both row shapes: an array (Neon/postgres.js) and { rows } (Vercel/pg)", async () => {
    expect((await postgresStore(spy([{ is_insert: true }]).query).upsert(ARTICLE)).isInsert).toBe(true);
    expect((await postgresStore(spy({ rows: [{ is_insert: true }] }).query).upsert(ARTICLE)).isInsert).toBe(true);
    expect((await postgresStore(spy([]).query).upsert(ARTICLE)).isInsert).toBe(false); // no rows → not an insert
  });

  it("sends nulls, not the string 'undefined', for absent optional fields", async () => {
    const { calls, query } = spy();
    const minimal: Article = { id: "a", slug: "s", title: "T", tldr: [], sections: [], faq: [] };
    await postgresStore(query).upsert(minimal);
    const { params } = calls[0]!;
    expect(params[3]).toBeNull();  // meta_description
    expect(params[4]).toBeNull();  // target_query
    expect(params[8]).toBeNull();  // html
  });

  it("uses a custom table name in every statement", async () => {
    const { calls, query } = spy();
    const store = postgresStore(query, { table: "ftes_posts" });
    await store.upsert(ARTICLE);
    await store.get!("best-crm");
    await store.list!();
    expect(calls.every((c) => c.text.includes("ftes_posts"))).toBe(true);
  });
});

describe("get / list", () => {
  it("get binds the slug and returns null when absent", async () => {
    const { calls, query } = spy([]);
    expect(await postgresStore(query).get!("nope")).toBeNull();
    expect(calls[0]!.text).toContain("WHERE slug = $1");
    expect(calls[0]!.params).toEqual(["nope"]);
  });

  it("maps rows back to articles, parsing jsonb whether it arrives as text or objects", async () => {
    const asText = rowToArticle({
      id: "a", slug: "s", title: "T",
      tldr: '["x"]', sections: '[{"heading":"H","content":"C"}]', faq: "[]",
    });
    expect(asText.tldr).toEqual(["x"]);
    expect(asText.sections).toEqual([{ heading: "H", content: "C" }]);

    const asObjects = rowToArticle({
      id: "a", slug: "s", title: "T",
      tldr: ["x"], sections: [{ heading: "H", content: "C" }], faq: [],
    });
    expect(asObjects.tldr).toEqual(["x"]);
  });

  it("survives corrupt jsonb instead of throwing", async () => {
    const a = rowToArticle({ id: "a", slug: "s", title: "T", tldr: "{not json", sections: null, faq: undefined });
    expect(a.tldr).toEqual([]);
    expect(a.sections).toEqual([]);
    expect(a.faq).toEqual([]);
  });
});

describe("the shipped schema", () => {
  it("keys on id, uniques the slug, and defaults the jsonb columns", () => {
    expect(POSTS_TABLE_SQL).toContain("id               text PRIMARY KEY");
    expect(POSTS_TABLE_SQL).toContain("slug             text UNIQUE NOT NULL");
    expect(POSTS_TABLE_SQL).toContain("'[]'::jsonb");
    expect(POSTS_TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS");
  });
});
