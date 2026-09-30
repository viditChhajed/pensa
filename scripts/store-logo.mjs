/**
 * Render the 300x300 store logo Edge Add-ons asks for, from the same SVG as the toolbar icons.
 *
 *   node scripts/store-logo.mjs   ->  store/logo-300.png
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const svg = readFileSync("assets/icon.svg", "utf8").replace(
  /<svg([^>]*?)width="128" height="128"/,
  '<svg$1width="300" height="300"',
);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: "store/logo-300.png", omitBackground: true });
await browser.close();
console.log("store/logo-300.png");
