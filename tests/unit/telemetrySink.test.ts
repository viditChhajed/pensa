import { describe, expect, it } from "vitest";
import { type CountRow, handle, type OutcomeRow } from "../../server/handler";

/**
 * The sink's job is to disbelieve its client.
 *
 * Every limit here is one the extension already applies before sending. That duplication is
 * the whole point: the endpoint is a public URL, so the guarantees PRIVACY.md makes have to
 * hold against a modified extension, a curl command, or anyone who reads the source after
 * the repo goes public. A server that trusts its client is not enforcing anything.
 */

function fakeStore() {
  const rows: CountRow[] = [];
  const outcomes: OutcomeRow[] = [];
  return {
    rows,
    outcomes,
    store: {
      increment: async (r: CountRow[]) => {
        rows.push(...r);
      },
      incrementOutcomes: async (r: OutcomeRow[]) => {
        outcomes.push(...r);
      },
    },
  };
}

const day = Math.floor(Date.now() / 86_400_000);

const valid = () => ({
  patternId: "scarcity.stock",
  detectorId: "scarcity.stock@1",
  confidenceQuartile: 4,
  funnelStage: "pdp",
  site: "booking.com",
  originCategory: "ota_travel",
  rulepackVersion: "1",
  dayBucket: day,
});

const post = (body: unknown) =>
  new Request("https://sink.example/api/counts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("telemetry sink", () => {
  it("accepts a well-formed batch and stores counters", async () => {
    const { rows, store } = fakeStore();
    const res = await handle(post({ v: 2, records: [valid(), valid()] }), store);
    expect(res.status).toBe(204);
    expect(rows).toHaveLength(2);
  });

  it("returns no body, so the response cannot be used as a channel", async () => {
    const { store } = fakeStore();
    const res = await handle(post({ v: 2, records: [valid()] }), store);
    // Not even a count of accepted rows: that would let a caller probe the store one record
    // at a time to learn what it already holds.
    expect(await res.text()).toBe("");
  });

  it("REJECTS a record carrying an extra field", async () => {
    // The one that matters most. TelemetryRecord is .strict() on the client so an
    // accidentally added field throws rather than travelling; that control is worth nothing
    // if the receiving end shrugs at it.
    const { rows, store } = fakeStore();
    const res = await handle(post({ v: 2, records: [{ ...valid(), path: "/hotel/123" }] }), store);
    expect(res.status).toBe(422);
    expect(rows, "a record with an extra field reached the store").toEqual([]);
  });

  it("rejects the whole batch if any record is malformed", async () => {
    // A batch with one bad record came from something that is not the shipped extension, and
    // keeping the rest of it means accepting data from an unknown sender.
    const { rows, store } = fakeStore();
    const res = await handle(
      post({ v: 2, records: [valid(), { ...valid(), funnelStage: "made_up" }, valid()] }),
      store,
    );
    expect(res.status).toBe(422);
    expect(rows).toEqual([]);
  });

  it("rejects an unknown site category", async () => {
    const { store } = fakeStore();
    const res = await handle(post({ v: 2, records: [{ ...valid(), originCategory: "x" }] }), store);
    expect(res.status).toBe(422);
  });

  it("rejects a day bucket outside the plausible window", async () => {
    // A far-future or ancient bucket is a wrong clock or an invented body; either way it
    // would pollute the aggregate with something that never happened.
    const { store } = fakeStore();
    expect(
      (await handle(post({ v: 2, records: [{ ...valid(), dayBucket: day + 9999 }] }), store))
        .status,
    ).toBe(422);
    expect(
      (await handle(post({ v: 2, records: [{ ...valid(), dayBucket: 0 }] }), store)).status,
    ).toBe(422);
  });

  it("REJECTS an hour bucket, so a v1-shaped record cannot sneak in under v2", async () => {
    const { store } = fakeStore();
    const { dayBucket: _d, ...rest } = valid();
    const res = await handle(post({ v: 2, records: [{ ...rest, hourBucket: day * 24 }] }), store);
    expect(res.status).toBe(422);
  });

  it("accepts only a bare domain in `site` — never a URL, a path or a port", async () => {
    // `site` is the one free-text-shaped column, so it is the one place a modified client
    // could try to smuggle a URL, a query string or an identifier into the dataset.
    const { rows, store } = fakeStore();
    for (const bad of [
      "https://booking.com",
      "booking.com/hotel/123",
      "booking.com:443",
      "user@booking.com",
      "booking",
      "BOOKING.COM",
      "booking.com?session=abc",
      "",
    ]) {
      const res = await handle(post({ v: 2, records: [{ ...valid(), site: bad }] }), store);
      expect(res.status, `accepted site=${JSON.stringify(bad)}`).toBe(422);
    }
    expect(rows).toEqual([]);
  });

  it("stores the site it was given", async () => {
    const { rows, store } = fakeStore();
    await handle(post({ v: 2, records: [{ ...valid(), site: "shein.com" }] }), store);
    expect(rows[0]?.site).toBe("shein.com");
  });

  it("rejects a confidence score in place of a quartile", async () => {
    // Sending 0.83 instead of 4 would be a precision leak, and it is exactly the shape a
    // careless change to the client would produce.
    const { store } = fakeStore();
    const res = await handle(
      post({ v: 2, records: [{ ...valid(), confidenceQuartile: 0.83 }] }),
      store,
    );
    expect(res.status).toBe(422);
  });

  it("rejects oversized, empty and non-array batches", async () => {
    const { store } = fakeStore();
    expect((await handle(post({ v: 2, records: [] }), store)).status).toBe(400);
    expect((await handle(post({ v: 2, records: {} }), store)).status).toBe(400);
    const huge = Array.from({ length: 501 }, valid);
    expect((await handle(post({ v: 2, records: huge }), store)).status).toBe(400);
  });

  it("rejects an unknown or retired protocol version", async () => {
    // v1 carried an hour and no site. Refusing it outright means an old build cannot keep
    // writing a different shape into columns that now mean something else.
    const { store } = fakeStore();
    expect((await handle(post({ v: 1, records: [valid()] }), store)).status).toBe(400);
    expect((await handle(post({ v: 4, records: [valid()] }), store)).status).toBe(400);
  });

  it("rejects anything that is not a POST of JSON", async () => {
    const { store } = fakeStore();
    const get = new Request("https://sink.example/api/counts");
    expect((await handle(get, store)).status).toBe(405);

    const form = new Request("https://sink.example/api/counts", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect((await handle(form, store)).status).toBe(415);
  });

  it("never reads a header other than content-type", async () => {
    // The IP is the re-identifier: an address beside a site and a day is a person. The
    // handler must not touch request headers for anything else, so a proxy adding
    // x-forwarded-for cannot become a key by accident.
    const source = (await import("node:fs")).readFileSync("server/handler.ts", "utf8");
    const headerReads = [...source.matchAll(/headers\.get\(\s*["'`]([^"'`]+)/g)].map((m) => m[1]);
    expect(headerReads, `handler reads headers: ${headerReads.join(", ")}`).toEqual([
      "content-type",
    ]);
  });
});

const outcome = () => ({
  patternId: "urgency.countdown",
  funnelStage: "pdp",
  site: "shein.com",
  originCategory: "fast_fashion",
  rulepackVersion: "1",
  dayBucket: day,
  addedToCart: true,
});

describe("telemetry sink — v3 page-view outcomes", () => {
  it("accepts counts and outcomes together, and stores each in its own place", async () => {
    const { rows, outcomes, store } = fakeStore();
    const res = await handle(
      post({
        v: 3,
        records: [valid()],
        outcomes: [outcome(), { ...outcome(), patternId: "_page" }],
      }),
      store,
    );
    expect(res.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(outcomes.map((o) => o.patternId)).toEqual(["urgency.countdown", "_page"]);
  });

  it("accepts a v3 batch with only outcomes, or only counts", async () => {
    const { store } = fakeStore();
    expect((await handle(post({ v: 3, records: [], outcomes: [outcome()] }), store)).status).toBe(
      204,
    );
    expect((await handle(post({ v: 3, records: [valid()], outcomes: [] }), store)).status).toBe(
      204,
    );
    expect((await handle(post({ v: 3, records: [], outcomes: [] }), store)).status).toBe(400);
  });

  it("REJECTS an outcome carrying an extra field — a product, a path, a price", async () => {
    const { outcomes, store } = fakeStore();
    for (const extra of [
      { path: "/p/1" },
      { productId: "123" },
      { price: 49.99 },
      { ts: Date.now() },
    ]) {
      const res = await handle(
        post({ v: 3, records: [], outcomes: [{ ...outcome(), ...extra }] }),
        store,
      );
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(outcomes).toEqual([]);
  });

  it("rejects outcomes at stages where adding to cart is not the decision", async () => {
    const { store } = fakeStore();
    for (const funnelStage of ["cart", "checkout", "payment", "x"]) {
      const res = await handle(
        post({ v: 3, records: [], outcomes: [{ ...outcome(), funnelStage }] }),
        store,
      );
      expect(res.status, funnelStage).toBe(422);
    }
  });

  it("rejects a pattern id that is not shaped like one", async () => {
    const { store } = fakeStore();
    for (const patternId of ["https://x.com", "a.b.c", "_PAGE", "", "x".repeat(80)]) {
      const res = await handle(
        post({ v: 3, records: [], outcomes: [{ ...outcome(), patternId }] }),
        store,
      );
      expect(res.status, patternId).toBe(422);
    }
  });

  it("rejects a non-boolean outcome", async () => {
    const { store } = fakeStore();
    const res = await handle(
      post({ v: 3, records: [], outcomes: [{ ...outcome(), addedToCart: 1 }] }),
      store,
    );
    expect(res.status).toBe(422);
  });

  it("refuses outcomes under v2", async () => {
    const { store } = fakeStore();
    const res = await handle(post({ v: 2, records: [valid()], outcomes: [outcome()] }), store);
    expect(res.status).toBe(400);
  });

  it("applies the 500 limit to counts and outcomes together", async () => {
    const { store } = fakeStore();
    const res = await handle(
      post({
        v: 3,
        records: Array.from({ length: 300 }, valid),
        outcomes: Array.from({ length: 201 }, outcome),
      }),
      store,
    );
    expect(res.status).toBe(400);
  });
});
