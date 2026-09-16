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

const hour = Math.floor(Date.now() / 3_600_000);

const record = {
  patternId: "scarcity.stock",
  detectorId: "scarcity.stock@1",
  confidenceQuartile: 4,
  funnelStage: "pdp",
  originCategory: "ota_travel",
  rulepackVersion: "42",
  hourBucket: hour,
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
    const res = await worker.fetch(post({ v: 1, records: [record] }), env);
    expect(res.status).toBe(204);
    expect(bound).toHaveLength(1);

    // Positional and silent when wrong: a swap writes a pattern id into the detector column,
    // the insert succeeds, and the aggregate is quietly corrupt for the life of the table.
    expect(bound[0]?.values).toEqual([
      "scarcity.stock",
      "scarcity.stock@1",
      "pdp",
      "ota_travel",
      "42",
      hour,
      4,
    ]);

    // And the order must match the column list in the statement itself, not just my memory
    // of it. Parsed from the query so the two cannot drift apart.
    const columns = /insert into counts \(([\s\S]*?)\)/.exec(bound[0]?.query ?? "")?.[1] ?? "";
    const names = columns
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "n" && c !== "reporters");
    expect(names).toEqual([
      "pattern_id",
      "detector_id",
      "funnel_stage",
      "origin_category",
      "rulepack_version",
      "hour_bucket",
      "quartile",
    ]);
  });

  it("upserts a counter rather than inserting a row per report", async () => {
    // Records would be correlatable later; counters cannot be. The aggregate is the only
    // thing this project ever wanted to hold.
    const { bound, env } = fakeD1();
    await worker.fetch(post({ v: 1, records: [record] }), env);
    const q = bound[0]?.query ?? "";
    expect(q).toMatch(/on conflict/i);
    expect(q).toMatch(/n = n \+ 1/);
    expect(q).toMatch(/reporters = reporters \+ 1/);
  });

  it("404s anything that is not /counts", async () => {
    const { env } = fakeD1();
    expect((await worker.fetch(post({ v: 1, records: [record] }, "/"), env)).status).toBe(404);
    expect((await worker.fetch(post({ v: 1, records: [record] }, "/admin"), env)).status).toBe(404);
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
    const res = await worker.fetch(post({ v: 1, records: [{ ...record, origin: "x.com" }] }), env);
    expect(res.status).toBe(422);
    expect(bound, "a rejected batch reached the database").toEqual([]);
  });
});
