import { describe, expect, it } from "vitest";
import worker, { type Env } from "../../server/cloudflare/worker";

/**
 * The Cloudflare entry point: routing, CORS, and the D1 binding order.
 *
 * Bind order is the reason this file exists. `statement.bind(a, b, c, …)` is positional, so
 * swapping two arguments writes a pattern id into the detector column and nothing anywhere
 * fails — the insert succeeds, the aggregate is silently wrong, and it stays wrong for as
 * long as the table lives. It is exactly the class of bug that is invisible until someone
 * reads the data months later and cannot explain it.
 */

interface Bound {
  query: string;
  values: unknown[];
}

function fakeD1() {
  const bound: Bound[] = [];
  const db = {
    prepare(query: string) {
      const make = (_values: unknown[] = []) => ({
        bind: (...v: unknown[]) => {
          bound.push({ query, values: v });
          return make(v);
        },
      });
      return make();
    },
    batch: async (statements: unknown[]) => statements,
  };
  return { bound, env: { DB: db } as unknown as Env };
}

const day = Math.floor(Date.now() / 86_400_000);

const record = {
  patternId: "scarcity.stock",
  detectorId: "scarcity.stock@1",
  confidenceQuartile: 4,
  funnelStage: "pdp",
  site: "shein.com",
  originCategory: "ota_travel",
  rulepackVersion: "42",
  dayBucket: day,
};

const post = (body: unknown, path = "/counts") =>
  new Request(`https://w.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("cloudflare worker", () => {
  it("binds every column in the order the SQL declares", async () => {
    const { bound, env } = fakeD1();
    const res = await worker.fetch(post({ v: 2, records: [record] }), env);
    expect(res.status).toBe(204);
    expect(bound).toHaveLength(1);

    // Positional and silent when wrong: a swap writes a pattern id into the detector column,
    // the insert succeeds, and the aggregate is quietly corrupt for the life of the table.
    expect(bound[0]?.values).toEqual([
      "scarcity.stock",
      "scarcity.stock@1",
      "pdp",
      "shein.com",
      "ota_travel",
      "42",
      day,
      4,
      1,
    ]);

    // And the order must match the column list in the statement itself, not just my memory
    // of it. Parsed from the query so the two cannot drift apart.
    const columns = /insert into counts \(([\s\S]*?)\)/.exec(bound[0]?.query ?? "")?.[1] ?? "";
    const names = columns
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "reporters");
    expect(names).toEqual([
      "pattern_id",
      "detector_id",
      "funnel_stage",
      "site",
      "origin_category",
      "rulepack_version",
      "day_bucket",
      "quartile",
      "n",
    ]);
  });

  it("upserts a counter rather than inserting a row per report", async () => {
    // Records would be correlatable later; counters cannot be. The aggregate is the only
    // thing this project ever wanted to hold.
    const { bound, env } = fakeD1();
    await worker.fetch(post({ v: 2, records: [record] }), env);
    const q = bound[0]?.query ?? "";
    expect(q).toMatch(/on conflict/i);
    expect(q).toMatch(/n = n \+ excluded\.n/);
    expect(q).toMatch(/reporters = reporters \+ 1/);
  });

  it("counts ONE reporter per batch, however many identical reports it carries", async () => {
    /**
     * Found against the deployed worker: one batch of 30 identical reports read back as
     * `reporters = 30`, because every record bumped the column. The publication floor
     * releases a shop/technique pair after 20 batches, so one person's one batch cleared it.
     */
    const { bound, env } = fakeD1();
    const res = await worker.fetch(
      post({ v: 2, records: Array.from({ length: 30 }, () => record) }),
      env,
    );
    expect(res.status).toBe(204);
    expect(bound, "30 identical reports must collapse to one write").toHaveLength(1);
    // n carries the 30; reporters is the literal 1 in the SQL, applied once.
    expect(bound[0]?.values.at(-1)).toBe(30);
  });

  it("keeps different cohorts in one batch as separate writes", async () => {
    const { bound, env } = fakeD1();
    await worker.fetch(
      post({ v: 2, records: [record, record, { ...record, site: "temu.com" }] }),
      env,
    );
    expect(bound).toHaveLength(2);
    const bySite = Object.fromEntries(bound.map((b) => [b.values[3], b.values.at(-1)]));
    expect(bySite).toEqual({ "shein.com": 2, "temu.com": 1 });
  });

  it("404s anything that is not /counts", async () => {
    const { env } = fakeD1();
    expect((await worker.fetch(post({ v: 2, records: [record] }, "/"), env)).status).toBe(404);
    expect((await worker.fetch(post({ v: 2, records: [record] }, "/admin"), env)).status).toBe(404);
  });

  it("answers the CORS preflight, because the extension origin is opaque", async () => {
    const { env } = fakeD1();
    const res = await worker.fetch(
      new Request("https://w.example/counts", { method: "OPTIONS" }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // No credentials header: the client sends `credentials: "omit"` and there is no session
    // to protect. Allowing credentials here would create the thing the design avoids.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("still rejects a malformed batch, and writes nothing", async () => {
    // The worker must not become a way around the handler's checks.
    const { bound, env } = fakeD1();
    const res = await worker.fetch(post({ v: 2, records: [{ ...record, path: "/x" }] }), env);
    expect(res.status).toBe(422);
    expect(bound, "a rejected batch reached the database").toEqual([]);
  });
});

describe("cloudflare worker — outcomes", () => {
  it("binds outcome columns in the order the SQL declares, collapsed per cohort", async () => {
    const { bound, env } = fakeD1();
    const o = {
      patternId: "urgency.countdown",
      funnelStage: "pdp",
      site: "shein.com",
      originCategory: "fast_fashion",
      rulepackVersion: "42",
      dayBucket: day,
      addedToCart: false,
    };
    const res = await worker.fetch(post({ v: 3, records: [], outcomes: [o, o, o] }), env);
    expect(res.status).toBe(204);
    const writes = bound.filter((b) => b.query.includes("insert into outcomes"));
    // Three identical outcomes are one cohort: one write, n = 3, reporters + 1.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.values).toEqual([
      "urgency.countdown",
      "pdp",
      "shein.com",
      "fast_fashion",
      "42",
      day,
      0,
      3,
    ]);
    expect(writes[0]?.query).toMatch(
      /\(pattern_id, funnel_stage, site, origin_category, rulepack_version,\s+day_bucket, added_to_cart, n, reporters\)/,
    );
  });
});
