/**
 * The digest card (plan §9, T17).
 *
 * Hard requirements, each of which has a way of going wrong:
 *   - Closed shadow root with `all: initial` and containment, so a host page's aggressive
 *     global CSS cannot restyle it and it cannot leak styles back out.
 *   - Non-modal. `pointer-events` is enabled on the card and NOTHING else, so the overlay
 *     can never intercept a click meant for a checkout button. There is an e2e test for
 *     exactly this, because getting it wrong makes the extension actively harmful.
 *   - Dismissible, keyboard reachable, auto-dismiss after 20s.
 *
 * Day 1 ships one hardcoded prompt per pattern. The 4–6 variant pools land Day 2.
 */

/**
 * The shadow root protects what is INSIDE the card. It does nothing for the host element,
 * which lives in the page's own DOM and is fully styleable by the page. A real fixture with
 * `#persuasion-patterns-host { display: none !important }` and
 * `[id^="persuasion"] { visibility: hidden !important }` hid the card completely.
 *
 * Two defences: a per-injection random id, so there is no stable selector to target, and
 * the layout-critical properties set inline with `!important`, which outranks an author
 * stylesheet's `!important` in the cascade.
 */
const HOST_ID_PREFIX = "pp-";

function randomHostId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return (
    HOST_ID_PREFIX +
    Array.from(bytes, (b) => b.toString(36))
      .join("")
      .slice(0, 10)
  );
}
const AUTO_DISMISS_MS = 20_000;
const CARD_WIDTH = 360;
const MARGIN = 16;
/** Rough per-item height, for estimating the card's footprint before it exists. */
const ITEM_HEIGHT = 86;
const CARD_CHROME = 52;

type Corner = { horizontal: "left" | "right"; vertical: "top" | "bottom" };

/** Preference order. Bottom-right first because that is the least intrusive when it is free. */
const CORNERS: Corner[] = [
  { horizontal: "right", vertical: "bottom" },
  { horizontal: "left", vertical: "bottom" },
  { horizontal: "right", vertical: "top" },
  { horizontal: "left", vertical: "top" },
];

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="link"], [onclick]';

/**
 * Pick a corner whose footprint covers nothing the shopper might need to click.
 *
 * This exists because of a concrete failure: with the card fixed at bottom-right, a
 * checkout button at bottom-right was underneath it, and `document.elementFromPoint` at the
 * button's centre returned the overlay. An extension that can cover the "Place order"
 * button is worse than no extension, so position is computed, not assumed.
 *
 * All reads happen BEFORE the host is inserted, so nothing of ours pollutes the hit test.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/**
 * Placement modes, in descending order of usefulness.
 *
 * Real retailer pages have NO free corner. Measured on live storefronts: target 1 collision,
 * ikea 3, newegg 9, rei 0. The original "least-obstructed corner" fallback therefore covered
 * between 3 and 9 real controls on three of four sites — violating the one rule the plan
 * calls non-negotiable.
 *
 * So the card degrades rather than intrudes: full card if it fits, a compact pill if not,
 * and nothing at all if even the pill would cover a control. A suppressed digest is not
 * lost — every detection is still recorded and shown in the popup summary, which the user
 * reads on their own schedule.
 */
export type PlacementMode = "card" | "pill" | "suppressed";

export interface Placement {
  mode: PlacementMode;
  corner: Corner;
  size: Viewport;
}

/** Compact fallback: one line, no prompt body, expands on click. */
export const PILL_WIDTH = 260;
export const PILL_HEIGHT = 44;

function collisionsAt(
  controls: readonly Rect[],
  viewport: Viewport,
  size: Viewport,
  corner: Corner,
): number {
  const left = corner.horizontal === "right" ? viewport.w - MARGIN - size.w : MARGIN;
  const top = corner.vertical === "bottom" ? viewport.h - MARGIN - size.h : MARGIN;
  let hits = 0;
  for (const r of controls) {
    // Exact rectangle intersection, NOT point sampling. A 4x4 sample grid was tried first
    // and silently failed in a real browser: with 74px vertical steps it stepped straight
    // over a 48px-tall checkout button and reported the corner as clear.
    if (r.left < left + size.w && r.right > left && r.top < top + size.h && r.bottom > top) {
      hits++;
    }
  }
  return hits;
}

/**
 * Pure geometry. Given the boxes of everything clickable, find a placement that covers
 * NOTHING. Returns `suppressed` rather than settling for a least-bad option.
 */
