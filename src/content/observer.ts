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

/**
 * Ceiling on how many elements the text-history and ephemeral maps may hold.
 *
 * Both are `Map<Element, …>` and nothing used to remove from either, so on a long-lived page —
 * a chat app, a feed, anything that rewrites itself for hours — they grew without bound and
 * kept every detached element alive. When a map passes this size, disconnected elements past
 * their useful window go first, then the oldest entries, down to three quarters of the cap.
 */
const MAX_TRACKED_ELEMENTS = 2000;

/**
 * A modal counts once, when it becomes visible. If it is hidden and shown AGAIN after this
 * long, that is a second interruption and counts again — the same newsletter popup coming
 * back is the literal shape of nagging. The floor is there because modals flicker while they
 * animate, and a fade-out/fade-in must not read as two visits.
 */
const RESHOW_GAP_MS = 1_500;
/** Mounted-but-hidden modals kept under watch in case the page reveals one later. */
const MAX_WATCHED_MODALS = 12;
/** How far up to look for the modal this element is merely a part of. See outermostModal. */
const MAX_NEST_WALK = 6;
/** Floor between full re-checks of the watched set, so the style reads stay bounded. */
const WATCH_SWEEP_MS = 300;
/**
 * A modal that appears this soon after a click or a keypress was ASKED for — a bag drawer, a
 * size guide, a search overlay. Plenty of them carry `role="dialog"`, and counting those as
 * interruptions would be the same fabrication in a new costume: nagging is about what the
 * page imposes, not about what the shopper opened.
 */
const SHOPPER_REQUEST_WINDOW_MS = 750;

/** What is known about one modal-shaped element across the life of the page. */
interface ModalWatch {
  /**
   * Observed showing at least once. Counted at that moment, unless the shopper had just
   * asked for it, or it was already on screen when we arrived.
   */
  shown: boolean;
  /** When it was last seen NOT showing, or null while it is showing. Gates a re-show. */
  hiddenSince: number | null;
}

export interface ObserverState {
  textHistories: Map<Element, TextObservation[]>;
  ephemeral: Map<Element, { insertedAt: number; removedAt: number | null }>;
  dirtyRoots: Set<Element>;
  /**
   * When each modal/interstitial BECAME VISIBLE this page-session. Feeds the nagging detector.
   *
   * The name is now half a lie and is kept anyway: it is the shared `PageSignals` contract,
   * and renaming a field across the content script for accuracy of wording is not worth a
   * merge conflict with work in flight. What it means is documented here rather than implied
   * by a name — insertion is no longer the event, appearing on screen is.
   */
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

  /**
   * Whether page text and insertion times are kept at all.
   *
   * Off until the detector has confirmed the page is a shop. Before that, the observer still
   * notices that the page changed (so a storefront that renders late gets re-checked) and
   * still tracks modal appearances (timestamps and element references only, capped), but it
   * holds no text. On a page that never turns out to be a shop — a chat, an inbox, a document
   * — nothing it displayed is ever copied into memory by Pensa.
   */
  private recording = false;

  /** Every modal-shaped element this page has shown us, and what we have seen it do. */
  private readonly modalWatch = new Map<Element, ModalWatch>();
  private lastWatchSweepAt = 0;
  /** Last pointerdown or keydown anywhere on the page. See SHOPPER_REQUEST_WINDOW_MS. */
  private lastGestureAt: number | null = null;

  constructor(private readonly onDirty: () => void) {}

  /** Begin keeping text histories and insertion times. Called once the page is a shop. */
  startRecording(): void {
    this.recording = true;
  }

