import { describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { contextFrom } from "./helpers";

/**
 * Adjudication of the live precision audit, for `urgency.countdown` and `scarcity.stock`.
 *
 * `npm run spot:check` drove the extension over 22 real retailers and recorded every claim it
 * made. `corpus/adjudication.md` is that list, read one claim at a time. These are the ones
 * that were wrong — the strings, verbatim — and the ones that were right and must survive the
 * fix, because a precision fix that quietly costs recall is not a fix, it is a trade nobody
 * agreed to.
 *
 * `tests/unit/falsePositives.test.ts` holds the same kind of evidence for the structural
 * detectors. Kept separate only to stay out of each other's way.
 */

const LOG_THRESHOLD = 0.35;
const SURFACE_THRESHOLD = 0.75;

const claimsOn = (html: string, patternId: string) => {
  const ctx = contextFrom(html, { stage: "browse" });
  return DETECTORS.flatMap((d) => d.run(ctx)).filter((h) => h.patternId === patternId);
};

const score = (text: string, patternId: string): number =>
  Math.max(0, ...claimsOn(`<div class="promo">${text}</div>`, patternId).map((h) => h.rawScore));

describe("urgency.countdown does not read a product title as a deadline", () => {
  /**
   * All six are the exact strings the audit caught, truncated at 60 characters by the
   * reporting script, which is how they appear in `corpus/adjudication.md`.
   *
   * The Eventbrite pair is the diagnosis worth keeping: they are the accessible names of the
   * Save and Share buttons on an event card, and they matched `event: nyc grocery run` —
   * "event" plus the optional-plural `runs?` picking up a NOUN fourteen characters later.
   * Nothing about a deadline appears in either string.
   *
   * The Newegg one never matched on the text shown here at all, which is worth saying plainly
   * rather than letting this case look like it proves something it does not: the firing came
   * from the whole tile, whose joined text ends with the promo badge. The reproduction for the
   * real defect is the structural case below; this asserts the title alone stays silent, which
   * is the part a lexicon change could break.
   */
  const SILENT = [
    "Save this event: NYC Grocery Run with Rainforest Distribution",
    "Share this event: NYC Grocery Run with Rainforest Distribution",
    "GY-BNO085 9DOF Nine-Axis AHRS IMU Sensor Module, High Precision Attitude Sensor",
  ];
  for (const text of SILENT) {
    it(`stays silent on ${JSON.stringify(text.slice(0, 48))}`, () => {
      expect(score(text, "urgency.countdown")).toBeLessThan(LOG_THRESHOLD);
    });
  }

  /**
   * The point of the fix, rather than of the six strings.
   *
   * A rule that only knew about "Save this event" would be back next week on "Save this
   * listing", and the site does not have to be Eventbrite for "run" to be a noun.
   */
  const SILENT_TOO = [
    "Save this listing: Sunday Long Run Club",
    "Share this deal: Spring Trail Run Series",
    "Shop the Trail Run Collection",
    "Print Run: 500 numbered copies",
  ];
  for (const text of SILENT_TOO) {
    it(`generalises, and stays silent on ${JSON.stringify(text)}`, () => {
      expect(score(text, "urgency.countdown")).toBeLessThan(LOG_THRESHOLD);
    });
  }

  /**
   * Every deadline the audit judged CORRECT. These are the whole reason the detector exists
   * and none of them may be traded for the six above.
   */
  const FIRES = [
    "Limited time offer, ends 09/21",
    "Limited time offer, ends 10/09",
    "Limited time offer, ends 09/17",
    "Limited time offer, ends 09/19",
    "Limited time offer, ends 09/20",
    "Sales end soon",
    "Ends 9/17/26",
    "Ends 9/16/26",
    "2 Days Left",
    "Event runs 9/20–10/3. Exclusions apply.",
    "Get away for less with Late Escape Deals. Book by Jan 7, 2027",
    "Venture Limited-Time Offer",
    "Free same day delivery over $35. Now thru 9.17.",
  ];
  for (const text of FIRES) {
    it(`still fires on ${JSON.stringify(text)}`, () => {
      expect(score(text, "urgency.countdown")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
    });
  }

  /**
   * The three REI firings, adjudicated as CORRECT and left alone.
   *
   * They looked like a membership pitch with no deadline in them, and the 60-character
   * truncation is why. The corpus holds the same banner in full — `corpus/labels.jsonl`, where
   * it is labelled a positive — and it ends "…when you spend $50+, thru 11/12. Terms apply."
   * That is a dated deadline on a membership offer, matched by the `thru <date>` rule, and it
   * is exactly what this detector is for. No change was made for these.
   */
  it("keeps the REI member-offer banner, which does carry a deadline", () => {
    const rei =
      "message 2 of 3. Become an REI Co-op Member and earn a $30 single-use promo card " +
      "when you spend $50+, thru 11/12. Terms apply. Join now";
    expect(score(rei, "urgency.countdown")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
  });
});

describe("urgency.countdown claims a deadline once, and quotes the deadline", () => {
  it("does not report a Newegg tile and its own promo badge as two claims", () => {
    /**
     * The audit's Newegg firing, reconstructed: the promo badge lives INSIDE the tile's
     * anchor, so the anchor's joined text carries the deadline too and both matched. The
     * anchor's claim was evidenced with the part number it happens to start with, which is
     * what "GY-BNO085 9DOF Nine-Axis AHRS IMU Sensor Module…" is doing in a list of countdowns.
     */
    const hits = claimsOn(
      `<div class="cell"><a href="/p/x">` +
        `<span class="t">GY-BNO085 9DOF Nine-Axis AHRS IMU Sensor Module, High Precision</span>` +
        `<span class="promo">Limited time offer, ends 10/09</span></a></div>`,
      "urgency.countdown",
    );

    expect(hits.length, "one promo badge produced more than one claim").toBe(1);
    const quoted = hits[0]?.evidence.textSample ?? "";
    expect(quoted, `evidence quoted the product title: ${quoted}`).not.toMatch(/BNO085/);
    expect(quoted).toContain("ends 10/09");
  });

  it("does not report Ulta's shipping line twice, once per nesting level", () => {
    // "Same dayFree same day delivery over $35. Now thru 9.17." and "Free same day delivery
    // over $35. Now thru 9.17." were separate claims in the audit, 14 times each, for one line.
    const hits = claimsOn(
      `<a class="ship" href="/x">Same day ` +
        `<span class="copy">Free same day delivery over $35. Now thru 9.17.</span></a>`,
      "urgency.countdown",
    );

    expect(hits.length).toBe(1);
    expect(hits[0]?.evidence.textSample).toBe("Free same day delivery over $35. Now thru 9.17.");
  });

  it("quotes the sentence carrying the deadline when a block holds several", () => {
    const text =
      "Save on everything for the season with our biggest promotion of the year. " +
      "Event runs 9/20-10/3. Exclusions apply.";
    const hits = claimsOn(`<div class="promo">${text}</div>`, "urgency.countdown");
    expect(hits.length).toBe(1);
    expect(hits[0]?.evidence.textSample).toBe("Event runs 9/20-10/3.");
  });

  it("quotes the whole node when the site writes a tile with no punctuation", () => {
    // The limit of the sentence trick, asserted rather than hoped for: with nothing to split
    // on, the quote is still the blob. Dedupe is what saves the real pages; this is the
    // residue when a deadline is glued to a title inside ONE element.
    const hits = claimsOn(
      `<div class="tile">Wireless Doorbell Camera 2K Battery Powered Limited time offer, ends 10/09</div>`,
      "urgency.countdown",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.evidence.textSample).toMatch(/^Wireless Doorbell/);
  });
});

describe("scarcity.stock does not read a catalogue dump as a stock claim", () => {
  it("stays silent on a Zappos tile description", () => {
    const text =
      "brand name birkenstock product name birki flow eva clog gender unisex color khaki";
    expect(score(text, "scarcity.stock")).toBeLessThan(LOG_THRESHOLD);
  });

  it("claims a Zappos tile's Low Stock badge once, and quotes the badge", () => {
    /**
     * The audit's only scarcity false positive, reconstructed. Note it is also the only
     * scarcity firing with NO lexeme tag — the tell that it came from the container pass,
     * which matches the parent's joined text but tags lexemes from the node's own.
     */
    const hits = claimsOn(
      `<div class="tile">` +
        `<span class="a11y">brand name birkenstock product name birki flow eva clog ` +
        `gender unisex color khaki price $59.95</span>` +
        `<span class="badge">Low Stock</span></div>`,
      "scarcity.stock",
    );

    expect(hits.length, "one Low Stock badge produced more than one claim").toBe(1);
    const quoted = hits[0]?.evidence.textSample ?? "";
    expect(quoted, `evidence quoted the catalogue text: ${quoted}`).not.toMatch(/brand name/);
    expect(quoted).toContain("Low Stock");
  });

  const FIRES = [
    "Low Stock",
    "HOKA - Cielo X1 2.0. Color Black/Gold. Low Stock. On sale for $130.00",
    "HOKA - Rincon 4. Color Stardust/Cosmic Grey. Low Stock. On sale for $97.99",
    "Going fast",
  ];
  for (const text of FIRES) {
    it(`still fires on ${JSON.stringify(text.slice(0, 48))}`, () => {
      expect(score(text, "scarcity.stock")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
    });
  }
});

/**
 * Audit run 2. The same Zappos row, sent back a second time.
 *
 * The first fix for this (412f888) was verified against a three-level fixture — the one above
 * — and reported as "fires before, silent after". It never stopped firing in the field: run 2
 * has it again, 16 times, byte for byte. The reason is that the fixture was shallow.
 * `selectorPath` keeps only the deepest 12 levels, so on a real grid tile the badge's path and
 * its grandparent's path start at DIFFERENT ancestors and share no prefix, and the ancestry
 * check that fix added cannot fire at all. A three-level fixture is the one DOM shape where
 * the bug is structurally impossible.
 *
 * So this reconstruction is taken from `__scarcity-probe.mjs` against the live page, tags and
 * depth included: the badge sat at depth 20 inside `<dl aria-hidden>` as `dd:nth-of-type(4)`,
 * with the product's attribute list — the `<dt>`/`<dd>` pairs that join into "brand name
 * birkenstock product name birki flow eva clog…" — as its siblings.
 */
describe("scarcity.stock survives a real grid tile, where selector paths are truncated", () => {
  /** Nest deep enough that selectorPath's 12-level cap actually bites, as zappos.com does. */
  const deep = (html: string, levels = 9) =>
    `${'<div class="wrap">'.repeat(levels)}${html}${"</div>".repeat(levels)}`;

  const ZAPPOS_TILE = deep(
    `<article class="card">` +
      `<a href="/p/birki-flow">Birkenstock - Birki Flow EVA Clog. Color Khaki. $59.95</a>` +
      `<div class="meta"><dl class="block" aria-hidden="true">` +
      `<dt>Brand Name</dt><dd>Birkenstock</dd>` +
      `<dt>Product Name</dt><dd>Birki Flow EVA Clog</dd>` +
      `<dt>Gender</dt><dd>Unisex</dd>` +
      `<div class="mt-2"><dt>Price</dt><dd><span class="sr-only">$59.95</span></dd></div>` +
      `<dd><span role="status">Low Stock</span></dd>` +
      `</dl></div></article>`,
  );

  it("claims the Low Stock badge exactly once, and never quotes the attribute list", () => {
    const hits = claimsOn(ZAPPOS_TILE, "scarcity.stock");

    expect(hits.length, `one Low Stock badge produced ${hits.length} claims`).toBe(1);
    const quoted = hits[0]?.evidence.textSample ?? "";
    expect(quoted, `evidence quoted the catalogue text: ${quoted}`).not.toMatch(/brand name/i);
    expect(quoted).toContain("Low Stock");
  });

  it("tags the lexeme it matched, which the bogus claim never could", () => {
    // The tell, asserted so it cannot come back quietly: the audit row for this false positive
    // was the only scarcity firing with an empty lexeme list, because the pattern was matched
    // against the parent's text and the lexemes against the node's own. A claim that has to
    // carry part of the phrase cannot produce that mismatch.
    const hits = claimsOn(ZAPPOS_TILE, "scarcity.stock");
    expect(hits[0]?.evidence.matchedLexemes).toContain("low stock");
  });

  it("still reads a sentence split across sibling spans, which is why the pass exists", () => {
    // The container pass is not being disabled, only made to prove the node is part of the
    // sentence. This is the shape it was added for, at the same depth.
    const hits = claimsOn(
      deep(`<p class="avail">Only <span class="n">3</span> left in stock</p>`),
      "scarcity.stock",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.evidence.textSample).toContain("Only 3 left in stock");
  });
});

/**
 * Audit run 2, temu.com/login.html: "Low stock items alerts", four times, and it SURFACED.
 *
 * The probe shows what it is — a benefit blurb in the sign-in page footer, next to "Faster &
 * more secure checkout", under `data-tooltip="FooterBenefitItem_lowstock"`. It is an offer to
 * tell you about low stock later. Nothing on the page is running out.
 */
describe("scarcity.stock does not read an offer of stock alerts as a stock claim", () => {
  it("stays silent on Temu's sign-in footer benefit", () => {
    const temu =
      `<div class="tooltipItem" data-tooltip="FooterBenefitItem_lowstock">` +
      `<img alt=""><div class="text">Low stock items alerts</div></div>`;
    const hits = claimsOn(temu, "scarcity.stock");
    expect(hits.map((h) => h.evidence.textSample)).toEqual([]);
  });

  /**
   * The point of the rule rather than of the string. A fix that only knew "Low stock items
   * alerts" would be back on the next site that writes the same offer a different way.
   */
  const SILENT = [
    "Low stock alerts",
    "Turn on low stock notifications",
    "Manage your low stock item reminders",
    "Get notified when items are almost gone",
    "We'll email you about limited availability items",
  ];
  for (const text of SILENT) {
    it(`generalises, and stays silent on ${JSON.stringify(text)}`, () => {
      expect(score(text, "scarcity.stock")).toBeLessThan(LOG_THRESHOLD);
    });
  }

  /**
   * The seam, asserted so the trade is visible. A notification feature is named in the plural
   * — it is a class of mail you can receive — whereas "alert" in the singular is badge
   * English, an interjection announcing the fact. That distinction is a judgement: nothing in
   * the labelled corpus exercises either phrasing. If it turns out to be wrong, this is the
   * test to argue with.
   */
  it("keeps a singular badge-style alert, which is announcing the fact, not offering mail", () => {
    expect(score("Low stock alert!", "scarcity.stock")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
  });
});

describe("scarcity in a terms footnote is counted, never surfaced", () => {
  /**
   * The adjudication, argued in scarcity.ts and asserted here.
   *
   * "While supplies last" is scarcity language wherever it appears, and all three of these are
   * labelled positive in the corpus, so silencing them would be both a recall loss and a
   * disagreement with the labels. But a sentence wedged between "Exclusions apply" and "Terms
   * apply" is a lawyer bounding an offer, not a badge bounding a decision — and the audit
   * recorded three cards for what a shopper sees as one footnote.
   *
   * So the claim is kept and the interruption is not: above the log threshold, below the
   * surface threshold. If someone later decides these deserve a card after all, this is the
   * test to argue with.
   */
  const FOOTNOTES = [
    "a Exclusions/terms apply. While supplies last. † Terms apply.",
    "*Exclusions/terms apply. • While supplies last",
    "*Exclusions/terms apply. While supplies last.",
  ];
  for (const text of FOOTNOTES) {
    it(`logs but does not surface ${JSON.stringify(text.slice(0, 44))}`, () => {
      const s = score(text, "scarcity.stock");
      expect(s, "a scarcity claim in a disclaimer should still be counted").toBeGreaterThanOrEqual(
        LOG_THRESHOLD,
      );
      expect(s, "a terms footnote should never interrupt a shopper").toBeLessThan(
        SURFACE_THRESHOLD,
      );
    });
  }

  it("still surfaces the same phrase when it is the promo itself", () => {
    expect(
      score("Free gift with purchase — while supplies last", "scarcity.stock"),
    ).toBeGreaterThanOrEqual(SURFACE_THRESHOLD);
  });
});
