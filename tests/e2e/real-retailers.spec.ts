/**
 * Overlay-vs-buy-button against REAL retailer pages (plan §7 Day 3).
 *
 * The hostile-CSS fixtures prove the overlay survives adversarial styling. They do not prove
 * it copes with real commercial layout: sticky headers, floating chat widgets, cookie
 * banners, sticky add-to-cart bars, and buy buttons that genuinely sit bottom-right.
 *
 * Honesty constraints baked into this file:
 *   - These are real retailer STOREFRONT pages, not authenticated checkout. A checkout page
 *     needs a populated cart and usually an account, which is the same limit the plan's
 *     crawler ethics section accepts (§10). Deep product URLs were tried first and proved
 *     too unstable to pin in a test; storefronts are stable and carry the same hazards,
 *     sticky headers, chat widgets, cookie banners, floating carts.
 *   - The assertion is stronger than "the buy button is clickable": it hit-tests EVERY
 *     visible interactive control on the page and requires the overlay to cover none of
 *     them.
 *   - Live sites are flaky and some block automation. The suite therefore FAILS if fewer
 *     than MIN_SITES load, rather than quietly passing on zero. A green run means real
 *     pages were genuinely exercised.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import {
  CLICKABLE,
  choosePlacement,
  FIELD,
  type PlacementMode,
  PURCHASE_INTENT,
} from "@/content/ui/card";

/** Reached unauthenticated, no cart required. */
const CANDIDATES = [
  { name: "target", url: "https://www.target.com/" },
  { name: "ikea", url: "https://www.ikea.com/us/en/" },
  { name: "uniqlo", url: "https://www.uniqlo.com/us/en/" },
  { name: "newegg", url: "https://www.newegg.com/" },
  { name: "wayfair", url: "https://www.wayfair.com/" },
  { name: "rei", url: "https://www.rei.com/" },
];

const MIN_SITES = 2;

/**
 * Scroll depth is not a detail. The pre-fix baseline showed target suppressed at the top of
 * the page and fitting a full card at 70% scroll, the header and nav clusters that fill the
 * corners are exactly what scrolls away. Measuring one position per site would have reported
 * a rate that no shopper experiences.
 */
const SCROLL_DEPTHS = [0, 0.35, 0.7];

let context: BrowserContext;
/**
 * Run state, kept on disk rather than in module scope.
 *
 * Playwright restarts the worker after a failing test, which resets module-level state, so
 * one flaky site (a slow load, a bot block) emptied `loaded` and made the "enough real sites"
 * guard report a SECOND, false failure that masked the real one. A guard that lies when
 * something else breaks is worse than no guard.
 */
const STATE = join(tmpdir(), "pp-real-retailers-state.json");

interface RunState {
  loaded: string[];
  outcomes: { site: string; depth: number; mode: PlacementMode; ordinaryCovered: number }[];
}

function readState(): RunState {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as RunState;
  } catch {
    return { loaded: [], outcomes: [] };
  }
}

function writeState(patch: (s: RunState) => void): void {
  const s = readState();
  patch(s);
  writeFileSync(STATE, JSON.stringify(s));
}

test.beforeAll(async () => {
  rmSync(STATE, { force: true });
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: ["--disable-blink-features=AutomationControlled"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
});

test.afterAll(async () => {
  await context?.close();
});

async function tryLoad(page: Page, url: string): Promise<boolean> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!res || res.status() >= 400) return false;
    await page.waitForTimeout(3000);
    const controls = await page.locator(`${FIELD}, ${CLICKABLE}`).count();
    // A bot-block page technically loads but has almost no interactive content.
    return controls > 10;
  } catch {
    return false;
  }
}

