/**
 * Salience accounting (plan §5, T14).
 *
 * The product claim is "here are the patterns YOU faced." That claim is false for anything
 * that rendered below the fold and was never looked at. Time is accumulated only while the
 * tab is actually visible — a background tab left open for an hour must not manufacture
 * an hour of dwell.
 *
 * Candidates that fail the gate are still recorded, flagged `surfaced: false`. The gap
 * between detected and surfaced is itself the interesting measurement.
 */
import { SALIENCE_EPHEMERAL_MS, SALIENCE_MIN_RATIO, SALIENCE_STATIC_MS } from "@/shared/constants";

export interface SalienceRecord {
  visibleMs: number;
  viewportFraction: number;
  scrollDepthAtFirstView: number;
  ephemeral: boolean;
  firstSeenAt: number | null;
  lastEnteredAt: number | null;
}

function empty(): SalienceRecord {
  return {
    visibleMs: 0,
    viewportFraction: 0,
    scrollDepthAtFirstView: 0,
    ephemeral: false,
    firstSeenAt: null,
    lastEnteredAt: null,
  };
}

export class SalienceTracker {
  private readonly records = new Map<string, SalienceRecord>();
  private readonly observed = new Map<Element, string>();
  private readonly io: IntersectionObserver;
  private docVisible = true;

  constructor(private readonly win: Window = window) {
    this.io = new IntersectionObserver(
      (entries: IntersectionObserverEntry[]) => this.onIntersect(entries),
      {
        threshold: [0, 0.25, 0.5, 1.0],
      },
    );

    win.document.addEventListener("visibilitychange", () => {
      const nowVisible = win.document.visibilityState === "visible";
      if (!nowVisible) this.pauseAll();
      this.docVisible = nowVisible;
    });
  }

  observe(el: Element, key: string, ephemeral = false): void {
    if (this.observed.has(el)) return;
    this.observed.set(el, key);
    const rec = this.records.get(key) ?? empty();
    rec.ephemeral = rec.ephemeral || ephemeral;
    this.records.set(key, rec);
    this.io.observe(el);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    const now = performance.now();
    for (const e of entries) {
      const key = this.observed.get(e.target);
      if (!key) continue;
      const rec = this.records.get(key) ?? empty();

      const qualifying = e.intersectionRatio >= SALIENCE_MIN_RATIO && this.docVisible;

      if (qualifying && rec.lastEnteredAt === null) {
        rec.lastEnteredAt = now;
        if (rec.firstSeenAt === null) {
          rec.firstSeenAt = now;
          rec.scrollDepthAtFirstView = this.scrollDepth();
        }
      } else if (!qualifying && rec.lastEnteredAt !== null) {
        rec.visibleMs += now - rec.lastEnteredAt;
        rec.lastEnteredAt = null;
      }

      rec.viewportFraction = Math.max(rec.viewportFraction, e.intersectionRatio);
      this.records.set(key, rec);
    }
  }

  private pauseAll(): void {
    const now = performance.now();
    for (const rec of this.records.values()) {
      if (rec.lastEnteredAt !== null) {
        rec.visibleMs += now - rec.lastEnteredAt;
        rec.lastEnteredAt = null;
      }
    }
  }

  private scrollDepth(): number {
    const doc = this.win.document.documentElement;
    const max = doc.scrollHeight - this.win.innerHeight;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, this.win.scrollY / max));
  }

  /** Snapshot with in-flight intervals settled, without mutating the running totals. */
  get(key: string): SalienceRecord {
    const rec = this.records.get(key);
    if (!rec) return empty();
    const live = { ...rec };
    if (live.lastEnteredAt !== null) {
      live.visibleMs += performance.now() - live.lastEnteredAt;
    }
    return live;
  }

  passesGate(key: string): boolean {
    const rec = this.get(key);
    const threshold = rec.ephemeral ? SALIENCE_EPHEMERAL_MS : SALIENCE_STATIC_MS;
    return rec.visibleMs >= threshold;
  }

  disconnect(): void {
    this.io.disconnect();
    this.observed.clear();
  }
}
