import { afterEach, describe, expect, it } from "vitest";
import { DETECTORS } from "@/content/detectors";
import { naggingDetector } from "@/content/detectors/nagging";
import { PageObserver } from "@/content/observer";
import { contextFrom } from "./helpers";

/**
 * Copy the live audit caught a detector firing on, and should not.
 *
 * `npm run spot:check` loads the extension into Chromium and records every claim it makes on
 * real pages. Every case here came out of a run of it, which is the only instrument in the
 * project that covers the STRUCTURAL detectors — the labelled corpus is text, and says
 * nothing about anchoring, framing, nagging, interference or decoy, which are half the
 * shipped set.
 *
 * A false positive is the failure that gets an extension uninstalled. Nobody notices a miss.
 */

const score = (text: string, patternId: string): number => {
  const ctx = contextFrom(`<div class="cart">${text}</div>`, { stage: "cart" });
  return Math.max(
    0,
    ...DETECTORS.flatMap((d) => d.run(ctx))
      .filter((h) => h.patternId === patternId)
      .map((h) => h.rawScore),
  );
};

const LOG_THRESHOLD = 0.35;

describe("social_proof does not read years or follower counts as viewers", () => {
  /**
   * The "LIVE • 279" rule was written for one observed string and over-fired the same day:
   * `\blive\b[^a-z0-9]{0,4}(\d{2,6})\b` matched "Live 2026" and "Live 768 followers" across
   * Eventbrite. A rule generalised from a single example deserves the narrowest form that
   * still covers the example.
   */
  const SILENT = [
    "From Day One - Los Angeles Live 2026: Marketing",
    "Save this event: From Day One - Los Angeles Live 2026",
    "Pace Live 768 followers",
    "Live from the studio",
    "Watch live",
  ];
  for (const text of SILENT) {
    it(`stays silent on ${JSON.stringify(text)}`, () => {
      expect(score(text, "social_proof.live_activity")).toBeLessThan(LOG_THRESHOLD);
    });
  }

  const FIRES = [
    "LIVE • 279",
    "LIVE 340 watching",
    "505 people have purchased this in the last 3 hours!",
  ];
  for (const text of FIRES) {
    it(`still fires on ${JSON.stringify(text)}`, () => {
      expect(score(text, "social_proof.live_activity")).toBeGreaterThanOrEqual(LOG_THRESHOLD);
    });
  }
});

describe("framing quotes the prices it scored, not a sibling", () => {
  it("claims a product tile once, and evidences it with the prices", () => {
    /**
     * A Zappos grid tile produced FIVE firings from one was/now price pair, evidenced as
     * "370", "237v1", "WL574V2", "603" and "V5 Runner" — New Balance model numbers, which is
     * what the sibling spans inside the tile contain. The detector scores `containerText`
     * and was attributing to the node it happened to attach to.
     *
     * Both halves were wrong: one claim counted five times, and a card that would name the
     * pattern and then quote a model number as its proof.
     */
    const ctx = contextFrom(
      `<div class="tile"><span>New Balance</span><span>530</span><span>V5 Runner</span>` +
        `<span class="was">$109.95</span><span class="now">$54.95</span><span>50% off</span></div>`,
      { stage: "browse" },
    );
    const hits = DETECTORS.flatMap((d) => d.run(ctx)).filter(
      (h) => h.patternId === "framing.savings_ratio",
    );

    expect(hits.length, "one price pair produced more than one claim").toBeLessThanOrEqual(1);
    if (hits.length === 1) {
      const quoted = hits[0]?.evidence.textSample ?? "";
      expect(quoted, `evidence quoted a sibling, not the prices: ${quoted}`).toMatch(/\d+\.\d{2}/);
    }
  });
});

/**
 * nagging counts INTERRUPTIONS, and the page renders them as several elements each.
 *
 * These drive the real PageObserver rather than handing the detector a count, because the
 * count is the thing that was wrong both times: the detector has never had a bug, and has
 * twice shipped a wrong claim.
 *
 * jsdom lays nothing out, so every box is zero and `isShowing` would reject the whole
 * document. Rects are stubbed to what a browser would report, which is the same accommodation
 * `contextFrom` makes for harvested nodes.
 */
function sized(el: Element, w = 440, h = 258): Element {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h }) as DOMRect;
  return el;
}

function insert(html: string, w?: number, h?: number): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  const el = host.firstElementChild as Element;
  sized(el, w, h);
  for (const child of el.querySelectorAll("*")) sized(child, w, h);
  document.body.appendChild(el);
  return el;
}

/** MutationObserver records arrive on a microtask; let them land. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let observer: PageObserver | null = null;
function watching(): PageObserver {
  document.body.innerHTML = "";
  observer = new PageObserver(() => {});
  observer.start(document.body);
  return observer;
}

afterEach(() => {
  observer?.stop();
  observer = null;
  document.body.innerHTML = "";
});

/** What the detector would say, given the interruptions the observer actually counted. */
function naggingFires(o: PageObserver): boolean {
  const modalsInsertedAt = [...o.state.modalsInsertedAt];
  const ctx = contextFrom(`<p>Some page content here</p>`, {
    signals: { modalInsertionCount: modalsInsertedAt.length, modalsInsertedAt },
  });
  return naggingDetector.run(ctx).length > 0;
}

