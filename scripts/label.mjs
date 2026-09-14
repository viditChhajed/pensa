/**
 * The labelling tool (plan §18D).
 *
 *   npm run label      then open http://localhost:5173
 *
 * Everything here exists to make one hour of a person's attention produce as many usable
 * examples as possible, because a labelling job that is not finished trains nothing:
 *
 *   One keystroke per item, and the item advances itself. F is yes, J is no — opposite
 *   hands, home row, no reaching and no mouse. A three-click UI at 2000 items is an
 *   afternoon; this is about forty minutes.
 *
 *   One pattern at a time, with its question and its examples pinned on screen. Switching
 *   between "is this scarcity?" and "is this confirmshaming?" every item costs more than the
 *   labelling does, and the errors it causes are invisible.
 *
 *   Every answer is written to disk the moment it is made. Closing the tab loses nothing and
 *   reopening resumes at the next unlabelled item.
 *
 *   Undo is one key, because the real failure mode of fast labelling is a misfire you notice
 *   half a second later and cannot correct without stopping.
 *
 *   A fourth answer: "no to THIS, but it is something". Asking only yes/no throws away the
 *   most informative thing a person notices — that a snippet is a countdown while they were
 *   being asked about stock. That is a positive example for another pattern, seen for free,
 *   and without somewhere to put it the labeller answers "no" and the observation is lost.
 *   It also doubles as a way to name a technique the taxonomy does not have yet: the free
 *   text box is how a pattern nobody anticipated gets recorded instead of discarded.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { buildQueue, TRAINABLE } from "./label-queue.mjs";

const PORT = Number(process.env.PORT ?? 5173);
const CORPUS = resolve("corpus/candidates.jsonl");
const LABELS = resolve("corpus/labels.jsonl");
const PER_PATTERN = Number(process.env.PER_PATTERN ?? 300);

if (!existsSync(CORPUS)) {
  console.error(`No corpus at ${CORPUS}.\nRun:  npm run corpus:collect`);
  process.exit(1);
}

mkdirSync(resolve("corpus"), { recursive: true });

// `--reset` starts the labelling over. Explicit and loud, because an hour of judgement is
// not something to discard on a flag typo.
if (process.argv.includes("--reset")) {
  const had = existsSync(LABELS)
    ? readFileSync(LABELS, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
  writeFileSync(LABELS, "");
  console.log(`\n  Reset: discarded ${had} previous answer(s).`);
}
if (!existsSync(LABELS)) writeFileSync(LABELS, "");

const rows = readFileSync(CORPUS, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const queue = buildQueue(rows, { perPattern: PER_PATTERN });

/** Keyed by pattern + the deduped text key, so re-collecting the corpus keeps old answers. */
function loadLabels() {
  const out = new Map();
  const text = readFileSync(LABELS, "utf8").trim();
  if (!text) return out;
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.undo) out.delete(`${r.patternId}|${r.key}`);
      else out.set(`${r.patternId}|${r.key}`, r);
    } catch {
      /* a truncated last line from a hard kill is not worth losing the file over */
    }
  }
  return out;
}

