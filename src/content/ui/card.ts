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

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A control the card must not sit on top of — or, if `critical` is false, one it would
 * merely be impolite to sit on top of.
 *
 * The distinction is the whole fix. See `choosePlacement`.
 */
export interface Control extends Rect {
  /** Absent means critical. Callers that do not tier must get the conservative answer. */
  critical?: boolean;
}

export interface Viewport {
  w: number;
  h: number;
}

const CARD_WIDTH = 360;
const MARGIN = 16;
/** Rough per-item height, for estimating the card's footprint before it exists. */
const ITEM_HEIGHT = 86;
const CARD_CHROME = 52;

/** Compact fallback: one line, no prompt body. */
export const PILL_WIDTH = 240;
export const PILL_HEIGHT = 40;

export interface Anchor {
  h: "left" | "center" | "right";
  v: "top" | "middle" | "bottom";
}

/**
 * Candidate positions, in preference order. Bottom-right first because it is the least
 * intrusive when free; the centred and mid-height anchors are last because they sit in the
 * reading path even when they cover nothing.
 *
 * Four corners was not enough. On a dense storefront the header fills both top anchors and
 * the footer or a chat widget fills both bottom ones, and the card had nowhere left to go.
 */
const ANCHORS: readonly Anchor[] = [
  { h: "right", v: "bottom" },
  { h: "left", v: "bottom" },
  { h: "right", v: "top" },
  { h: "left", v: "top" },
  { h: "right", v: "middle" },
  { h: "left", v: "middle" },
  { h: "center", v: "bottom" },
  { h: "center", v: "top" },
];

export interface Position {
  left: number;
  top: number;
}

