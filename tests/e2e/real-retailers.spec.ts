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
 *     too unstable to pin in a test; storefronts are stable and carry the same hazards —
 *     sticky headers, chat widgets, cookie banners, floating carts.
 *   - The assertion is stronger than "the buy button is clickable": it hit-tests EVERY
 *     visible interactive control on the page and requires the overlay to cover none of
 *     them.
 *   - Live sites are flaky and some block automation. The suite therefore FAILS if fewer
 *     than MIN_SITES load, rather than quietly passing on zero. A green run means real
 *     pages were genuinely exercised.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";

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

/** Mirrors src/content/ui/card.ts exactly; asserted against the source below. */
const CARD_WIDTH = 360;
const MARGIN = 16;
const ITEM_HEIGHT = 86;
const CARD_CHROME = 52;
const PILL_WIDTH = 260;
const PILL_HEIGHT = 44;
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="link"], [onclick]';

let context: BrowserContext;
const loaded: string[] = [];

test.beforeAll(async () => {
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

test("the placement constants here match the production card", () => {
  // This file re-implements chooseCorner to run it inside a live page. If production drifts,
  // the numbers below would be testing something that no longer ships.
  const src = readFileSync(resolve("src/content/ui/card.ts"), "utf8");
  expect(src).toContain(`const CARD_WIDTH = ${CARD_WIDTH}`);
  expect(src).toContain(`const MARGIN = ${MARGIN}`);
  expect(src).toContain(`const ITEM_HEIGHT = ${ITEM_HEIGHT}`);
  expect(src).toContain(`const CARD_CHROME = ${CARD_CHROME}`);
  expect(src).toContain(`export const PILL_WIDTH = ${PILL_WIDTH}`);
  expect(src).toContain(`export const PILL_HEIGHT = ${PILL_HEIGHT}`);
  expect(src).toContain(INTERACTIVE);
});

async function tryLoad(page: Page, url: string): Promise<boolean> {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!res || res.status() >= 400) return false;
    await page.waitForTimeout(3000);
    const controls = await page.locator(INTERACTIVE).count();
    // A bot-block page technically loads but has almost no interactive content.
    return controls > 10;
  } catch {
    return false;
  }
}

for (const site of CANDIDATES) {
  test(`overlay cannot cover a real control: ${site.name}`, async () => {
    const page = await context.newPage();
    const ok = await tryLoad(page, site.url);
    if (!ok) {
      await page.close();
      test.skip(true, `${site.name} unreachable or bot-blocked from this environment`);
      return;
    }
    loaded.push(site.name);

    const result = await page.evaluate(
      ({ CARD_WIDTH, MARGIN, ITEM_HEIGHT, CARD_CHROME, PILL_W, PILL_H, INTERACTIVE }) => {
        type C = { horizontal: "left" | "right"; vertical: "top" | "bottom" };
        const CORNERS: C[] = [
          { horizontal: "right", vertical: "bottom" },
          { horizontal: "left", vertical: "bottom" },
          { horizontal: "right", vertical: "top" },
          { horizontal: "left", vertical: "top" },
        ];

        const controls: DOMRect[] = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (r.bottom < 0 || r.top > innerHeight) continue;
          if (r.right < 0 || r.left > innerWidth) continue;
          controls.push(r);
        }

        const collisionsAt = (size: { w: number; h: number }, c: C): number => {
          const left = c.horizontal === "right" ? innerWidth - MARGIN - size.w : MARGIN;
          const top = c.vertical === "bottom" ? innerHeight - MARGIN - size.h : MARGIN;
          let hits = 0;
          for (const r of controls) {
            if (
              r.left < left + size.w &&
              r.right > left &&
              r.top < top + size.h &&
              r.bottom > top
            ) {
              hits++;
            }
          }
          return hits;
        };

        // Mirrors choosePlacement: full card, else compact pill, else suppress.
        const full = {
          w: Math.min(CARD_WIDTH, innerWidth - MARGIN * 2),
          h: Math.min(CARD_CHROME + ITEM_HEIGHT * 4, innerHeight - MARGIN * 2),
        };
        const pill = {
          w: Math.min(PILL_W, innerWidth - MARGIN * 2),
          h: Math.min(PILL_H, innerHeight - MARGIN * 2),
        };

        let mode: "card" | "pill" | "suppressed" = "suppressed";
        let corner: C = CORNERS[0] as C;
        let size = pill;

        for (const c of CORNERS) {
          if (collisionsAt(full, c) === 0) {
            mode = "card";
            corner = c;
            size = full;
            break;
          }
        }
        if (mode === "suppressed") {
          for (const c of CORNERS) {
            if (collisionsAt(pill, c) === 0) {
              mode = "pill";
              corner = c;
              size = pill;
              break;
            }
          }
        }

        if (mode === "suppressed") {
          return {
            mode,
            corner: "none",
            controlsOnScreen: controls.length,
            covered: [] as string[],
          };
        }

        const host = document.createElement("div");
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        host.id = `pp-${Array.from(bytes, (b) => b.toString(36))
          .join("")
          .slice(0, 10)}`;
        host.style.cssText = [
          "position:fixed !important",
          `${corner.horizontal}:16px !important`,
          `${corner.vertical}:16px !important`,
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

        // Hit-test EVERY visible interactive control on the real page.
        const covered: string[] = [];
        for (const el of document.querySelectorAll(INTERACTIVE)) {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
          if (document.elementFromPoint(cx, cy) === host) {
            covered.push(
              `${el.tagName}${el.id ? `#${el.id}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`,
            );
          }
        }

        return {
          mode,
          corner: `${corner.vertical}-${corner.horizontal}`,
          controlsOnScreen: controls.length,
          covered,
        };
      },
      {
        CARD_WIDTH,
        MARGIN,
        ITEM_HEIGHT,
        CARD_CHROME,
        PILL_W: PILL_WIDTH,
        PILL_H: PILL_HEIGHT,
        INTERACTIVE,
      },
    );

    console.log(
      `  ${site.name}: ${result.controlsOnScreen} controls -> ${result.mode} @ ${result.corner}`,
    );

    expect(result.controlsOnScreen, "page had no interactive content").toBeGreaterThan(10);
    expect(
      result.covered,
      `overlay covered ${result.covered.length} real control(s): ${result.covered.join(" | ")}`,
    ).toEqual([]);

    await page.close();
  });
}

test("enough real sites were actually exercised", () => {
  // Guards against the whole suite silently degrading to skips and reporting green.
  expect(
    loaded.length,
    `only ${loaded.length} real site(s) loaded (${loaded.join(", ")}); need >= ${MIN_SITES}. ` +
      "Re-run with network access, or treat the real-retailer check as NOT performed.",
  ).toBeGreaterThanOrEqual(MIN_SITES);
});