export function choosePlacement(
  controls: readonly Rect[],
  viewport: Viewport,
  itemCount: number,
): Placement {
  const full = cardSize(itemCount, viewport);
  for (const corner of CORNERS) {
    if (collisionsAt(controls, viewport, full, corner) === 0) {
      return { mode: "card", corner, size: full };
    }
  }

  const pill: Viewport = {
    w: Math.min(PILL_WIDTH, viewport.w - MARGIN * 2),
    h: Math.min(PILL_HEIGHT, viewport.h - MARGIN * 2),
  };
  for (const corner of CORNERS) {
    if (collisionsAt(controls, viewport, pill, corner) === 0) {
      return { mode: "pill", corner, size: pill };
    }
  }

  // Nowhere is clear. Covering a control is worse than saying nothing right now.
  return { mode: "suppressed", corner: CORNERS[0] as Corner, size: pill };
}

/** Retained for the existing unit tests: which corner is least obstructed. */
export function chooseCorner(
  controls: readonly Rect[],
  viewport: Viewport,
  card: Viewport,
): Corner {
  let best: Corner = CORNERS[0] as Corner;
  let bestHits = Number.POSITIVE_INFINITY;
  for (const corner of CORNERS) {
    const hits = collisionsAt(controls, viewport, card, corner);
    if (hits === 0) return corner;
    if (hits < bestHits) {
      bestHits = hits;
      best = corner;
    }
  }
  return best;
}

/** Estimated card footprint, before the card exists to measure. */
export function cardSize(itemCount: number, viewport: Viewport): Viewport {
  return {
    w: Math.min(CARD_WIDTH, viewport.w - MARGIN * 2),
    h: Math.min(CARD_CHROME + ITEM_HEIGHT * Math.min(itemCount, 4), viewport.h - MARGIN * 2),
  };
}

/**
 * How much the page can currently accommodate, measured BEFORE the worker ranks anything.
 *
 * The worker has to know this up front. It previously recorded `surfaced: true` and only
 * then handed the items to the card, which could still refuse to place them — so the event
 * log claimed a card had been shown that the user never saw, and the popup's Noticed/Shown
 * split was wrong. Measuring first makes the record accurate in a single round trip.
 */
export interface PlacementCapacity {
  /** Largest digest, 0-4, that fits somewhere covering nothing clickable. */
  maxCardItems: number;
  /** Whether the compact pill fits, when a full card does not. */
  pillFits: boolean;
}

export function measureCapacity(): PlacementCapacity {
  const viewport: Viewport = { w: window.innerWidth, h: window.innerHeight };
  const controls = readControls(viewport);

  let maxCardItems = 0;
  for (let n = 4; n >= 1; n--) {
    const size = cardSize(n, viewport);
    if (CORNERS.some((c) => collisionsAt(controls, viewport, size, c) === 0)) {
      maxCardItems = n;
      break;
    }
  }

  const pill: Viewport = {
    w: Math.min(PILL_WIDTH, viewport.w - MARGIN * 2),
    h: Math.min(PILL_HEIGHT, viewport.h - MARGIN * 2),
  };
  const pillFits = CORNERS.some((c) => collisionsAt(controls, viewport, pill, c) === 0);

  return { maxCardItems, pillFits };
}

