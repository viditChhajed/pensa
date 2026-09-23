/**
 * Add-to-cart and checkout-intent triggers (plan §6, T16).
 *
 * A capture-phase click listener on `document`, and deliberately NO monkey-patching of
 * `fetch`, patching it breaks host pages and reads as hostile in store review.
 *
 * What this does NOT do, stated plainly because an earlier comment promised otherwise: it does
 * not confirm the add succeeded. A click on "Add to cart" that the page then rejects (no size
 * chosen, out of stock) still counts as a trigger. The "PerformanceObserver confirmation step"
 * that was meant to follow was never built.
 *
 * Debounce: at most one trigger per kind per funnel stage PER PAGE LOAD, the set below lives on
 * this instance and a reload starts it empty. The once-per-session limit on actually SHOWING a
 * card is enforced separately in the worker (`shouldShowDigest`).
 *
 * The listener is only attached once the page has been confirmed as a shop; see
 * `onCommerceConfirmed` in the detector entrypoint.
 */
import type { FunnelStage } from "@/shared/schema";

const ATC_NAME = /\badd to (cart|bag|basket|order)\b|\badd item\b|\bbuy now\b|\badd to my bag\b/i;
const CHECKOUT_NAME =
  /\bcheckout\b|\bcheck out\b|\bplace order\b|\bcontinue to payment\b|\bproceed to\b|\bpay now\b|\bcomplete (order|purchase)\b|\bi'?ll reserve\b|\breserve (?:now|tickets?|room)\b|\bbook now\b|\bconfirm (?:and pay|booking|reservation)\b/i;

/**
 * Attribute values that name an add-to-cart control, matched as WHOLE TOKENS.
 *
 * These were substring matches, so the short token "atc" matched `watch-video`, `match-card`,
 * `batch-select`, `catch-all` and `patch-notes`, and a click on any of them counted as adding
 * to cart. Values are split on non-alphanumerics and camelCase boundaries and compared token
 * by token; the multi-word forms are compared as joined token runs.
 */
const ATC_ATTR_PHRASES: readonly (readonly string[])[] = [
  ["add", "to", "cart"],
  ["add", "to", "bag"],
  ["add", "to", "basket"],
  ["addtocart"],
  ["addtobag"],
  ["atc"],
];

function tokensOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

export type TriggerKind = "add_to_cart" | "checkout_intent";

export interface TriggerEvent {
  kind: TriggerKind;
  label: string;
  ts: number;
}

function accessibleNameOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const value = el instanceof HTMLInputElement ? el.value : "";
  return (value || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function actionableAncestor(start: EventTarget | null): Element | null {
  let node = start instanceof Element ? start : null;
  let depth = 0;
  while (node && depth < 6) {
    const tag = node.tagName;
    if (
      tag === "BUTTON" ||
      tag === "A" ||
      (tag === "INPUT" && ["submit", "button"].includes((node as HTMLInputElement).type)) ||
      node.getAttribute("role") === "button"
    ) {
      return node;
    }
    node = node.parentElement;
    depth++;
  }
  return null;
}

function matchesAtcAttrs(el: Element): boolean {
  for (const attr of ["data-testid", "data-action", "data-test", "id", "name"]) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const tokens = tokensOf(v);
    if (ATC_ATTR_PHRASES.some((p) => hasPhrase(tokens, p))) return true;
  }
  return false;
}

export class TriggerWatcher {
  /** `${kind}:${stage}` keys already fired on this page load, for the debounce. */
  private readonly fired = new Set<string>();

  constructor(
    private readonly onTrigger: (e: TriggerEvent) => void,
    private readonly currentStage: () => FunnelStage,
  ) {}

  attach(doc: Document = document): () => void {
    const handler = (ev: Event) => this.onClick(ev);
    doc.addEventListener("click", handler, { capture: true, passive: true });
    return () => doc.removeEventListener("click", handler, { capture: true });
  }

  private onClick(ev: Event): void {
    const el = actionableAncestor(ev.target);
    if (!el) return;

    const name = accessibleNameOf(el);
    let kind: TriggerKind | null = null;

    if (ATC_NAME.test(name) || matchesAtcAttrs(el)) kind = "add_to_cart";
    else if (CHECKOUT_NAME.test(name)) kind = "checkout_intent";
    if (!kind) return;

    if (!this.claim(kind)) return;
    this.onTrigger({ kind, label: name, ts: Date.now() });
  }

  /** One trigger per kind per stage per page load. Returns false if it already fired. */
  claim(kind: TriggerKind): boolean {
    const key = `${kind}:${this.currentStage()}`;
    if (this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }

  /** Stage transition into checkout is a trigger in its own right. */
  noteStageChange(next: FunnelStage): void {
    if (next !== "checkout" && next !== "payment") return;
    if (!this.claim("checkout_intent")) return;
    this.onTrigger({ kind: "checkout_intent", label: `stage:${next}`, ts: Date.now() });
  }
}
