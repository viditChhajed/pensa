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
import { selectorPath } from "./harvest";
import type { TextObservation } from "./types";

const MAX_HISTORY = 12;
const EPHEMERAL_WINDOW_MS = 15_000;

export interface ObserverState {
  textHistories: Map<Element, TextObservation[]>;
  ephemeral: Map<Element, { insertedAt: number; removedAt: number | null }>;
  dirtyRoots: Set<Element>;
  /** Modal/interstitial insertions this page-session. Feeds the nagging detector. */
  modalsInsertedAt: number[];
  /** Last mouseleave toward the viewport top, or a visibilitychange to hidden. */
  lastExitIntentAt: number | null;
  /** selectorPaths of modals that appeared inside the exit-intent window. */
  exitIntentModals: string[];
}

/** Within this of an exit gesture, a modal insertion is treated as a response to it. */
export const EXIT_INTENT_WINDOW_MS = 500;

export class PageObserver {
  readonly state: ObserverState = {
    textHistories: new Map(),
    ephemeral: new Map(),
    dirtyRoots: new Set(),
    modalsInsertedAt: [],
    lastExitIntentAt: null,
    exitIntentModals: [],
  };

  private mo: MutationObserver | null = null;
  private scheduled = false;

  constructor(private readonly onDirty: () => void) {}

  start(root: Node = document.body): void {
    if (!root) return;

    // Exit intent: the pointer leaving toward the top of the viewport, or the tab being
    // hidden. Recorded here rather than in the detector because a pure function has no clock.
    document.addEventListener(
      "mouseout",
      (e) => {
        const ev = e as MouseEvent;
        if (ev.relatedTarget !== null) return; // still inside the document
        if (ev.clientY > 40) return; // leaving sideways or downward is not exit intent
        this.state.lastExitIntentAt = performance.now();
      },
      { passive: true },
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "hidden") {
          this.state.lastExitIntentAt = performance.now();
        }
      },
      { passive: true },
    );
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

          if (this.looksModal(el)) {
            this.state.modalsInsertedAt.push(now);
            if (this.state.modalsInsertedAt.length > 32) this.state.modalsInsertedAt.shift();

            const since =
              this.state.lastExitIntentAt === null
                ? Number.POSITIVE_INFINITY
                : now - this.state.lastExitIntentAt;
            if (since <= EXIT_INTENT_WINDOW_MS) {
              this.state.exitIntentModals.push(selectorPath(el));
              if (this.state.exitIntentModals.length > 16) this.state.exitIntentModals.shift();
            }
          }
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

  /**
   * Modal-ish: an explicit dialog role, or a fixed/absolute overlay covering a large share of
   * the viewport. Read here in the observer, where reading layout is already happening.
   */
  private looksModal(el: Element): boolean {
    /**
     * A modal has to be SHOWING. This check did not require that, and the cost was measured:
     * `nagging.repeat_interstitial` fired 22 times on a single Glossier session, reporting
     * "7 interstitials" on a page that showed none.
     *
     * Two faults, both the same shape — treating presence in the DOM as presence on screen:
     *
     *   `querySelector('dialog')` matched any element CONTAINING a dialog anywhere in its
     *   subtree, and sites keep closed dialogs mounted permanently. Every wrapper inserted
     *   above one therefore counted as an interstitial appearing.
     *
     *   Nothing was checked for visibility at all, so a `display:none` overlay, an unopened
     *   `<dialog>`, and a real interstitial were indistinguishable.
     *
     * Nagging is a claim that a person was interrupted repeatedly. Counting things they were
     * never shown does not weaken the claim, it fabricates it.
     */
    if (!this.isShowing(el)) return false;

    const role = el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (el.tagName === "DIALOG") return (el as HTMLDialogElement).open === true;
    if (el.getAttribute("aria-modal") === "true") return true;

    // A dialog inside this element counts only if THAT dialog is itself open and showing.
    for (const inner of el.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')) {
      if (inner.tagName === "DIALOG" && (inner as HTMLDialogElement).open !== true) continue;
      if (this.isShowing(inner)) return true;
    }

    try {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") return false;
      const r = el.getBoundingClientRect();
      const coverage = (r.width * r.height) / Math.max(1, window.innerWidth * window.innerHeight);
      return coverage > 0.25 && Number.parseInt(cs.zIndex || "0", 10) > 100;
    } catch {
      return false;
    }
  }

  /** Rendered and not hidden. Cheap, and the thing `looksModal` was missing entirely. */
  private isShowing(el: Element): boolean {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (Number.parseFloat(cs.opacity || "1") < 0.05) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    } catch {
      return false;
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