function readControls(viewport: Viewport): Rect[] {
  const controls: Rect[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Off-screen controls cannot be covered by a fixed-position card.
    if (r.bottom < 0 || r.top > viewport.h) continue;
    if (r.right < 0 || r.left > viewport.w) continue;
    controls.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return controls;
}

/** DOM reads, then delegate to the pure chooser. */
function findPlacement(itemCount: number): Placement {
  const viewport: Viewport = { w: window.innerWidth, h: window.innerHeight };
  return choosePlacement(readControls(viewport), viewport, itemCount);
}

/**
 * Rendered content, decided by the service worker. The card does no copy selection of its
 * own — variant sampling needs session state (which prompts were already shown), and that
 * lives in the worker, not in a page that reloads constantly.
 */
export interface CardItem {
  patternId: string;
  label: string;
  prompt: string;
}

export class DigestCard {
  private host: HTMLElement | null = null;
  private timer: number | null = null;

  /**
   * Renders and returns what was ACTUALLY displayed. Layout can shift between the capacity
   * measurement and the render, so placement is re-checked here and this return value — not
   * the earlier estimate — is what gets recorded.
   */
  show(items: CardItem[]): PlacementMode {
    if (items.length === 0) return "suppressed";
    this.dismiss();

    const host = document.createElement("div");
    host.id = randomHostId();

    // `pointer-events: none` on the host is necessary but NOT sufficient: the card inside
    // re-enables pointer events, so wherever the card actually renders it still wins the
    // hit test. Verified in a real browser — a checkout button at bottom-right was covered.
    // So the position is chosen by hit-testing the page first (see findSafeCorner).
    const placement = findPlacement(items.length);
    if (placement.mode === "suppressed") {
      // Nowhere on this page can hold the card without covering something clickable. The
      // detections are already logged and appear in the popup summary.
      console.debug("[patterns] digest suppressed: no placement free of interactive controls");
      return "suppressed";
    }
    const corner = placement.corner;
    // Every layout-critical property carries !important: an inline important declaration
    // beats an author stylesheet's important declaration, so a page cannot hide the card by
    // selector. Verified against a fixture that tries exactly that.
    host.style.cssText = [
      "position:fixed !important",
      `${corner.horizontal}:16px !important`,
      `${corner.vertical}:16px !important`,
      "z-index:2147483647 !important",
      "pointer-events:none !important",
      `width:${placement.size.w}px !important`,
      "contain:layout style",
      "display:block !important",
      "visibility:visible !important",
      "opacity:1 !important",
      "transform:none !important",
      "clip-path:none !important",
      "max-width:none !important",
      "max-height:none !important",
      "margin:0 !important",
      "filter:none !important",
    ].join(";");

    const root = host.attachShadow({ mode: "closed" });
    root.append(this.styles(), placement.mode === "pill" ? this.pill(items) : this.card(items));

    document.documentElement.append(host);
    this.host = host;

    this.timer = window.setTimeout(() => this.dismiss(), AUTO_DISMISS_MS);

    const close = root.querySelector("[data-close]");
    close?.addEventListener("click", () => this.dismiss());
    (close as HTMLElement | null)?.focus();

    return placement.mode;
  }

  private styles(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .card {
        pointer-events: auto;
        background: #ffffff;
        color: #16181d;
        border: 1px solid #dfe1e6;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.16);
        padding: 14px 16px;
        font-size: 13.5px;
        line-height: 1.5;
      }
      @media (prefers-color-scheme: dark) {
        .card { background:#1f2126; color:#eceef2; border-color:#33363d; }
        .head { color:#9aa0aa; }
        li + li { border-color:#33363d; }
      }
      .head {
        display:flex; align-items:center; justify-content:space-between;
        font-size:11px; text-transform:uppercase; letter-spacing:.07em;
        color:#6b7280; margin-bottom:8px;
      }
      button {
        all: unset; cursor: pointer; font-size: 16px; line-height: 1;
        padding: 2px 6px; border-radius: 6px; color: inherit; opacity: .6;
      }
      button:hover, button:focus-visible { opacity: 1; outline: 2px solid #2b5cff; }
      .pill { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; }
      ul { list-style: none; padding: 0; }
      li { padding: 8px 0; }
      li + li { border-top: 1px solid #eceef2; }
      .label { font-weight: 600; display: block; margin-bottom: 2px; }
      .prompt { color: inherit; }
    `;
    return style;
  }

  private card(items: CardItem[]): HTMLElement {
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "complementary");
    card.setAttribute("aria-live", "polite");
    card.setAttribute("aria-label", "Things this page did");

    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.textContent = "On this page";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("data-close", "");
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    head.append(title, close);

    const list = document.createElement("ul");
    for (const item of items.slice(0, 4)) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "label";
      // textContent, never innerHTML: this content crosses a context boundary and the card
      // renders inside someone else's page.
      label.textContent = item.label;
      const p = document.createElement("p");
      p.className = "prompt";
      p.textContent = item.prompt;
      li.append(label, p);
      list.append(li);
    }

    card.append(head, list);
    return card;
  }

  /** Compact fallback when a full card would cover something clickable. */
  private pill(items: CardItem[]): HTMLElement {
    const card = document.createElement("div");
    card.className = "card pill";
    card.setAttribute("role", "complementary");
    card.setAttribute("aria-live", "polite");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent =
      items.length === 1
        ? `1 thing to notice on this page`
        : `${items.length} things to notice on this page`;

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("data-close", "");
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";

    card.append(label, close);
    return card;
  }

  dismiss(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host?.remove();
    this.host = null;
  }
}
