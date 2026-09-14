import { chromium } from "@playwright/test";
const url = process.argv[2];
const b = await chromium.launch({ channel: "chromium" });
const ctx = await b.newContext({ viewport:{width:1280,height:900},
  userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
await page.goto(url, { waitUntil:"domcontentloaded", timeout:40000 });
await page.waitForTimeout(5000);
await page.evaluate(()=>scrollTo(0,500)); await page.waitForTimeout(2000);
const byRole = await page.getByRole("button", { name: /add to (?:cart|bag|basket)/i }).count();
console.log("role-button matches:", byRole);
const all = await page.$$eval('button, [role="button"], input[type="submit"], a', els =>
  els.map(e => ({ t:e.tagName, aria:e.getAttribute("aria-label")||"", txt:(e.textContent||"").replace(/\s+/g," ").trim().slice(0,46),
                  vis: e.getBoundingClientRect().width>4, dis: e.disabled===true }))
     .filter(x => /add|cart|bag|buy/i.test(x.aria + " " + x.txt)).slice(0,10));
console.log(JSON.stringify(all, null, 1).slice(0, 1100));
await b.close();
