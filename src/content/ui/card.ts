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

const HOST_ID = "persuasion-patterns-host";
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
 * Pure geometry. Given the boxes of everything clickable, pick the corner whose footprint
 * covers the fewest of them — zero if any corner is clear.
 *
 * Pure so it can be tested without a browser, and because the DOM reads belong in one place
 * (the caller) rather than interleaved with the decision, same as the detector phases.
 */
export function chooseCorner(
  controls: readonly Rect[],
  viewport: Viewport,
  card: Viewport,
): Corner {
  let best: Corner = CORNERS[0] as Corner;
  let bestHits = Number.POSITIVE_INFINITY;

  for (const corner of CORNERS) {
    const left = corner.horizontal === "right" ? viewport.w - MARGIN - card.w : MARGIN;
    const top = corner.vertical === "bottom" ? viewport.h - MARGIN - card.h : MARGIN;

    // Exact rectangle intersection, NOT point sampling. A 4x4 sample grid was tried first
    // and silently failed in a real browser: with 74px vertical steps it stepped straight
    // over a 48px-tall checkout button and reported the corner as clear.
    let hits = 0;
    for (const rect of controls) {
      const intersects =
        rect.left < left + card.w &&
        rect.right > left &&
        rect.top < top + card.h &&
        rect.bottom > top;
      if (intersects) hits++;
    }

    if (hits === 0) return corner;
    if (hits < bestHits) {
      bestHits = hits;
      best = corner;
    }
  }

  // Nothing is fully clear — take the least-obstructed corner rather than a fixed one.
  return best;
}

/** Estimated card footprint, before the card exists to measure. */
export function cardSize(itemCount: number, viewport: Viewport): Viewport {
  return {
    w: Math.min(CARD_WIDTH, viewport.w - MARGIN * 2),
    h: Math.min(CARD_CHROME + ITEM_HEIGHT * Math.min(itemCount, 4), viewport.h - MARGIN * 2),
  };
}

/** DOM reads, then delegate to the pure chooser. */
function findSafeCorner(itemCount: number): Corner {
  const viewport: Viewport = { w: window.innerWidth, h: window.innerHeight };

  const controls: Rect[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Off-screen controls cannot be covered by a fixed-position card.
    if (r.bottom < 0 || r.top > viewport.h) continue;
    if (r.right < 0 || r.left > viewport.w) continue;
    controls.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }

  return chooseCorner(controls, viewport, cardSize(itemCount, viewport));
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

  show(items: CardItem[]): void {
    if (items.length === 0) return;
    this.dismiss();

    const host = document.createElement("div");
    host.id = HOST_ID;

    // `pointer-events: none` on the host is necessary but NOT sufficient: the card inside
    // re-enables pointer events, so wherever the card actually renders it still wins the
    // hit test. Verified in a real browser — a checkout button at bottom-right was covered.
    // So the position is chosen by hit-testing the page first (see findSafeCorner).
    const corner = findSafeCorner(items.length);
    host.style.cssText = [
      "position:fixed",
      `${corner.horizontal}:16px`,
      `${corner.vertical}:16px`,
      "z-index:2147483647",
      "pointer-events:none",
      `width:min(${CARD_WIDTH}px, calc(100vw - 32px))`,
      "contain:layout style",
    ].join(";");

    const root = host.attachShadow({ mode: "closed" });
    root.append(this.styles(), this.card(items));

    document.documentElement.append(host);
    this.host = host;

    this.timer = window.setTimeout(() => this.dismiss(), AUTO_DISMISS_MS);

    const close = root.querySelector("[data-close]");
    close?.addEventListener("click", () => this.dismiss());
    (close as HTMLElement | null)?.focus();
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

  dismiss(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host?.remove();
    this.host = null;
  }
}
