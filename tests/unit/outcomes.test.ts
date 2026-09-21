import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutcomeRecord, Settings } from "@/shared/schema";
import { DEFAULT_SETTINGS, OutcomeRecord as OutcomeSchema } from "@/shared/schema";

/**
 * The add-to-cart outcome measure (src/background/outcomes.ts).
 *
 * What these pin down, in order of how badly each would corrupt the dataset if it broke:
 * nothing is held or sent without consent; exposure is frozen at the click; every view counts
 * toward the baseline whether it showed anything or not; abandoned views end as non-adds
 * rather than vanishing (which would inflate every rate); and a page cannot smuggle an
 * arbitrary string into a record.
 */

const queued: OutcomeRecord[] = [];

vi.mock("@/background/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/background/telemetry")>();
  return {
    ...real,
    enqueueOutcomes: async (records: OutcomeRecord[], settings: Settings) => {
      if (!settings.telemetryConsent) return 0;
      // The real function re-parses; so does this, so a malformed row fails the test.
      for (const r of records) queued.push(OutcomeSchema.parse(r));
      return records.length;
    },
  };
});

const { notePageView, sweepViews, discardViews, VIEW_IDLE_MS, MAX_OPEN_VIEWS } = await import(
  "@/background/outcomes"
);

let store: Record<string, unknown> = {};
beforeEach(() => {
  store = {};
  queued.length = 0;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (k: string) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (o: Record<string, unknown>) => Object.assign(store, structuredClone(o)),
        remove: async (k: string) => {
          delete store[k];
        },
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const on: Settings = { ...DEFAULT_SETTINGS, telemetryConsent: true };
const T0 = 1_760_000_000_000;

const view = (over: Partial<Parameters<typeof notePageView>[0]> = {}) => ({
  type: "pageview" as const,
  viewId: "abc123def456",
  origin: "https://www.shein.com",
  stage: "pdp" as const,
  exposed: [] as string[],
  addedToCart: false,
  ...over,
});

describe("consent", () => {
  it("holds nothing and sends nothing while sharing is off", async () => {
    await notePageView(view({ exposed: ["scarcity.stock"], addedToCart: true }), DEFAULT_SETTINGS);
    expect(queued).toEqual([]);
    expect(store).toEqual({});
  });

  it("drops open views when sharing is switched off, rather than sending them later", async () => {
    await notePageView(view({ exposed: ["scarcity.stock"] }), on, T0);
    expect(Object.keys(store)).toHaveLength(1);
    await sweepViews(DEFAULT_SETTINGS, T0 + VIEW_IDLE_MS * 2);
    expect(queued).toEqual([]);
    expect(store).toEqual({});
  });
});

describe("a page view that ends in an add", () => {
  it("sends one baseline row plus one row per technique seen before the click", async () => {
    await notePageView(view({ exposed: ["scarcity.stock"] }), on, T0);
    await notePageView(view({ exposed: ["scarcity.stock", "urgency.countdown"] }), on, T0 + 5_000);
    expect(queued).toEqual([]); // not ended yet
    await notePageView(
      view({ exposed: ["scarcity.stock", "urgency.countdown"], addedToCart: true }),
      on,
      T0 + 9_000,
    );

    expect(queued.map((r) => r.patternId).sort()).toEqual([
      "_page",
      "scarcity.stock",
      "urgency.countdown",
    ]);
    for (const r of queued) {
      expect(r.addedToCart).toBe(true);
      expect(r.site).toBe("shein.com"); // registrable domain, never the host
      expect(r.funnelStage).toBe("pdp");
      expect(r.dayBucket).toBe(Math.floor(T0 / 86_400_000));
    }
    expect(store["pensa:views"]).toEqual({}); // ended, not held
  });

  it("carries exactly seven fields, none of them about the item", async () => {
    await notePageView(view({ exposed: ["pricing.charm"], addedToCart: true }), on, T0);
    expect(Object.keys(queued[0] ?? {}).sort()).toEqual([
      "addedToCart",
      "dayBucket",
      "funnelStage",
      "originCategory",
      "patternId",
      "rulepackVersion",
      "site",
    ]);
  });
});

describe("the baseline", () => {
  it("counts a view that showed nothing, so rates have a denominator", async () => {
    await notePageView(view({ exposed: [], addedToCart: true }), on, T0);
    expect(queued.map((r) => r.patternId)).toEqual(["_page"]);
  });
});

describe("views that end without an add", () => {
  it("are ended by the sweep as non-adds, not silently dropped", async () => {
    await notePageView(view({ exposed: ["bnpl.installments"] }), on, T0);
    await sweepViews(on, T0 + VIEW_IDLE_MS - 1);
    expect(queued).toEqual([]); // not idle yet
    await sweepViews(on, T0 + VIEW_IDLE_MS + 1);
    expect(queued.map((r) => [r.patternId, r.addedToCart])).toEqual([
      ["_page", false],
      ["bnpl.installments", false],
    ]);
  });

  it("are ended when a new message arrives after they went idle", async () => {
    await notePageView(view({ viewId: "old000000000" }), on, T0);
    await notePageView(view({ viewId: "new000000000" }), on, T0 + VIEW_IDLE_MS + 1);
    expect(queued.map((r) => r.addedToCart)).toEqual([false]);
  });

  it("are capped, with the oldest ended as a non-add rather than lost", async () => {
    for (let i = 0; i <= MAX_OPEN_VIEWS; i++) {
      await notePageView(view({ viewId: `v${String(i).padStart(11, "0")}` }), on, T0 + i);
    }
    expect(Object.keys(store["pensa:views"] as object)).toHaveLength(MAX_OPEN_VIEWS);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.addedToCart).toBe(false);
  });
});

describe("what a page can put in a record", () => {
  it("keeps only real technique ids", async () => {
    await notePageView(
      view({
        exposed: ["scarcity.stock", "evil.<script>", "https://x.com/p/1"],
        addedToCart: true,
      }),
      on,
      T0,
    );
    expect(queued.map((r) => r.patternId).sort()).toEqual(["_page", "scarcity.stock"]);
  });

  it("drops techniques the shopper switched off", async () => {
    await notePageView(
      view({ exposed: ["scarcity.stock", "pricing.charm"], addedToCart: true }),
      { ...on, disabledDetectors: ["pricing.charm"] },
      T0,
    );
    expect(queued.map((r) => r.patternId).sort()).toEqual(["_page", "scarcity.stock"]);
  });

  it("names nothing for an http page", async () => {
    await notePageView(view({ origin: "http://shop.example.com", addedToCart: true }), on, T0);
    expect(queued).toEqual([]);
  });

  it("keeps the stage of the first message for the view", async () => {
    await notePageView(view({ stage: "browse" }), on, T0);
    await notePageView(view({ stage: "pdp", addedToCart: true }), on, T0 + 1);
    expect(queued[0]?.funnelStage).toBe("browse");
  });
});

describe("concurrency", () => {
  it("does not lose a view when two tabs report at the same moment", async () => {
    await Promise.all([
      notePageView(view({ viewId: "tab100000000" }), on, T0),
      notePageView(view({ viewId: "tab200000000" }), on, T0),
    ]);
    expect(Object.keys(store["pensa:views"] as object).sort()).toEqual([
      "tab100000000",
      "tab200000000",
    ]);
  });
});

describe("clear-all-data", () => {
  it("forgets open views", async () => {
    await notePageView(view(), on, T0);
    await discardViews();
    expect(store).toEqual({});
  });
});
