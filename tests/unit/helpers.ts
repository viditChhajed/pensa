import { harvest, readDocumentMeta } from "@/content/harvest";
import type { CandidateNode, PageContext } from "@/content/types";
import type { FunnelStage } from "@/shared/schema";

/**
 * Build a PageContext from an HTML string.
 *
 * jsdom returns zeroed boxes and default computed styles, so harvested snapshots are patched
 * to values a real browser would report. That this is possible at all is the payoff of the
 * read/write phase separation: detectors are pure functions over plain data, so a fixture is
 * just data and no headless engine needs to lay anything out.
 */
export function contextFrom(
  html: string,
  opts: {
    url?: string;
    stage?: FunnelStage;
    patch?: (n: CandidateNode, el: Element | null) => void;
  } = {},
): PageContext {
  const url = opts.url ?? "https://shop.example.com/products/thing";
  const stage = opts.stage ?? "pdp";

  document.body.innerHTML = html;
  const meta = readDocumentMeta(document, url);
  const candidates = harvest(document);

  for (const n of candidates) {
    // Give every node a plausible rendered box so `isRendered` passes.
    (n as { box: CandidateNode["box"] }).box = { x: 0, y: 100, w: 200, h: 24 };

    let el: Element | null = null;
    try {
      el = document.querySelector(n.selectorPath);
    } catch {
      el = null;
    }
    opts.patch?.(n, el);
  }

  return {
    candidates,
    meta,
    funnelStage: stage,
    now: 0,
    viewport: { w: 1280, h: 900 },
  };
}

/** jsdom does not compute `line-through` from `<del>`/`<s>`; apply what a browser reports. */
export function applyStrike(n: CandidateNode, el: Element | null): void {
  if (!el) return;
  if (el.closest("del, s, strike")) {
    (n.style as { textDecorationLine: string }).textDecorationLine = "line-through";
  }
}

/** Mark a node as an injected-then-removed toast, as the observer would. */
export function markEphemeral(n: CandidateNode, insertedAt: number, removedAt: number): void {
  const m = n as unknown as {
    ephemeral: boolean;
    insertedAt: number | null;
    removedAt: number | null;
  };
  m.ephemeral = true;
  m.insertedAt = insertedAt;
  m.removedAt = removedAt;
}

/** Attach a text history, as the observer would for a mutating node. */
export function withTextHistory(n: CandidateNode, history: { t: number; text: string }[]): void {
  (n as unknown as { textHistory: { t: number; text: string }[] }).textHistory = history;
}
