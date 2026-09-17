/**
 * Regression tests for the defects found in the code audit — one describe per defect, each
 * written to fail against the code as it was.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildDigest } from "@/background/digest";
import { bnplDetector } from "@/content/detectors/bnpl";
import { confirmshamingDetector } from "@/content/detectors/confirmshaming";
import { defaultsDetector } from "@/content/detectors/defaults";
import { interferenceDetector } from "@/content/detectors/interference";
import { urgencyDetector } from "@/content/detectors/urgency";
import { harvest } from "@/content/harvest";
import { watchInteractions } from "@/content/interactions";
import { PageObserver } from "@/content/observer";
import { TriggerWatcher } from "@/content/triggers";
import { addonKeysOf } from "@/shared/addons";
import { registrableDomain } from "@/shared/domain";
import type { DetectionCandidate } from "@/shared/schema";
import { contextFrom } from "./helpers";

const detects = (
  detector: { run: typeof bnplDetector.run },
  html: string,
  stage: "pdp" | "cart" | "checkout" = "pdp",
) => detector.run(contextFrom(html, { stage }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("event rows describe their own candidate (session.ts misattribution)", () => {
  it("gives each decision the index of the input it came from", () => {
    const cand = (text: string, score: number): DetectionCandidate => ({
      detectorId: "scarcity.stock@1",
      patternId: "scarcity.stock",
      rawScore: score,
      subSignals: {},
      evidence: {
        selectorPath: `#${text.length}`,
        textHash: "a".repeat(64),
        textSample: text,
        matchedLexemes: [],
        boundingBox: { x: 0, y: 0, w: 1, h: 1 },
      },
      nodeRef: `#${text.length}`,
    });
    const inputs = [
      { candidate: cand("Only 3 left", 0.9), visibleMs: 2000, passedGate: true },
      { candidate: cand("Low stock in your size", 0.8), visibleMs: 2000, passedGate: true },
      { candidate: cand("While supplies last", 0.4), visibleMs: 2000, passedGate: true },
    ];
    const { decisions } = buildDigest(inputs, {
      surfaceThreshold: 0.75,
      disabledDetectors: new Set(),
    });

    // One decision per input, and every input index appears exactly once.
    expect(decisions.map((d) => d.inputIndex).sort()).toEqual([0, 1, 2]);
    // The shown one is the highest-ranked, not merely the first with that pattern id.
    expect(decisions.find((d) => d.surfaced)?.inputIndex).toBe(0);
  });
});

describe("defaults.preselected only reports what the page chose", () => {
  it("does not report a box the shopper ticked themselves", () => {
    document.body.innerHTML = `<label><input type="checkbox" id="w"> Add 2-year protection plan $19.99</label>`;
    const stop = watchInteractions(() => {});
    (document.getElementById("w") as HTMLInputElement).click(); // a real user event in jsdom
    const node = harvest(document).find((n) => n.tagName === "INPUT");
    stop();
    expect(node?.attrs.checked).toBe("true");
    expect(node?.attrs.userTouched).toBe("true");
  });

  it("does not mark a box the PAGE ticked in script as touched", () => {
    document.body.innerHTML = `<label><input type="checkbox" id="w"> Add protection plan</label>`;
    const stop = watchInteractions(() => {});
    (document.getElementById("w") as HTMLInputElement).checked = true; // no change event
    const node = harvest(document).find((n) => n.tagName === "INPUT");
    stop();
    expect(node?.attrs.userTouched).toBeUndefined();
  });

  it("does not read 'multiple' as a tip", () => {
    const hits = detects(
      defaultsDetector,
      `<label><input type="checkbox" checked> Ship to multiple addresses</label>`,
      "checkout",
    );
    expect(hits).toEqual([]);
  });

  it("does not flag the cheapest radio in its group", () => {
    const hits = detects(
      defaultsDetector,
      `<div><label><input type="radio" name="ship" checked> Standard shipping Free</label></div>
       <div><label><input type="radio" name="ship"> Express shipping $15.00</label></div>`,
      "checkout",
    );
    expect(hits).toEqual([]);
  });

  it("DOES flag a preselected dearer radio", () => {
    const hits = detects(
      defaultsDetector,
      `<div><label><input type="radio" name="ship"> Standard shipping Free</label></div>
       <div><label><input type="radio" name="ship" checked> Express shipping $15.00</label></div>`,
      "checkout",
    );
    expect(hits.length).toBe(1);
  });
});

describe("add-on choices are recorded from real interactions", () => {
  it("reports opting in and back out, by family key", () => {
    document.body.innerHTML = `<label><input type="checkbox" id="g"> Add gift wrap ($5)</label>`;
    const seen: { key: string; selected: boolean }[] = [];
    const stop = watchInteractions((c) => seen.push(...c));
    const box = document.getElementById("g") as HTMLInputElement;
    box.click();
    box.click();
    stop();
    expect(seen).toEqual([
      { key: "gift_wrap", selected: true },
      { key: "gift_wrap", selected: false },
    ]);
  });

  it("uses one definition of add-on everywhere", () => {
    expect(addonKeysOf("Accident Protection Plan")).toEqual(["protection"]);
    expect(addonKeysOf("Ship to multiple addresses")).toEqual([]);
  });
});

describe("add-to-cart attribute matching uses whole tokens", () => {
  const fired = (attrs: string, label = "Go"): boolean => {
    document.body.innerHTML = `<button ${attrs}>${label}</button>`;
    let hit = false;
    const w = new TriggerWatcher(
      () => {
        hit = true;
      },
      () => "pdp",
    );
    const detach = w.attach(document);
    document.querySelector("button")?.click();
    detach();
    return hit;
  };

  it("ignores ids that merely contain the letters a-t-c", () => {
    for (const id of ["watch-video", "match-card", "batch-select", "catch-all", "patch-notes"]) {
      expect(fired(`id="${id}"`), id).toBe(false);
    }
  });

  it("still recognises real add-to-cart attributes", () => {
    for (const attr of [
      'id="add-to-cart"',
      'data-testid="AddToCart"',
      'name="atc"',
      'id="btn-atc"',
    ]) {
      expect(fired(attr), attr).toBe(true);
    }
  });
});

describe("bnpl separates financing from subscriptions and hotels", () => {
  it("does not treat a subscription plan price as installments", () => {
    expect(detects(bnplDetector, `<p>Premium plans from $9.99/mo, cancel anytime</p>`)).toEqual([]);
  });

  it("does not treat 'Book now, pay later' at a hotel as BNPL", () => {
    expect(detects(bnplDetector, `<p>Book now, pay later</p>`)).toEqual([]);
  });

  it("does not read a zip code as the Zip provider", () => {
    const hits = detects(bnplDetector, `<p>Pay in 4 — enter your zip code</p>`);
    expect(hits[0]?.subSignals.providerNamed).toBe(0);
  });

  it("still catches device financing with no provider named", () => {
    expect(
      detects(bnplDetector, `<p>Get the Apple Watch SE 3 starting at $24/mo.</p>`).length,
    ).toBeGreaterThan(0);
  });
});

describe("urgency needs a real deadline", () => {
  const score = (text: string) =>
    Math.max(0, ...detects(urgencyDetector, `<p>${text}</p>`).map((c) => c.rawScore));

  it("does not read steps or installments as a 'through' date", () => {
    expect(score("Walk through 3 easy steps to order")).toBe(0);
    expect(score("Pay through 4 installments")).toBe(0);
  });

  it("does not read a recurring event as a deadline", () => {
    expect(score("Our event runs weekly")).toBe(0);
  });

  it("still reads a dated run", () => {
    expect(score("Event runs 9/20–10/3. Exclusions apply.")).toBeGreaterThan(0);
  });
});

describe("confirmshaming is about declines, not calls to action", () => {
  it("does not flag a 'Don't miss out' shopping button", () => {
    expect(detects(confirmshamingDetector, `<button>Don't miss out, shop now</button>`)).toEqual(
      [],
    );
  });

  it("still flags a first-person miss-out decline", () => {
    expect(
      detects(confirmshamingDetector, `<button>No thanks, I'll miss out</button>`).length,
    ).toBeGreaterThan(0);
  });
});

describe("interference is about consent prompts, not purchase buttons", () => {
  it("does not flag Add to bag beside a Close link", () => {
    const ctx = contextFrom(
      `<div class="qv"><button id="a">Add to bag</button><button id="c">Close</button></div>`,
      {
        patch: (n, el) => {
          if (el?.id === "a") (n as { box: typeof n.box }).box = { x: 0, y: 0, w: 300, h: 50 };
          if (el?.id === "c") (n as { box: typeof n.box }).box = { x: 0, y: 60, w: 40, h: 16 };
        },
      },
    );
    expect(interferenceDetector.run(ctx)).toEqual([]);
  });
});

describe("registrableDomain uses the Public Suffix List", () => {
  it("keeps country second-level shops distinct", () => {
    expect(registrableDomain("www.jumia.com.ng")).toBe("jumia.com.ng");
    expect(registrableDomain("noon.com.sa")).toBe("noon.com.sa");
  });

  it("keeps each hosted store its own site", () => {
    expect(registrableDomain("cool-shop.myshopify.com")).toBe("cool-shop.myshopify.com");
    expect(registrableDomain("other-shop.myshopify.com")).toBe("other-shop.myshopify.com");
  });

  it("still merges ordinary subdomains", () => {
    expect(registrableDomain("us.shein.com")).toBe("shein.com");
    expect(registrableDomain("secure.checkout.booking.com")).toBe("booking.com");
  });
});

describe("the observer holds no page text until the page is a shop", () => {
  it("records nothing while not recording", async () => {
    document.body.innerHTML = `<div id="t">Order in 02:14:09</div>`;
    const o = new PageObserver(() => {});
    o.start(document.body);
    // A ticking timer rewrites its text node in place (characterData), which is what is tracked.
    const text = (document.getElementById("t") as HTMLElement).firstChild as Text;
    text.data = "Order in 02:14:08";
    await new Promise((r) => setTimeout(r, 0));
    expect(o.state.textHistories.size).toBe(0);
    o.startRecording();
    text.data = "Order in 02:14:07";
    await new Promise((r) => setTimeout(r, 0));
    expect(o.state.textHistories.size).toBeGreaterThan(0);
    o.stop();
  });
});