const page = /* html */ `
<!doctype html><meta charset="utf-8"><title>Label — Vero</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#6b7280; --bg:#fff; --line:#e5e7eb;
          --yes:#047857; --no:#b91c1c; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8eaed; --muted:#9aa0a6; --bg:#16181c; --line:#2c2f36; --yes:#34d399; --no:#f87171; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 20px 24px 80px; }
  header { border-bottom:1px solid var(--line); padding-bottom:14px; margin-bottom:22px; }
  h1 { font-size:15px; margin:0 0 2px; letter-spacing:.02em; }
  .sub { color:var(--muted); font-size:13px; }
  .bar { height:4px; background:var(--line); border-radius:2px; margin-top:12px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--accent); width:0; transition:width .15s; }
  .q { font-size:20px; font-weight:600; margin:26px 0 6px; }
  .mech { color:var(--muted); font-size:13.5px; margin-bottom:20px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:26px 24px; min-height:150px;
          display:flex; flex-direction:column; justify-content:center; }
  .text { font-size:23px; line-height:1.35; overflow-wrap:anywhere; }
  .meta { color:var(--muted); font-size:12px; margin-top:16px; }
  .keys { position:fixed; left:0; right:0; bottom:0; background:var(--bg);
          border-top:1px solid var(--line); padding:12px 24px; }
  .keys div { max-width:760px; margin:0 auto; display:flex; gap:26px; font-size:13px;
              color:var(--muted); align-items:center; }
  kbd { border:1px solid var(--line); border-bottom-width:2px; border-radius:5px;
        padding:2px 7px; font:600 12px ui-monospace,monospace; color:var(--fg); }
  .eg { display:flex; gap:28px; margin-bottom:22px; font-size:13px; }
  .eg ul { margin:4px 0 0; padding-left:16px; color:var(--muted); }
  .eg b { font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; }
  .eg .y b { color:var(--yes); } .eg .n b { color:var(--no); }
  .flash { animation: f .18s; } @keyframes f { from { opacity:.25 } to { opacity:1 } }
  .done { text-align:center; padding:80px 0; }
  .done h2 { font-size:22px; } .done p { color:var(--muted); }
  .rate { margin-left:auto; font-variant-numeric:tabular-nums; }
  .picker { border:1px solid var(--accent); border-radius:12px; padding:18px 20px; margin-top:14px; }
  .picker h4 { margin:0 0 4px; font-size:14px; }
  .picker .hint { color:var(--muted); font-size:12.5px; margin:0 0 12px; }
  .picker ol { list-style:none; margin:0; padding:0; display:grid;
               grid-template-columns:1fr 1fr; gap:6px 18px; }
  .picker li { font-size:13.5px; display:flex; gap:9px; align-items:baseline; }
  .picker input { font:inherit; width:100%; margin-top:12px; padding:9px 11px;
                  border:1px solid var(--line); border-radius:7px;
                  background:transparent; color:var(--fg); }
  .askedabout { opacity:.42; }
</style>
<div class="wrap">
  <header>
    <h1 id="pat">…</h1>
    <div class="sub" id="prog">loading</div>
    <div class="bar"><i id="fill"></i></div>
  </header>
  <main id="main"></main>
</div>
<div class="keys"><div>
  <span><kbd>F</kbd> yes</span>
  <span><kbd>J</kbd> no</span>
  <span><kbd>D</kbd> no, but it&rsquo;s a different one</span>
  <span><kbd>Space</kbd> skip</span>
  <span><kbd>U</kbd> undo</span>
  <span class="rate" id="rate"></span>
</div></div>
<script type="module">
const state = await (await fetch("/api/queue")).json();
const { patterns } = state;
let items = state.items;
let i = 0;
const t0 = Date.now();
let done = 0;

const el = (id) => document.getElementById(id);

function current() { return items[i]; }

/** Non-null while the "it is a different one" picker is open. */
let picking = null;

function render() {
  const it = current();
  if (!it) {
    el("main").innerHTML =
      '<div class="done"><h2>Done — every item labelled.</h2>' +
      '<p>Run <code>npm run corpus:train</code> next.</p></div>';
    el("pat").textContent = "Finished";
    el("prog").textContent = state.total + " items";
    el("fill").style.width = "100%";
    return;
  }
  const p = patterns[it.patternId];
  const patIdx = state.order.indexOf(it.patternId) + 1;
  el("pat").textContent = p.label + "   (" + patIdx + " of " + state.order.length + ")";
  // "4 of 1800 left" reads as "4 left". Say what is done and what remains, separately.
  const doneOverall = state.total - items.length + i;
  el("prog").textContent =
    doneOverall + " done  ·  " + (items.length - i) + " to go  ·  " + it.site;
  el("fill").style.width = ((state.total - items.length + i) / state.total * 100) + "%";

  el("main").innerHTML =
    '<div class="q">' + esc(p.question) + '</div>' +
    '<div class="mech">' + esc(p.mechanism) + '</div>' +
    '<div class="eg"><div class="y"><b>Yes, like</b><ul>' +
      p.yes.map((x) => '<li>' + esc(x) + '</li>').join("") +
    '</ul></div><div class="n"><b>No, like</b><ul>' +
      p.no.map((x) => '<li>' + esc(x) + '</li>').join("") +
    '</ul></div></div>' +
    '<div class="card flash"><div class="text">' + esc(it.text) + '</div>' +
    // Just the shop. The selector tail was rendering as "ulta.com · a", which tells the
    // reader nothing and reads like a bug.
    '<div class="meta">seen on ' + esc(it.site) + '</div></div>' +
    (picking ? pickerHtml(it) : "");

  if (picking) {
    // Focused, so naming something just works without a click. The digit keys are taken
    // back from it in the handler WHILE IT IS EMPTY — the first attempt left it unfocused to
    // protect the digits, and then typing did nothing at all, which is worse.
    document.getElementById("otherText")?.focus();
  }

  const mins = (Date.now() - t0) / 60000;
  el("rate").textContent = done > 0
    ? done + " done · " + Math.round(done / Math.max(mins, .01)) + "/min · ~" +
      Math.max(0, Math.round((items.length - i) / Math.max(done / Math.max(mins, .01), 1))) + " min left"
    : "";
}

/**
 * "No to the one I asked about, but it IS something."
 *
 * Numbered so the whole answer is two keystrokes: D, then a digit. The pattern currently
 * being asked about is listed but dimmed and unselectable — choosing it would mean "no, but
 * yes", and offering a contradiction as a button invites a misclick rather than preventing
 * one.
 *
 * The free text box is the important half. It is how a technique the taxonomy does not have
 * — a checkout donation prompt, a decoy tier, anything nobody anticipated — gets RECORDED
 * rather than discarded as a "no". Every recall failure this project has had came from a
 * list written in advance; this is the one place a person can write outside it.
 */
function pickerHtml(it) {
  const rows = state.order
    .map((id, n) => {
      const asked = id === it.patternId;
      return (
        '<li class="' + (asked ? "askedabout" : "") + '">' +
        '<kbd>' + (n + 1) + '</kbd> ' + esc(patterns[id].label) +
        (asked ? " (the one asked about)" : "") +
        "</li>"
      );
    })
    .join("");

  return (
    '<div class="picker">' +
    "<h4>Which one is it?</h4>" +
    '<p class="hint">Press a number. Or type a name for something not on the list — ' +
    "that is how a technique nobody has written down yet gets recorded. " +
    "<kbd>Esc</kbd> to go back.</p>" +
    "<ol>" + rows + "</ol>" +
    '<input id="otherText" placeholder="something else — name it, then Enter" ' +
    'autocomplete="off" spellcheck="false" />' +
    "</div>"
  );
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

async function answer(label, also) {
  const it = current();
  if (!it) return;
  picking = null;
  i++;
  done++;
  render();
  // Fire and forget, but ordered: the server appends, so a slow request cannot reorder or
  // lose an answer. The UI never waits on the network — that wait is the whole cost at
  // 2000 items.
  fetch("/api/label", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      patternId: it.patternId,
      key: it.key,
      text: it.text,
      label,
      tier: it.tier,
      site: it.site,
      // A "no" that names another pattern is ALSO a positive for that one, recorded once and
      // used twice. See the trainer.
      ...(also ? { alsoPattern: also.id, ...(also.text ? { alsoText: also.text } : {}) } : {}),
    }),
  });
}

async function undo() {
  if (i === 0) return;
  i--;
  done = Math.max(0, done - 1);
  const it = current();
  render();
  fetch("/api/label", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patternId: it.patternId, key: it.key, undo: true }),
  });
}

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();

  // While the picker is open it owns the keyboard. Otherwise typing "something else" into
  // the free text box would fire F and J as answers, which would be both wrong and silent.
  if (picking) {
    if (k === "escape") { e.preventDefault(); picking = null; render(); return; }
    const box = document.getElementById("otherText");

    if (k === "enter") {
      const value = (box?.value ?? "").trim();
      if (value.length > 0) { e.preventDefault(); answer(0, { id: "other", text: value.slice(0, 80) }); }
      return;
    }

    /**
     * A digit picks — but only while nothing has been typed.
     *
     * Once someone is part way through naming something, a digit belongs to what they are
     * writing: "buy 2 get 1 free" is a perfectly good name for a technique, and swallowing
     * its digits as menu selections would make the box quietly unusable for exactly the
     * inputs most worth capturing.
     */
    const n = Number.parseInt(k, 10);
    const empty = (box?.value ?? "").length === 0;
    if (empty && Number.isInteger(n) && n >= 1 && n <= state.order.length) {
      e.preventDefault();
      const id = state.order[n - 1];
      // The one being asked about is not a valid answer here: "no, but yes" is a
      // contradiction, and accepting it would quietly corrupt both labels.
      if (id !== current()?.patternId) answer(0, { id });
      return;
    }

    // Everything else is typing. Let it through.
    return;
  }

  if (k === "f" || k === "arrowright") { e.preventDefault(); answer(1); }
  else if (k === "j" || k === "arrowleft") { e.preventDefault(); answer(0); }
  else if (k === "d") { e.preventDefault(); picking = true; render(); }
  else if (k === " ") { e.preventDefault(); i++; render(); }
  else if (k === "u") { e.preventDefault(); undo(); }
});

render();
</script>`;