  start(root: Node = document.body): void {
    if (!root) return;

    // Was a modal imposed, or opened? Recorded here for the same reason exit intent is: a
    // pure detector has no clock and cannot know what the shopper did a moment ago.
    // Capturing, because a page that stops propagation on its own overlay would otherwise
    // make every click it handles invisible to us.
    for (const kind of ["pointerdown", "keydown"] as const) {
      document.addEventListener(
        kind,
        () => {
          this.lastGestureAt = performance.now();
        },
        { capture: true, passive: true },
      );
    }

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
    this.adoptPreMounted(root);
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
    let sawAttributes = false;

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
          if (this.recording) this.state.ephemeral.set(el, { insertedAt: now, removedAt: null });
          this.state.dirtyRoots.add(el);
          this.recordText(el, now);

          this.considerModal(el, now);
        }
        for (const node of r.removedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          const rec = this.state.ephemeral.get(el);
          if (rec && now - rec.insertedAt < EPHEMERAL_WINDOW_MS) rec.removedAt = now;
          // A modal torn out of the document has stopped interrupting anybody. Recorded so
          // that putting it back later reads as the second interruption it is.
          const watch = this.modalWatch.get(el);
          if (watch && watch.hiddenSince === null) watch.hiddenSince = now;
        }
        const parent = r.target instanceof Element ? r.target : null;
        if (parent) this.state.dirtyRoots.add(parent);
        continue;
      }

      if (r.target instanceof Element) {
        this.state.dirtyRoots.add(r.target);
        // A modal is normally revealed by a class, a style or `hidden` landing on the modal
        // itself, so that case is answered immediately and exactly. Anything else might have
        // revealed one from an ancestor, which only the sweep can see — and the sweep is
        // throttled, because attribute mutations arrive continuously on a live page and
        // reading layout on every one of them is how a content script becomes the jank.
        if (this.modalWatch.has(r.target) || this.hasDialogSignature(r.target)) {
          this.considerModal(r.target, now);
        } else {
          sawAttributes = true;
        }
      }
    }

    if (sawAttributes) this.sweepWatched(now);
    this.prune(now);

    if (!this.scheduled && this.state.dirtyRoots.size > 0) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.onDirty();
      });
    }
  }

  /**
   * Decide what one element means for the interruption count.
   *
   * The unit being counted used to be an INSERTION, and that was the second bug in this file
   * — the first fix (49e7995, "Stop nagging fabricating interruptions nobody saw") added the
   * visibility check but left the event wrong, which took the count from a fabricated 7 to a
   * still-wrong 2. A live re-probe of the two sites that flagged it says exactly where the
   * extra one comes from, and it is not the hidden "Customise preferences" panel the
   * visibility check already rejects:
   *
   *   boohoo.com / prettylittlething.us — `div.cky-overlay`, the dim scrim, is inserted as a
   *   sibling of the banner. Empty, full-viewport, fixed, z-index above everything: the
   *   overlay branch below calls it a modal. Then the banner arrives and is called one too.
   *   One cookie notice, two "interstitials".
   *
   *   temu.com — the same shape inverted: an empty full-viewport wrapper is inserted first
   *   and the CAPTCHA card is inserted INTO it a moment later. Parent and child, counted
   *   separately. One security check, two "interstitials".
   *
   * Both are a single interruption wearing two elements, and `FLAG_AT = 2` means that
   * off-by-one is the whole difference between silence and a card. Nearly every consent
   * vendor on the web ships a scrim, so this fired on a large share of all shops for one
   * banner that every one of those shops shows.
   *
   * So: a scrim is not a message (`isBackdrop`), a wrapper and its contents are one thing
   * (`partOfShownModal`), and the event is the modal APPEARING rather than being inserted —
   * which also, at last, counts the newsletter popup that was mounted hidden at load and
   * revealed ten seconds later, and the one that is hidden and brought back.
   */
  private considerModal(el: Element, now: number): void {
    const showing = this.looksModal(el);
    const watch = this.modalWatch.get(el);

    if (!showing) {
      if (watch) {
        if (watch.hiddenSince === null) watch.hiddenSince = now;
      } else if (this.hasDialogSignature(el)) {
        // Mounted hidden. Not an interruption yet, and it may never be one — but a reveal is
        // one click away and there is no insertion left to catch it by.
        this.watchModal(el, { shown: false, hiddenSince: now });
      }
      return;
    }

    if (watch?.shown) {
      // Back on screen. Only a second interruption if it genuinely went away first.
      if (watch.hiddenSince !== null && now - watch.hiddenSince >= RESHOW_GAP_MS) {
        this.recordModal(el, now);
      }
      watch.hiddenSince = null;
      return;
    }

    if (this.isBackdrop(el)) return;
    if (this.partOfShownModal(el)) return;

    /**
     * The interruption is the OUTERMOST modal-shaped element, not whichever half of it the
     * mutation happened to name. Attributing rather than merely suppressing matters: a wrapper
     * that was empty when it arrived was rejected as a backdrop and never recorded, so
     * suppressing its child too would count temu's CAPTCHA as zero interruptions instead of
     * one.
     */
    const outer = this.outermostModal(el);
    if (outer !== el) {
      this.watchModal(el, { shown: true, hiddenSince: null });
      if (this.modalWatch.get(outer)?.shown === true) return;
      this.watchModal(outer, { shown: true, hiddenSince: null });
      this.recordModal(outer, now);
      return;
    }

    // Marked shown whether or not it is recorded: a modal the shopper opened has been dealt
    // with, and must not be counted by the next sweep once the click window has passed.
    this.watchModal(el, { shown: true, hiddenSince: null });
    this.recordModal(el, now);
  }

  /** The one place an interruption is actually written down. */
  private recordModal(el: Element, now: number): void {
    const sinceExit =
      this.state.lastExitIntentAt === null
        ? Number.POSITIVE_INFINITY
        : now - this.state.lastExitIntentAt;
    const onExit = sinceExit <= EXIT_INTENT_WINDOW_MS;

    // Asked for, not imposed — unless it answered an exit gesture, which is the one case
    // where a modal arriving right after the shopper did something is the point.
    if (
      !onExit &&
      this.lastGestureAt !== null &&
      now - this.lastGestureAt < SHOPPER_REQUEST_WINDOW_MS
    ) {
      return;
    }

    this.state.modalsInsertedAt.push(now);
    if (this.state.modalsInsertedAt.length > 32) this.state.modalsInsertedAt.shift();

    if (onExit) {
      this.state.exitIntentModals.push(selectorPath(el));
      if (this.state.exitIntentModals.length > 16) this.state.exitIntentModals.shift();
    }
  }

  /**
   * A scrim dims; an interstitial says something. An element with no text and nothing to
   * click is the dark rectangle behind the modal, not the modal — and counting the furniture
   * of one interruption as a second interruption is what this whole fix is about.
   */
  private isBackdrop(el: Element): boolean {
    if ((el.textContent ?? "").trim().length > 0) return false;
    return (
      el.querySelector(
        'button, a[href], input, select, textarea, img, svg, video, [role="button"]',
      ) === null
    );
  }

  /**
   * Which element IS the interruption this one belongs to?
   *
   * `partOfShownModal` only suppresses a pair when one half is on the watch list by the time
   * the other is judged, and that is an ordering assumption the web does not honour. Glossier
   * broke it: OneTrust wraps `div.ot-sdk-container[role=dialog]` (456x145) in
   * `div#onetrust-banner-sdk` (458x147), the wrapper qualifies through the
   * contains-a-showing-dialog branch, the child qualifies through its own role, and depending
   * on how the vendor reveals them neither is necessarily recorded first. Two elements 2px
   * apart, one cookie banner, "2 interstitials" — and OneTrust is on a large share of the web
   * while FLAG_AT is 2.
   *
   * So containment is answered structurally instead of historically: the outermost
   * modal-shaped element is the interruption, and anything nested inside one is furniture.
   * It returns the element to credit rather than a boolean, because the outer one may never
   * have been recorded — an empty wrapper is a backdrop when it arrives and a modal once its
   * contents land.
   * The walk is bounded because this runs on mutations, and an unbounded climb reading
   * computed style at each step is how a content script becomes the jank it is measuring.
   */
  private outermostModal(el: Element): Element {
    let found = el;
    let parent = el.parentElement;
    for (let depth = 0; parent !== null && depth < MAX_NEST_WALK; depth++) {
      if (parent === document.body || parent === document.documentElement) break;
      // A scrim is skipped over rather than selected: it is not the message, but the thing
      // it dims may still be wrapped in something that is.
      if (this.looksModal(parent) && !this.isBackdrop(parent)) found = parent;
      parent = parent.parentElement;
    }
    return found;
  }

  /** A wrapper around, or a panel inside, something already counted. Same interruption. */
  private partOfShownModal(el: Element): boolean {
    for (const [prev, watch] of this.modalWatch) {
      if (!prev.isConnected) {
        this.modalWatch.delete(prev);
        continue;
      }
      if (!watch.shown || prev === el) continue;
      if (prev.contains(el) || el.contains(prev)) return true;
    }
    return false;
  }

  /** Attributes only — no layout is read, because this runs on every attribute mutation. */
  private hasDialogSignature(el: Element): boolean {
    const role = el.getAttribute("role");
    return (
      role === "dialog" ||
      role === "alertdialog" ||
      el.tagName === "DIALOG" ||
      el.getAttribute("aria-modal") === "true"
    );
  }

  private watchModal(el: Element, watch: ModalWatch): void {
    this.modalWatch.set(el, watch);
    if (this.modalWatch.size <= MAX_WATCHED_MODALS * 2) return;
    const oldest = this.modalWatch.keys().next();
    if (!oldest.done) this.modalWatch.delete(oldest.value);
  }

  /** Re-check everything under watch, in case an ancestor's class is what moved. */
  private sweepWatched(now: number): void {
    if (this.modalWatch.size === 0) return;
    if (now - this.lastWatchSweepAt < WATCH_SWEEP_MS) return;
    this.lastWatchSweepAt = now;
    for (const el of [...this.modalWatch.keys()]) {
      if (!el.isConnected) {
        const watch = this.modalWatch.get(el);
        if (watch && watch.hiddenSince === null) watch.hiddenSince = now;
        continue;
      }
      this.considerModal(el, now);
    }
  }

  /**
   * Modals already in the document when we arrive.
   *
   * The hidden ones go under watch, so a reveal later counts. The ones already on screen are
   * recorded as shown and never counted: we did not watch that one arrive, and the page
   * opening with a dialog up is its opening state, not an interruption we can attest to.
   * Being wrong in this direction costs a miss; being wrong in the other costs a claim that
   * somebody was interrupted when nobody was, and this detector has already made that claim
   * once in the field.
   */
  private adoptPreMounted(root: Node): void {
    const scope = root as Partial<ParentNode>;
    if (typeof scope.querySelectorAll !== "function") return;
    const now = performance.now();
    let n = 0;
    for (const el of scope.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]',
    )) {
      if (n >= MAX_WATCHED_MODALS) break;
      const showing = this.isShowing(el);
      this.modalWatch.set(el, { shown: showing, hiddenSince: showing ? null : now });
      n++;
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

  /** See MAX_TRACKED_ELEMENTS. Cheap when under the cap, which is almost always. */
  private prune(now: number): void {
    const target = Math.floor(MAX_TRACKED_ELEMENTS * 0.75);

    const histories = this.state.textHistories;
    if (histories.size > MAX_TRACKED_ELEMENTS) {
      for (const el of histories.keys()) {
        if (histories.size <= target) break;
        if (!el.isConnected) histories.delete(el);
      }
      for (const el of histories.keys()) {
        if (histories.size <= target) break;
        histories.delete(el);
      }
    }

    const ephemeral = this.state.ephemeral;
    if (ephemeral.size > MAX_TRACKED_ELEMENTS) {
      // A removed toast is still evidence for EPHEMERAL_WINDOW_MS after it goes, so only
      // disconnected entries older than that window are safe to drop first.
      for (const [el, rec] of ephemeral) {
        if (ephemeral.size <= target) break;
        const since = rec.removedAt ?? rec.insertedAt;
        if (!el.isConnected && now - since > EPHEMERAL_WINDOW_MS) ephemeral.delete(el);
      }
      for (const el of ephemeral.keys()) {
        if (ephemeral.size <= target) break;
        ephemeral.delete(el);
      }
    }
  }

  private recordText(el: Element, t: number): void {
    if (!this.recording) return;
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
