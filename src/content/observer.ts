/**
 * MutationObserver orchestration (plan §18C, T11 support).
 *
 * Two jobs the detectors cannot do for themselves, because they are pure functions with no
 * access to time:
 *   1. Record text histories for nodes that mutate, so the countdown detector can see a
 *      decrement rather than a single frozen frame.
 *   2. Record insertion/removal times, so a live-activity toast that self-removes in 8s is
 *      distinguishable from a static banner.
 *
 * Mutations coalesce into a dirty-root set; nothing is re-scanned per record.
 */
import type { TextObservation } from "./types";

const MAX_HISTORY = 12;
const EPHEMERAL_WINDOW_MS = 15_000;

export interface ObserverState {
  textHistories: Map<Element, TextObservation[]>;
  ephemeral: Map<Element, { insertedAt: number; removedAt: number | null }>;
  dirtyRoots: Set<Element>;
}

export class PageObserver {
  readonly state: ObserverState = {
    textHistories: new Map(),
    ephemeral: new Map(),
    dirtyRoots: new Set(),
  };

  private mo: MutationObserver | null = null;
  private scheduled = false;

  constructor(private readonly onDirty: () => void) {}

  start(root: Node = document.body): void {
    if (!root) return;
    this.mo = new MutationObserver((records) => this.handle(records));
    this.mo.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["checked", "aria-checked", "class", "style", "hidden"],
    });
  }

  private handle(records: MutationRecord[]): void {
    const now = performance.now();

    for (const r of records) {
      if (r.type === "characterData") {
        const el = r.target.parentElement;
        if (el) this.recordText(el, now);
        if (el) this.state.dirtyRoots.add(el);
        continue;
      }

      if (r.type === "childList") {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          this.state.ephemeral.set(el, { insertedAt: now, removedAt: null });
          this.state.dirtyRoots.add(el);
          this.recordText(el, now);
        }
        for (const node of r.removedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          const rec = this.state.ephemeral.get(el);
          if (rec && now - rec.insertedAt < EPHEMERAL_WINDOW_MS) rec.removedAt = now;
        }
        const parent = r.target instanceof Element ? r.target : null;
        if (parent) this.state.dirtyRoots.add(parent);
        continue;
      }

      if (r.target instanceof Element) this.state.dirtyRoots.add(r.target);
    }

    if (!this.scheduled && this.state.dirtyRoots.size > 0) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.onDirty();
      });
    }
  }

  private recordText(el: Element, t: number): void {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || text.length > 120) return;
    // Only worth tracking things that could plausibly be a clock.
    if (!/\d/.test(text)) return;

    let hist = this.state.textHistories.get(el);
    if (!hist) {
      hist = [];
      this.state.textHistories.set(el, hist);
    }
    const last = hist[hist.length - 1];
    if (last && last.text === text) return;
    hist.push({ t, text });
    if (hist.length > MAX_HISTORY) hist.shift();
  }

  takeDirtyRoots(): Element[] {
    const roots = [...this.state.dirtyRoots];
    this.state.dirtyRoots.clear();
    return roots;
  }

  stop(): void {
    this.mo?.disconnect();
    this.mo = null;
  }
}