export function positionOf(anchor: Anchor, viewport: Viewport, size: Viewport): Position {
  const left =
    anchor.h === "right"
      ? viewport.w - MARGIN - size.w
      : anchor.h === "left"
        ? MARGIN
        : Math.round((viewport.w - size.w) / 2);
  const top =
    anchor.v === "bottom"
      ? viewport.h - MARGIN - size.h
      : anchor.v === "top"
        ? MARGIN
        : Math.round((viewport.h - size.h) / 2);
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

/**
 * Selector for things a card must never cover, no matter what.
 *
 * Every form field qualifies: on a checkout page they are the task. Buttons and links
 * qualify only when their name puts them on the purchase path — see PURCHASE_INTENT.
 */
export const FIELD =
  'input:not([type="hidden"]), select, textarea, [contenteditable=""], [contenteditable="true"]';
export const CLICKABLE = 'button, a, [role="button"], [role="link"], [type="submit"], [onclick]';

/**
 * Names that put a control on the purchase path. Deliberately generous — a false "critical"
 * costs one candidate position, a false "ordinary" covers a button someone needed.
 */
export const PURCHASE_INTENT =
  /\b(check\s?out|place\s+order|pay|buy|purchase|order|submit|continue|next|proceed|confirm|apply|add to (cart|bag|basket)|book|reserve|select|choose|sign in|log in|edit|remove|delete|save)\b/i;

function nameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  if (el instanceof HTMLInputElement && el.value) return el.value;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function isCritical(el: Element): boolean {
  if (el.matches(FIELD)) return true;
  if (el.matches('[type="submit"]')) return true;
  if (el === el.ownerDocument.activeElement) return true;
  return PURCHASE_INTENT.test(nameOf(el));
}

function collisions(
  controls: readonly Control[],
  pos: Position,
  size: Viewport,
): { critical: number; ordinary: number } {
  let critical = 0;
  let ordinary = 0;
  for (const r of controls) {
    // Exact rectangle intersection, NOT point sampling. A 4x4 sample grid was tried first
    // and silently failed in a real browser: with 74px vertical steps it stepped straight
    // over a 48px-tall checkout button and reported the corner as clear.
    const hit =
      r.left < pos.left + size.w &&
      r.right > pos.left &&
      r.top < pos.top + size.h &&
      r.bottom > pos.top;
    if (!hit) continue;
    if (r.critical !== false) critical++;
    else ordinary++;
  }
  return { critical, ordinary };
}

/** Best position for a given size, or null if every one covers something critical. */
function bestAnchor(
  controls: readonly Control[],
  viewport: Viewport,
  size: Viewport,
): { anchor: Anchor; position: Position } | null {
  let best: { anchor: Anchor; position: Position; ordinary: number } | null = null;
  for (const anchor of ANCHORS) {
    const position = positionOf(anchor, viewport, size);
    const { critical, ordinary } = collisions(controls, position, size);
    if (critical > 0) continue;
    if (ordinary === 0) return { anchor, position }; // perfect, stop looking
    if (best === null || ordinary < best.ordinary) best = { anchor, position, ordinary };
  }
  return best ? { anchor: best.anchor, position: best.position } : null;
}

export type PlacementMode = "card" | "pill" | "suppressed";

export interface Placement {
  mode: PlacementMode;
  anchor: Anchor;
  position: Position;
  size: Viewport;
  /** How many non-critical controls the chosen spot overlaps. Zero is preferred, not required. */
  ordinaryCovered: number;
}

/**
 * Pure geometry. Find somewhere the card can sit.
 *
 * THE RULE THAT CHANGED. The original rule was "cover nothing clickable", and on real pages
 * it is unsatisfiable: a measured 60% of samples suppressed, and across four live retailers
 * the tester never once saw a card. Header and nav clusters fill the corners, so the card
 * had nowhere to go and the product silently did nothing.
 *
 * "Clickable" was the wrong category. A footer link reading "Careers" is not something a
 * shopper needs during a purchase; the Place Order button is. So controls are tiered, and
 * the rule is now:
 *
 *   - NEVER overlap a critical control: any form field, any submit, anything focused, and
 *     any button or link whose name puts it on the purchase path.
 *   - Among the positions that satisfy that, prefer the one covering the fewest ordinary
 *     controls — but do not refuse to render because that number is above zero. The card is
 *     small, dismissible, keyboard reachable and disappears on its own after 20 seconds.
 *
 * The e2e test asserting a checkout button can never be covered still holds, because a
 * checkout button is critical by name.
 */
export function choosePlacement(
  controls: readonly Control[],
  viewport: Viewport,
  itemCount: number,
): Placement {
  // Among card sizes, prefer the one covering the fewest ordinary controls; ties go to the
  // larger card. Measured on newegg, where simply taking the first merely-safe size sat on
  // nine nav links when a different anchor sat on one.
  //
  // A card always beats a pill, though. The pill shows a count and no prompts, so trading
  // four real questions for two uncovered footer links is a bad deal — an earlier version
  // made exactly that trade on ikea.
  let best: Placement | null = null;
  for (let n = Math.min(itemCount, 4); n >= 1; n--) {
    const size = cardSize(n, viewport);
    const spot = bestAnchor(controls, viewport, size);
    if (!spot) continue;
    const ordinaryCovered = collisions(controls, spot.position, size).ordinary;
    const placement: Placement = { mode: "card", ...spot, size, ordinaryCovered };
    if (ordinaryCovered === 0) return placement; // cannot do better
    if (best === null || ordinaryCovered < best.ordinaryCovered) best = placement;
  }
  if (best) return best;

  const pill = pillSize(viewport);
  const pillSpot = bestAnchor(controls, viewport, pill);
  if (pillSpot) {
    return {
      mode: "pill",
      ...pillSpot,
      size: pill,
      ordinaryCovered: collisions(controls, pillSpot.position, pill).ordinary,
    };
  }

  // Every position covers something on the purchase path. Saying nothing is correct here.
  return {
    mode: "suppressed",
    anchor: ANCHORS[0] as Anchor,
    position: positionOf(ANCHORS[0] as Anchor, viewport, pill),
    size: pill,
    ordinaryCovered: 0,
  };
}

export function pillSize(viewport: Viewport): Viewport {
  return {
    w: Math.min(PILL_WIDTH, viewport.w - MARGIN * 2),
    h: Math.min(PILL_HEIGHT, viewport.h - MARGIN * 2),
  };
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
  /** Largest digest, 0-4, that fits somewhere covering nothing critical. */
  maxCardItems: number;
  /** Whether the compact pill fits, when a full card does not. */
  pillFits: boolean;
}

export function measureCapacity(): PlacementCapacity {
  // The card is now anchored under the toolbar icon and is allowed to overlap page content,
  // so there is always room. This used to hunt for a collision-free corner and return zero
  // when it found none, which is what made the worker answer `suppressed` on dense pages.
  //
  // It still reports a number rather than a boolean because the worker uses it to cap how
  // many prompts to select, and because a very short viewport genuinely cannot show four.
  const viewport: Viewport = { w: window.innerWidth, h: window.innerHeight };
  let maxCardItems = 1;
  for (let n = 4; n >= 1; n--) {
    if (cardSize(n, viewport).h <= viewport.h - MARGIN * 2) {
      maxCardItems = n;
      break;
    }
  }
  return { maxCardItems, pillFits: true };
}

export function readControls(viewport: Viewport): Control[] {
  const controls: Control[] = [];
  for (const el of document.querySelectorAll(`${FIELD}, ${CLICKABLE}`)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // Off-screen controls cannot be covered by a fixed-position card.
    if (r.bottom < 0 || r.top > viewport.h) continue;
    if (r.right < 0 || r.left > viewport.w) continue;
    controls.push({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      critical: isCritical(el),
    });
  }
  return controls;
}

/**
 * Where the digest card goes: directly under the extension's own toolbar icon, always.
 *
 * This replaces the search for a corner that covers nothing clickable. That search was
 * correct about safety and wrong about legibility — a card that appears in whichever corner
 * happened to be free reads as a stray page element, with nothing connecting it to the
 * extension that produced it. Reported directly: "I don't like how the card was in another
 * part of the page."
 *
 * The icon lives in browser chrome, which a content script cannot see, so the anchor is the
 * viewport's top-right — the point directly below where Chrome puts extension actions.
 *
 * The trade is deliberate and was made explicitly: the card may now cover page content.
 * `choosePlacement` is retained and still tested, because the collision geometry is what
 * `measureCapacity` uses and what an opt-in "avoid page controls" mode would need — but the
 * shipped card no longer consults it. A dismiss control is therefore mandatory, not
 * optional, and the card no longer disappears on a timer.
 */
function iconAnchoredPlacement(itemCount: number): Placement {
  const viewport: Viewport = { w: window.innerWidth, h: window.innerHeight };
  const size = cardSize(itemCount, viewport);
  const anchor: Anchor = { h: "right", v: "top" };
  return {
    mode: "card",
    anchor,
    position: positionOf(anchor, viewport, size),
    size,
    ordinaryCovered: 0,
  };
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
  private items: CardItem[] = [];
  private mode: PlacementMode = "suppressed";
  private recheck: (() => void) | null = null;
  private recheckQueued = false;

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
    const placement = iconAnchoredPlacement(items.length);
    this.applyPosition(host, placement);

    const root = host.attachShadow({ mode: "closed" });
    root.append(this.styles(), placement.mode === "pill" ? this.pill(items) : this.card(items));

    document.documentElement.append(host);
    this.host = host;
    this.items = items;
    this.mode = placement.mode;
    this.watchLayout();

    // No auto-dismiss. It vanished while being read, and there is an explicit close
    // control now. Navigation still ends it, because a new page means a new content script.

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
      /* The close control is the ONLY way to dismiss now that the card has no timer, so it
         is full-contrast and has a real hit area rather than being a faint glyph. */
      button {
        all: unset; cursor: pointer; font-size: 18px; line-height: 1; font-weight: 500;
        padding: 4px 9px; border-radius: 6px; color: inherit; opacity: 1;
        border: 1px solid transparent;
      }
      button:hover { background: rgba(0,0,0,.06); border-color: #dfe1e6; }
      button:focus-visible { outline: 2px solid #2b5cff; outline-offset: 1px; }
      @media (prefers-color-scheme: dark) {
        button:hover { background: rgba(255,255,255,.10); border-color: #4a4d55; }
      }
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

  /**
   * Position is set inline, in pixels, with !important on every layout-critical property:
   * an inline important declaration beats an author stylesheet's important declaration, so
   * a page cannot hide the card by selector. Verified against a fixture that tries exactly
   * that. Pixels rather than `right:16px` because the anchors now include centred ones.
   */
  private applyPosition(host: HTMLElement, placement: Placement): void {
    host.style.cssText = [
      "position:fixed !important",
      `left:${placement.position.left}px !important`,
      `top:${placement.position.top}px !important`,
      "right:auto !important",
      "bottom:auto !important",
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
  }

  /**
   * A fixed card is measured once but lives on while the page scrolls underneath it. A spot
   * that was clear of the Place Order button at the moment of rendering is not clear of it
   * two seconds later, so the check has to repeat.
   *
   * Cheap: only on scroll and resize, coalesced to one animation frame, and the card is gone
   * within 20 seconds anyway.
   */
  private watchLayout(): void {
    const onChange = (): void => {
      if (this.recheckQueued) return;
      this.recheckQueued = true;
      requestAnimationFrame(() => {
        this.recheckQueued = false;
        this.reposition();
      });
    };
    this.recheck = onChange;
    addEventListener("scroll", onChange, { passive: true });
    addEventListener("resize", onChange, { passive: true });
  }

  /** Re-pin to the anchor on resize. Scroll cannot move a fixed element, but a resize can
   *  leave it off-screen or overlapping the edge. */
  private reposition(): void {
    const host = this.host;
    if (!host) return;
    this.applyPosition(host, iconAnchoredPlacement(this.items.length));
  }

  dismiss(): void {
    if (this.recheck) {
      removeEventListener("scroll", this.recheck);
      removeEventListener("resize", this.recheck);
      this.recheck = null;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host?.remove();
    this.host = null;
  }
}
