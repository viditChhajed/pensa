/**
 * Drive the Firefox build through a real Firefox.
 *
 *   npm run test:firefox
 *
 * Playwright cannot load an extension into Firefox, so this speaks WebDriver BiDi, the
 * automation protocol built into Firefox, directly: install the build as a temporary add-on,
 * answer the install card, then add a product to the cart on a fixture shop and wait for the
 * card. Needs Firefox in /Applications (or FIREFOX_BIN).
 *
 * Two prefs make that possible without touching the product:
 *   network.dns.localDomains              resolves shop.example.com to this machine, so the
 *                                          fixture pages are served locally, like the
 *                                          Chromium e2e suite's route interception
 *   extensions.webextOptionalPermissionPrompts = false
 *                                          answers Firefox's data collection prompt with yes,
 *                                          which is browser UI that automation cannot click
 */

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIREFOX = process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const BUILD = resolve(".output/firefox-mv3");
const PAGES = resolve("tests/e2e/pages");
const HTTP_PORT = 8123;
const BIDI_PORT = 9333;
const SHOP = `http://shop.example.com:${HTTP_PORT}`;

const results = [];
function check(ok, what, detail = "") {
  results.push({ ok, what });
  console.log(`${ok ? "  pass" : "  FAIL"}  ${what}${!ok && detail ? `\n        ${detail}` : ""}`);
}

