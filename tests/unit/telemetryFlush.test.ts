import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/shared/schema";

/**
 * `flush()` against a queue larger than the server will take in one request.
 *
 * It used to send the whole queue, up to QUEUE_CAP, 5,000 rows, to a server that refuses
 * anything over 500. So once a queue passed 500 (a few days offline was enough), every flush
 * from then on got a 400 and nothing ever drained. These tests fail against that code.
 */

vi.mock("@/shared/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/constants")>()),
  TELEMETRY_ENDPOINT: "https://sink.example/counts",
}));

const day = Math.floor(Date.now() / 86_400_000);
const count = {
  patternId: "scarcity.stock",
  detectorId: "scarcity.stock@1",
  confidenceQuartile: 4,
  funnelStage: "pdp",
  site: "shein.com",
  originCategory: "other",
  rulepackVersion: "1",
  dayBucket: day,
};
const outcome = {
  patternId: "_page",
  funnelStage: "pdp",
  site: "shein.com",
  originCategory: "other",
  rulepackVersion: "1",
  dayBucket: day,
  addedToCart: false,
};

let rows: { id: number; queuedAt: number; record: unknown }[] = [];
vi.mock("@/background/db", () => ({
  getDb: () => ({
    telemetry: {
      orderBy: () => ({
        toArray: async () => [...rows].sort((a, b) => a.queuedAt - b.queuedAt),
      }),
      bulkDelete: async (ids: number[]) => {
        const gone = new Set(ids);
        rows = rows.filter((r) => !gone.has(r.id));
      },
      clear: async () => {
        rows = [];
      },
    },
  }),
}));

const { flush, MAX_SEND } = await import("@/background/telemetry");
const on = { ...DEFAULT_SETTINGS, telemetryConsent: true };

function fill(n: number, record: unknown) {
  rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, queuedAt: i, record }));
}

describe("flush batch size", () => {
  it("never sends more than the server accepts in one request", async () => {
    fill(1200, count);
    const bodies: { records: unknown[]; outcomes: unknown[] }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const r1 = await flush(on, fetchImpl);
    expect(r1).toEqual({ sent: MAX_SEND, held: 1200 - MAX_SEND, reason: "sent" });
    expect(bodies[0]?.records).toHaveLength(MAX_SEND);

    // And it drains over successive alarms instead of sticking.
    await flush(on, fetchImpl);
    await flush(on, fetchImpl);
    expect(rows).toHaveLength(0);
    expect(bodies.map((b) => b.records.length)).toEqual([500, 500, 200]);
  });

  it("sends oldest first, and keeps what it did not send", async () => {
    fill(600, count);
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await flush(on, fetchImpl);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => 501 + i));
  });
});

describe("v3 body", () => {
  it("splits counts and outcomes into their own arrays", async () => {
    rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, queuedAt: i, record: count })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, queuedAt: 50 + i, record: outcome })),
    ];
    let body: { v: number; records: unknown[]; outcomes: unknown[] } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await flush(on, fetchImpl);
    expect(body).not.toBeNull();
    const b = body as unknown as { v: number; records: unknown[]; outcomes: unknown[] };
    expect(b.v).toBe(3);
    expect(b.records).toHaveLength(20);
    expect(b.outcomes).toHaveLength(10);
    expect(b.outcomes[0]).toEqual(outcome);
  });

  it("drops a queued row that is neither shape, rather than sending it", async () => {
    rows = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: i + 1, queuedAt: i, record: count })),
      { id: 999, queuedAt: 100, record: { ...outcome, productId: "abc" } },
    ];
    let wire = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      wire = init.body as string;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await flush(on, fetchImpl);
    expect(wire).not.toContain("productId");
  });
});