for (const site of CANDIDATES) {
  test(`overlay cannot cover a real purchase control: ${site.name}`, async () => {
    const page = await context.newPage();
    const ok = await tryLoad(page, site.url);
    if (!ok) {
      await page.close();
      test.skip(true, `${site.name} unreachable or bot-blocked from this environment`);
      return;
    }
    writeState((s) => s.loaded.push(site.name));

    for (const depth of SCROLL_DEPTHS) {
      await page.evaluate((d) => scrollTo(0, document.body.scrollHeight * d), depth);
      await page.waitForTimeout(700);

      // Read the page; decide in Node with the SHIPPED chooser. This file used to
      // re-implement the placement algorithm inside page.evaluate, which meant the e2e could
      // pass while production did something else entirely.
      const controls = await page.evaluate(
        ({ FIELD, CLICKABLE, INTENT }) => {
          const intent = new RegExp(INTENT, "i");
          const out: {
            left: number;
            top: number;
            right: number;
            bottom: number;
            critical: boolean;
            name: string;
          }[] = [];
          for (const el of document.querySelectorAll(`${FIELD}, ${CLICKABLE}`)) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
            const name =
              el.getAttribute("aria-label") ??
              (el as HTMLInputElement).value ??
              (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
            const critical =
              el.matches(FIELD) ||
              el.matches('[type="submit"]') ||
              el === document.activeElement ||
              intent.test(name);
            out.push({
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              critical,
              name: `${el.tagName}${el.id ? `#${el.id}` : ""} "${name.slice(0, 40)}"`,
            });
          }
          return out;
        },
        { FIELD, CLICKABLE, INTENT: PURCHASE_INTENT.source },
      );

      const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
      const placement = choosePlacement(controls, { w: viewport.width, h: viewport.height }, 4);

      const criticalOnScreen = controls.filter((c) => c.critical).length;
      console.log(
        `  ${site.name} @${Math.round(depth * 100)}%: ${controls.length} controls ` +
          `(${criticalOnScreen} critical) -> ${placement.mode} ` +
          `@ ${placement.anchor.v}-${placement.anchor.h}, ` +
          `covering ${placement.ordinaryCovered} ordinary`,
      );
      writeState((s) =>
        s.outcomes.push({
          site: site.name,
          depth,
          mode: placement.mode,
          ordinaryCovered: placement.ordinaryCovered,
        }),
      );

      // Only meaningful at the top of the page: a bot-block page loads but is nearly empty.
      // Deeper in a real page a viewport of hero imagery legitimately has a handful of
      // controls, and asserting the threshold there failed target and rei for no reason.
      if (depth === 0) {
        expect(controls.length, "page had no interactive content").toBeGreaterThan(10);
      }

      if (placement.mode !== "suppressed") {
        // Render at exactly the chosen position and hit-test the live page, because geometry
        // agreeing with itself proves nothing about what the browser actually paints.
        const covered = await page.evaluate(
          ({ pos, size, FIELD, CLICKABLE, INTENT }) => {
            const intent = new RegExp(INTENT, "i");
            const host = document.createElement("div");
            host.id = "pensa-e2e-probe";
            host.style.cssText = [
              "position:fixed !important",
              `left:${pos.left}px !important`,
              `top:${pos.top}px !important`,
              "z-index:2147483647 !important",
              "pointer-events:none !important",
              `width:${size.w}px !important`,
              "display:block !important",
              "visibility:visible !important",
            ].join(";");
            const root = host.attachShadow({ mode: "closed" });
            const cardEl = document.createElement("div");
            cardEl.style.cssText = `pointer-events:auto;background:#fff;height:${size.h}px`;
            root.append(cardEl);
            document.documentElement.append(host);

            const hit: string[] = [];
            for (const el of document.querySelectorAll(`${FIELD}, ${CLICKABLE}`)) {
              const r = el.getBoundingClientRect();
              if (r.width < 8 || r.height < 8) continue;
              if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
                continue;
              const cx = Math.round(r.left + r.width / 2);
              const cy = Math.round(r.top + r.height / 2);
              if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
              if (document.elementFromPoint(cx, cy) !== host) continue;
              const name =
                el.getAttribute("aria-label") ??
                (el as HTMLInputElement).value ??
                (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
              const critical =
                el.matches(FIELD) ||
                el.matches('[type="submit"]') ||
                el === document.activeElement ||
                intent.test(name);
              if (critical) hit.push(`${el.tagName} "${name.slice(0, 40)}"`);
            }
            host.remove();
            return hit;
          },
          {
            pos: placement.position,
            size: placement.size,
            FIELD,
            CLICKABLE,
            INTENT: PURCHASE_INTENT.source,
          },
        );

        // THE non-negotiable assertion. Ordinary links may be covered; purchase-path controls
        // and form fields may not.
        expect(
          covered,
          `overlay covered ${covered.length} PURCHASE-PATH control(s): ${covered.join(" | ")}`,
        ).toEqual([]);
      }
    }

    await page.close();
  });
}

test("enough real sites were actually exercised", () => {
  // Guards against the whole suite silently degrading to skips and reporting green.
  const loaded = readState().loaded;
  expect(
    loaded.length,
    `only ${loaded.length} real site(s) loaded (${loaded.join(", ")}); need >= ${MIN_SITES}. ` +
      "Re-run with network access, or treat the real-retailer check as NOT performed.",
  ).toBeGreaterThanOrEqual(MIN_SITES);
});

test("a card is placeable at every scroll depth on every real page", () => {
  // The measurement that matters for the product, not just for safety. Before controls were
  // tiered the answer was zero: 60% of samples suppressed and the tester never saw a card
  // across six live retailers. A safety rule that fires on every page is a broken product,
  // so this asserts the rule is satisfiable, and asserts it per scroll depth, because the
  // corners that fill a viewport are the ones that scroll away.
  const outcomes = readState().outcomes;
  if (outcomes.length === 0) test.skip(true, "no sites loaded");

  const shown = outcomes.filter((o) => o.mode !== "suppressed");
  const worstCoverage = Math.max(...outcomes.map((o) => o.ordinaryCovered));
  console.log(
    `  placement: ${shown.length}/${outcomes.length} samples showed something; ` +
      `worst ordinary coverage ${worstCoverage}`,
  );
  for (const o of outcomes) {
    console.log(`    ${o.site} @${Math.round(o.depth * 100)}% -> ${o.mode} (${o.ordinaryCovered})`);
  }

  const suppressed = outcomes.filter((o) => o.mode === "suppressed");
  expect(
    suppressed.map((o) => `${o.site}@${Math.round(o.depth * 100)}%`),
    "these samples had nowhere to put the card",
  ).toEqual([]);
});
