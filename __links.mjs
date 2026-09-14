import { chromium } from "@playwright/test";
const PRODUCT = /\/(?:products?|item|itm|dp|pd|p|prod|sku|buy|hotel|hotels|rooms?|flights?|stays?|event|events|tickets?|listing)\//i;
const CATEGORY = /\/(?:collections?|category|categories|c|s|shop|sale|deals?|clearance|new)\b/i;
const b = await chromium.launch({ channel: "chromium" });
for (const site of ["zappos.com","uniqlo.com","target.com","kohls.com","asos.com","chewy.com"]) {
  const ctx = await b.newContext({ viewport:{width:1280,height:900},
    userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.${site}`, { waitUntil:"domcontentloaded", timeout:35000 });
    await page.waitForTimeout(3000);
    const links = await page.$$eval("a[href]", (els,o)=>[...new Set(els.map(e=>e.href))].filter(h=>h.startsWith(o)), `https://www.${site}`);
    const paths = links.map(l=>new URL(l).pathname);
    const prod = paths.filter(p=>PRODUCT.test(p));
    const cat = paths.filter(p=>CATEGORY.test(p));
    console.log(`${site.padEnd(14)} links ${String(links.length).padStart(4)}  product ${String(prod.length).padStart(3)}  category ${String(cat.length).padStart(3)}`);
    console.log(`   sample: ${paths.slice(0,5).map(p=>p.slice(0,44)).join(" | ")}`);
  } catch (e) { console.log(`${site.padEnd(14)} failed — ${String(e.message).split("\n")[0].slice(0,50)}`); }
  await ctx.close();
}
await b.close();