// ---- a disposable copy of the build that may run on the fixture origin -------------------
// Same patch as tests/e2e/localBuild.ts: matches and host permission widened to the fixture
// origin, exclude_matches (the denylist) left strictly alone.
const addon = mkdtempSync(join(tmpdir(), "pensa-ff-"));
cpSync(BUILD, addon, { recursive: true });
const manifest = JSON.parse(readFileSync(join(addon, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://shop.example.com/*"];
for (const cs of manifest.content_scripts) cs.matches = ["http://shop.example.com/*"];
writeFileSync(join(addon, "manifest.json"), JSON.stringify(manifest, null, 2));

// ---- fixture shop -------------------------------------------------------------------------
const server = createServer((req, res) => {
  const name = new URL(req.url, SHOP).pathname.slice(1);
  try {
    const body = readFileSync(join(PAGES, name));
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  } catch {
    res.writeHead(204).end();
  }
}).listen(HTTP_PORT, "127.0.0.1");

// ---- Firefox --------------------------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), "pensa-ff-profile-"));
writeFileSync(
  join(profile, "user.js"),
  [
    `user_pref("network.dns.localDomains", "shop.example.com");`,
    `user_pref("extensions.webextOptionalPermissionPrompts", false);`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
    `user_pref("browser.aboutwelcome.enabled", false);`,
  ].join("\n"),
);
const firefox = spawn(
  FIREFOX,
  [
    "-headless",
    "-no-remote",
    "-profile",
    profile,
    `--remote-debugging-port=${BIDI_PORT}`,
    // Needed to run script inside moz-extension:// pages (the install card, Settings).
    "-remote-allow-system-access",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let stderr = "";
firefox.stderr.on("data", (d) => {
  stderr += d;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
      await new Promise((ok, fail) => {
        ws.onopen = ok;
        ws.onerror = fail;
      });
      return ws;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Firefox never opened its automation port.\n${stderr.slice(-2000)}`);
}

const ws = await connect();
let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === "error") fail(new Error(`${msg.error}: ${msg.message}`));
    else ok(msg.result);
  } else if (msg.type === "event") {
    events.push(msg);
  }
};
const bidi = (method, params = {}) =>
  new Promise((ok, fail) => {
    const id = nextId++;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(context, expression) {
  const r = await bidi("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (r.type === "exception") throw new Error(r.exceptionDetails?.text ?? "script threw");
  return r.result?.value;
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // the page may be mid-navigation
    }
    await sleep(stepMs);
  }
  return null;
}

/**
 * A click Firefox treats as a person's, inside an extension page.
 *
 * `permissions.request` checks Firefox's own "handling user input" flag, which neither a
 * scripted click (even with BiDi's userActivation) nor BiDi pointer input can set there: the
 * first does not count, the second is refused in privileged pages. So the mouse event is sent
 * from the browser window itself, at the button's position, and reaches the page the same way
 * a real click does.
 */
async function trustedClick(context, selector) {
  const rect = await evaluate(
    context,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
  );
  const { x, y } = JSON.parse(rect);
  const chromeWin = (await bidi("browsingContext.getTree", { "moz:scope": "chrome" })).contexts[0];
  const r = await bidi("script.evaluate", {
    expression: `(() => {
      const b = gBrowser.selectedBrowser.getBoundingClientRect();
      const px = b.left + ${x}, py = b.top + ${y};
      const opts = { button: 0, clickCount: 1, modifiers: 0 };
      window.synthesizeMouseEvent("mousedown", px, py, opts, { isDOMEventSynthesized: false });
      window.synthesizeMouseEvent("mouseup", px, py, opts, { isDOMEventSynthesized: false });
    })()`,
    target: { context: chromeWin.context },
    awaitPromise: false,
    resultOwnership: "none",
  });
  if (r.type === "exception") throw new Error(r.exceptionDetails?.text ?? "trusted click threw");
}

async function clickElement(context, selector) {
  const node = await bidi("script.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    target: { context },
    awaitPromise: false,
    resultOwnership: "root",
  });
  // A real pointer click, so the page and Firefox both see a user gesture.
  await bidi("input.performActions", {
    context,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        actions: [
          { type: "pointerMove", x: 0, y: 0, origin: { type: "element", element: node.result } },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

const tabs = async () => (await bidi("browsingContext.getTree", {})).contexts;

let failed = false;
try {
  await bidi("session.new", { capabilities: {} });
  await bidi("session.subscribe", { events: ["log.entryAdded"] });
  const installed = await bidi("webExtension.install", {
    extensionData: { type: "path", path: addon },
  });
  check(Boolean(installed.extension), "Firefox accepts the build as an add-on");

  // ---- the install card -------------------------------------------------------------------
  const welcome = await waitFor(
    async () => (await tabs()).find((c) => c.url.endsWith("/welcome.html")),
    15_000,
  );
  check(Boolean(welcome), "the install card opens on install");
  if (!welcome) throw new Error("no install card");
  const base = welcome.url.replace(/welcome\.html$/, "");

  const question = await waitFor(() => evaluate(welcome.context, "document.body.innerText"), 5000);
  check(/high schooler/.test(question ?? ""), "the install card asks the sharing question");

  await trustedClick(welcome.context, 'button.answer[data-consent="true"]');
  const result = await waitFor(
    () => evaluate(welcome.context, "document.getElementById('result').textContent"),
    10_000,
  );
  check(
    /Sharing is on/.test(result ?? ""),
    "Yes goes through Firefox's permission and says so",
    result,
  );

  const state = await evaluate(
    welcome.context,
    `Promise.all([
       chrome.storage.local.get("settings"),
       chrome.permissions.contains({ data_collection: ["browsingActivity", "websiteContent", "websiteActivity"] }),
     ]).then(([s, granted]) => JSON.stringify({ consent: s.settings?.telemetryConsent === true, granted }))`,
  );
  const { consent, granted } = JSON.parse(state);
  check(consent && granted, "the setting and Firefox's permission both say yes", state);

  // ---- about:addons removal is followed ---------------------------------------------------
  await evaluate(
    welcome.context,
    `chrome.permissions.remove({ data_collection: ["websiteActivity"] })`,
  );
  const off = await waitFor(
    () =>
      evaluate(
        welcome.context,
        `chrome.storage.local.get("settings").then((s) => s.settings?.telemetryConsent === false)`,
      ),
    5000,
  );
  check(Boolean(off), "removing Firefox's permission switches sharing off");

  // ---- Settings names the right browser ---------------------------------------------------
  const opts = await bidi("browsingContext.create", { type: "tab" });
  await bidi("browsingContext.navigate", {
    context: opts.context,
    url: `${base}options.html`,
    wait: "complete",
  });
  const sitesNote = await waitFor(
    () => evaluate(opts.context, "document.getElementById('sitesNote')?.textContent"),
    5000,
  );
  check(
    /refused by Firefox itself/.test(sitesNote ?? ""),
    "Settings says Firefox, not Chrome",
    sitesNote,
  );
  const telemetryBox = await evaluate(opts.context, "document.getElementById('telemetry').checked");
  check(telemetryBox === false, "Settings shows sharing off after the permission was removed");
  await bidi("browsingContext.close", { context: opts.context });

  // ---- a card at add-to-cart, on a page that navigates to the cart ------------------------
  const shop = await bidi("browsingContext.create", { type: "tab" });
  await bidi("browsingContext.activate", { context: shop.context });
  await bidi("browsingContext.navigate", {
    context: shop.context,
    url: `${SHOP}/pdp-navigates.html`,
    wait: "complete",
  });
  // Dwell: the salience gate needs the findings on screen for a moment.
  await sleep(3500);
  await clickElement(shop.context, "#atc");
  const card = await waitFor(
    () =>
      evaluate(
        shop.context,
        `location.pathname === "/cart-page.html" && [...document.documentElement.children].some((e) => e.id?.startsWith("pp-"))`,
      ),
    30_000,
    500,
  );
  const logs = events
    .filter((e) => e.method === "log.entryAdded")
    .map((e) => e.params.text)
    .filter((t) => t?.includes("[pensa]"));
  check(
    Boolean(card),
    "a card appears on the cart page after Add to Cart",
    logs.join("\n        "),
  );

  const errors = events
    .filter((e) => e.method === "log.entryAdded" && e.params.level === "error")
    .map((e) => e.params.text);
  check(errors.length === 0, "no errors logged in any page", errors.join("\n        "));
} catch (err) {
  failed = true;
  console.error(`\n  aborted: ${err instanceof Error ? err.message : err}`);
} finally {
  ws.close();
  firefox.kill();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  rmSync(addon, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - bad} passed, ${bad} failed${failed ? ", run aborted" : ""}`);
process.exit(bad || failed ? 1 : 0);