describe("nagging counts interruptions, not the elements one is built from", () => {
  it("reads a cookie banner and its scrim as ONE interruption", async () => {
    /**
     * boohoo.com and prettylittlething.us, re-probed live. CookieYes inserts `div.cky-overlay`
     * — a dim, empty, full-viewport scrim — as a SIBLING of the banner, and the overlay branch
     * of `looksModal` called it a modal. One consent notice, "2 interstitials", and FLAG_AT is
     * 2, so the card fired. Nearly every consent vendor ships a scrim.
     *
     * The first fix (49e7995) is not what missed this: the hidden "Customise preferences"
     * panel these sites also mount was already rejected for not showing. Insertion was the
     * wrong event to count, and a scrim is not a message.
     */
    const o = watching();
    insert(
      `<div class="cky-overlay" style="position:fixed;opacity:0.4;z-index:9999"></div>`,
      1280,
      900,
    );
    insert(
      `<div role="dialog" class="cky-consent-container">` +
        `<p>HOW BOOHOO USES COOKIES</p><button>Accept All</button><button>Customise</button>` +
        `</div>`,
    );
    await settle();

    expect(o.state.modalsInsertedAt).toHaveLength(1);
    expect(naggingFires(o)).toBe(false);
  });

  it("reads a wrapper and the card inside it as ONE interruption", async () => {
    // temu.com/bgn_verification.html, the same shape inverted: an empty full-viewport wrapper
    // lands first and the CAPTCHA card is inserted INTO it a moment later, so parent and child
    // were counted separately. One security check, "2 interstitials".
    const o = watching();
    const wrapper = insert(`<div style="position:fixed;z-index:9999"></div>`, 1280, 900);
    await settle();
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.innerHTML = `<p>Security Verification</p><button>Refresh</button>`;
    sized(card, 600, 400);
    wrapper.appendChild(card);
    await settle();

    expect(o.state.modalsInsertedAt).toHaveLength(1);
    expect(naggingFires(o)).toBe(false);
  });

  it("does not count a dialog that is mounted but never shown", async () => {
    // The sub-panel every consent vendor mounts beside its banner: in the DOM from the start,
    // on screen only if the shopper clicks through to it.
    const o = watching();
    insert(`<div role="dialog"><p>HOW BOOHOO USES COOKIES</p><button>Accept All</button></div>`);
    insert(
      `<div role="dialog" style="visibility:hidden">` +
        `<p>Customise Consent Preferences</p><button>Save</button></div>`,
      845,
      711,
    );
    await settle();

    expect(o.state.modalsInsertedAt).toHaveLength(1);
    expect(naggingFires(o)).toBe(false);
  });

  it("DOES count a modal that was mounted hidden and revealed later", async () => {
    // The other half of moving off insertions: a popup pre-mounted hidden and shown ten
    // seconds in is an interruption the shopper had, and the old code could never see it —
    // its only insertion happened while it was invisible. A fix that only ever subtracts
    // would have made this detector quieter, not more truthful.
    const o = watching();
    insert(`<div role="dialog"><p>We use cookies</p><button>Accept All</button></div>`);
    const popup = insert(
      `<div role="dialog" style="display:none"><p>Get 10% off your first order</p>` +
        `<button>Sign up</button></div>`,
    );
    await settle();
    expect(o.state.modalsInsertedAt).toHaveLength(1);

    (popup as HTMLElement).style.display = "block";
    await settle();

    expect(o.state.modalsInsertedAt).toHaveLength(2);
    expect(naggingFires(o)).toBe(true);
  });

  it("reads a banner and the role=dialog INSIDE it as ONE interruption", async () => {
    /**
     * glossier.com, live-probed after the scrim fix landed — and a regression that fix
     * introduced, caught before it shipped.
     *
     * OneTrust renders `div#onetrust-banner-sdk` (458x147) wrapping `div.ot-sdk-container`
     * (456x145), and the inner one carries `role="dialog"`. So the wrapper qualifies through
     * the contains-a-showing-dialog branch and the child qualifies through its own role:
     * two elements, 2px apart, one cookie banner, "2 interstitials".
     *
     * `partOfShownModal` already suppresses a parent/child pair — but only when one of them
     * is on the watch list by the time the other is judged. OneTrust reveals the pair by
     * toggling the wrapper, so both can be judged from the same sweep with neither yet
     * recorded. Containment is checked against everything modal-shaped on the page now, not
     * only against what has already been written down.
     *
     * The sharpest version of why this matters: OneTrust is on a large share of the web, and
     * FLAG_AT is 2.
     */
    const o = watching();
    const banner = insert(
      `<div id="onetrust-banner-sdk" style="position:fixed;z-index:9999">` +
        `<div class="ot-sdk-container" role="dialog"><p>Your Privacy</p>` +
        `<button>Accept All</button></div></div>`,
      1280,
      900,
    );
    sized(banner.firstElementChild as Element, 1278, 898);
    await settle();

    expect(o.state.modalsInsertedAt).toHaveLength(1);
    expect(naggingFires(o)).toBe(false);
  });

  it("does not count modals the shopper opened", async () => {
    // A bag drawer and a size guide, both `role="dialog"`, both opened by a click. Counting
    // those would be the original fabrication in a new costume: nagging is a claim about what
    // the page imposed, and these were asked for.
    const o = watching();
    for (const label of ["Your bag", "Size guide"]) {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      insert(`<div role="dialog"><p>${label}</p><button>Close</button></div>`);
      await settle();
    }

    expect(o.state.modalsInsertedAt).toHaveLength(0);
    expect(naggingFires(o)).toBe(false);
  });
});
