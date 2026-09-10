/**
 * Add-to-cart and checkout-intent triggers (plan §6, T16).
 *
 * Capture-phase listener on `document`, and deliberately NO monkey-patching of `fetch` —
 * patching it breaks host pages and reads as hostile in store review. Day 1 uses accessible
 * names only; the PerformanceObserver confirmation step lands Day 2.
 *
 * Debounce is the difference between a useful tool and an uninstall: one digest per origin
 * per funnel stage per session, maximum.
 */
import type { FunnelStage } from "@/shared/schema";

const ATC_NAME = /\badd to (cart|bag|basket|order)\b|\badd item\b|\bbuy now\b|\badd to my bag\b/i;
const CHECKOUT_NAME =
  /\bcheckout\b|\bcheck out\b|\bplace order\b|\bcontinue to payment\b|\bproceed to\b|\bpay now\b|\bcomplete (order|purchase)\b|\bi'?ll reserve\b|\breserve (?:now|tickets?|room)\b|\bbook now\b|\bconfirm (?:and pay|booking|reservation)\b/i;

const ATC_ATTR_TOKENS = ["add-to-cart", "addtocart", "add_to_cart", "add-to-bag", "atc"];

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
    const v = el.getAttribute(attr)?.toLowerCase();
    if (v && ATC_ATTR_TOKENS.some((t) => v.includes(t))) return true;
  }
  return false;
}

export class TriggerWatcher {
  /** `${stage}` values already digested this session, for the debounce. */
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

  /** One digest per stage per session. Returns false if this stage already fired. */
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