const server = createServer((req, res) => {
  if (req.url === "/" || req.url?.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }

  if (req.url === "/api/queue") {
    const labelled = loadLabels();
    const remaining = queue.filter((it) => !labelled.has(`${it.patternId}|${it.key}`));
    const patterns = Object.fromEntries(
      TRAINABLE.map((p) => [
        p.id,
        { label: p.label, question: p.question, mechanism: p.mechanism, yes: p.yes, no: p.no },
      ]),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        items: remaining,
        patterns,
        total: queue.length,
        order: TRAINABLE.map((p) => p.id),
      }),
    );
    return;
  }

  if (req.url === "/api/label" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        const r = JSON.parse(body);
        appendFileSync(LABELS, `${JSON.stringify({ ...r, ts: Date.now() })}\n`);
      } catch {
        /* a malformed post loses one answer, never the file */
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  const labelled = loadLabels();
  const remaining = queue.filter((it) => !labelled.has(`${it.patternId}|${it.key}`)).length;
  console.log(`\n  Labelling ${queue.length} items across ${TRAINABLE.length} patterns.`);
  console.log(`  ${queue.length - remaining} already done, ${remaining} to go.\n`);
  console.log(`  ->  http://localhost:${PORT}\n`);
  console.log(`  F = yes   J = no   D = no, but it's a different one   Space = skip   U = undo`);
  console.log(`  Answers are saved as you go; close the tab any time and reopen to resume.\n`);

  // Open it. One less step between deciding to label and labelling, and the whole design of
  // this tool is about removing steps.
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(opener, [`http://localhost:${PORT}`], () => {
    /* no browser, no problem — the URL is printed above */
  });
});
