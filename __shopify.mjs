// Shopify exposes a documented product JSON endpoint and a cart permalink. If a site is
// Shopify, a cart can be created without driving any UI at all.
const SITES = ["glossier.com","fashionnova.com","boohoo.com","prettylittlething.us","nastygal.com",
  "lulus.com","cider.com","allbirds.com","chubbiesshorts.com","untuckit.com","forever21.com",
  "romwe.com","zaful.com","everlane.com","warbyparker.com"];
for (const s of SITES) {
  try {
    const r = await fetch(`https://www.${s}/products.json?limit=1`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(12000),
    });
    const ct = r.headers.get("content-type") ?? "";
    if (!r.ok || !ct.includes("json")) { console.log(`${s.padEnd(22)} no (${r.status})`); continue; }
    const j = await r.json();
    const v = j?.products?.[0]?.variants?.[0];
    console.log(`${s.padEnd(22)} SHOPIFY  variant ${v?.id ?? "?"}  ${String(j?.products?.[0]?.title ?? "").slice(0,34)}`);
  } catch (e) { console.log(`${s.padEnd(22)} err ${String(e.message).slice(0,30)}`); }
}
