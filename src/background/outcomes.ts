/**
 * The add-to-cart outcome measure: for each technique, how often a page view that showed it
 * ended in an add-to-cart click — against a baseline of every page view on the same site.
 *
 * The owner asked for a success rate per technique, and this is the part of that question
 * a browser extension can honestly answer. Read the limits before reading the numbers:
 *
 *   It is ASSOCIATION, not effect. Pages that run countdowns differ from pages that do not
 *   in product, price, and why the shopper is there, and each of those moves the add rate.
 *   The `_page` baseline controls for the site, not for any of that.
 *
 *   The outcome is the CLICK. `TriggerWatcher` does not confirm the add succeeded (no size
 *   chosen, out of stock); see src/content/triggers.ts.
 *
 *   Exposure is ordered before the decision. A technique counts only if it cleared the
 *   salience gate BEFORE the click, because the view ends at the click — so a drawer that
 *   opens afterwards with "only 2 left" cannot be credited with the add that opened it.
 *
 *   Pensa's own card cannot contaminate a view's outcome: the card is shown in RESPONSE to the
 *   add-to-cart click, after this view has already ended. It can still change what a
 *   long-time user does on later pages, which is a limit of measuring from inside a tool that
 *   intervenes.
 *
 * Nothing here runs without consent. A view is not even held in memory until sharing is on,
 * for the same reason `enqueue` does not queue-then-discard.
 *
 * Views are kept in chrome.storage.local rather than storage.session so that closing the
 * browser does not silently drop every view that had not ended yet — those are almost all
 * non-adds, and losing them would inflate every rate.
 */
import { enqueueOutcomes, siteOf } from "@/background/telemetry";
import { ALLOWLIST_VERSION } from "@/shared/category";
import type { PageViewPayload } from "@/shared/messages";
import { type OutcomeRecord, PAGE_BASELINE, type Settings } from "@/shared/schema";
import { PATTERN_IDS } from "@/shared/taxonomy";

const STORAGE_KEY = "pensa:views";
/** A view with no activity for this long is over, and ended without an add. */
export const VIEW_IDLE_MS = 30 * 60 * 1000;
/** Bound on views held at once. The oldest is ended (as a non-add) to make room. */
export const MAX_OPEN_VIEWS = 300;

const KNOWN = new Set<string>(PATTERN_IDS);

interface OpenView {
  origin: string;
  stage: "browse" | "pdp";
  exposed: string[];
  startedAt: number;
  updatedAt: number;
}

type Views = Record<string, OpenView>;

/**
 * Every read-modify-write of the view store goes through this chain. Two tabs messaging at
 * once would otherwise both load the same object and the second save would erase the first
 * tab's view — silently, and always a view that had not ended, so always a non-add.
 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function load(): Promise<Views> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const v = got[STORAGE_KEY];
    return v && typeof v === "object" ? (v as Views) : {};
  } catch {
    return {};
  }
}

async function save(views: Views): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: views });
}

/** One baseline row plus one row per technique on screen before the decision. */
export function toOutcomes(view: OpenView, addedToCart: boolean): OutcomeRecord[] {
  const site = siteOf(view.origin);
  if (!site) return [];
  const base = {
    funnelStage: view.stage,
    site: site.site,
    originCategory: site.category,
    rulepackVersion: ALLOWLIST_VERSION,
    // The day the view STARTED. A view spanning midnight belongs to one day, not two.
    dayBucket: Math.floor(view.startedAt / 86_400_000),
    addedToCart,
  };
  return [
    { patternId: PAGE_BASELINE, ...base },
    ...view.exposed.map((p) => ({ patternId: p as OutcomeRecord["patternId"], ...base })),
  ];
}

/**
 * Apply one page-view message. Returns how many outcome rows were queued.
 *
 * The message is untrusted for what it may put in a record: only real pattern ids survive,
 * switched-off techniques are dropped (a technique the user turned off is not recorded at all,
 * which is what Settings promises), and stage is fixed at the first message for the view.
 */
export function notePageView(
  msg: PageViewPayload,
  settings: Settings,
  now = Date.now(),
): Promise<number> {
  if (!settings.telemetryConsent) return Promise.resolve(0);
  return serial(() => applyPageView(msg, settings, now));
}

async function applyPageView(
  msg: PageViewPayload,
  settings: Settings,
  now: number,
): Promise<number> {
  const views = await load();
  const ended: { view: OpenView; added: boolean }[] = [];

  // Sweep first, so an abandoned view from an hour ago is ended before this one is counted
  // against the cap.
  for (const [id, v] of Object.entries(views)) {
    if (now - v.updatedAt > VIEW_IDLE_MS) {
      ended.push({ view: v, added: false });
      delete views[id];
    }
  }

  const disabled = new Set(settings.disabledDetectors);
  const exposed = msg.exposed.filter((p) => KNOWN.has(p) && !disabled.has(p));

  const view: OpenView = views[msg.viewId] ?? {
    origin: msg.origin,
    stage: msg.stage,
    exposed: [],
    startedAt: now,
    updatedAt: now,
  };
  // A technique already counted for this view is not counted twice, and one the page stops
  // showing is not removed: it was on screen before the decision, which is what is measured.
  view.exposed = [...new Set([...view.exposed, ...exposed])].slice(0, 32);
  view.updatedAt = now;

  if (msg.addedToCart) {
    ended.push({ view, added: true });
    delete views[msg.viewId];
  } else {
    views[msg.viewId] = view;
  }

  const ids = Object.keys(views);
  if (ids.length > MAX_OPEN_VIEWS) {
    ids.sort((a, b) => (views[a]?.updatedAt ?? 0) - (views[b]?.updatedAt ?? 0));
    for (const id of ids.slice(0, ids.length - MAX_OPEN_VIEWS)) {
      const v = views[id];
      if (v) ended.push({ view: v, added: false });
      delete views[id];
    }
  }

  await save(views);
  return enqueueOutcomes(
    ended.flatMap(({ view: v, added }) => toOutcomes(v, added)),
    settings,
  );
}

/** End idle views. Run on the telemetry alarm, just before a flush. */
export function sweepViews(settings: Settings, now = Date.now()): Promise<number> {
  return serial(async () => {
    if (!settings.telemetryConsent) {
      await chrome.storage.local.remove(STORAGE_KEY).catch(() => undefined);
      return 0;
    }
    const views = await load();
    const ended: OpenView[] = [];
    for (const [id, v] of Object.entries(views)) {
      if (now - v.updatedAt > VIEW_IDLE_MS) {
        ended.push(v);
        delete views[id];
      }
    }
    if (ended.length === 0) return 0;
    await save(views);
    return enqueueOutcomes(
      ended.flatMap((v) => toOutcomes(v, false)),
      settings,
    );
  });
}

/** Forget every open view. On consent withdrawal and clear-all-data. */
export function discardViews(): Promise<void> {
  return serial(async () => {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch {
      // Nothing held is the same outcome as nothing to remove.
    }
  });
}
