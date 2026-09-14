import { chromium } from "@playwright/test";
const b = await chromium.launch({ channel: "chromium" });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
const site = process.argv[2] ?? "glossier.com";
await page.goto(`https://www.${site}`, { waitUntil: "domcontentloaded", timeout: 40000 });
await page.waitForTimeout(3000);
const links = await page.$$eval("a[href]", (els, o) => [...new Set(els.map(e=>e.href))].filter(h=>h.startsWith(o)), `https://www.${site}`);
const prod = links.filter(l => /\/(products?|item|dp|p|prod)\//i.test(new URL(l).pathname))[0];
console.log("product:", prod);
if (!prod) { await b.close(); process.exit(0); }
await page.goto(prod, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3500);
const btns = await page.$$eval('button, [role="button"], input[type="submit"], a', (els) =>
  els.slice(0, 400).map(e => ({
    tag: e.tagName,
    label: (e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g," ").trim().slice(0,52),
    vis: !!(e.getBoundingClientRect().width > 4),
  })).filter(x => x.label && /add|bag|cart|buy/i.test(x.label)));
console.log("candidates:", JSON.stringify(btns, null, 1).slice(0, 900));
await b.close();
