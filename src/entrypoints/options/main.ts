/**
 * Settings page (plan T31/T32).
 *
 * The sensitivity control ships here in v1 rather than v1.1 because perceived nagging is the
 * largest uninstall driver, and shipping a nagging detector without one would be a poor
 * look. The telemetry consent is an unticked box for the same reason — this product flags
 * preselected checkboxes.
 */

import type { PrevalenceRow } from "@/background/db";
import { send } from "@/shared/messages";
import type { DigestFrequency, Settings } from "@/shared/schema";
import { type PatternId, TAXONOMY } from "@/shared/taxonomy";
import { DENYLIST_COVERAGE } from "@/shared/urlScore";
import { PATTERN_GROUPS } from "./groups";

const sitesEl = document.getElementById("sites") as HTMLUListElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
const retentionEl = document.getElementById("retention") as HTMLSelectElement;
const exportedEl = document.getElementById("exported") as HTMLParagraphElement;
const clearedEl = document.getElementById("cleared") as HTMLParagraphElement;
const frequencyEl = document.getElementById("frequency") as HTMLDivElement;
const telemetryEl = document.getElementById("telemetry") as HTMLInputElement;
const summaryEl = document.getElementById("summary") as HTMLTableElement;
const patternsEl = document.getElementById("patterns") as HTMLDivElement;
const pendingEl = document.getElementById("pending") as HTMLDivElement;
const pendingWrap = document.getElementById("pendingWrap") as HTMLDetailsElement;

const FREQUENCY_CHOICES: { value: DigestFrequency; label: string }[] = [
  { value: "every_checkout", label: "Every time I reach checkout" },
  { value: "once_per_site", label: "Once per site, per browsing session" },
  { value: "never_interrupt", label: "Never interrupt me — I will check the summary" },
  { value: "off", label: "Turn detection off entirely" },
];

/**
 * "Sites you have enabled" is gone, because nothing is enabled any more — Vero holds every
 * https site from the moment it is installed, and there was never a per-site switch other
 * than the permission itself. A list of granted origins would now show one entry reading
 * "every site", which is true and useless.
 *
 * What replaces it is the only per-site fact left that a person cannot see for themselves:
 * where Vero REFUSES to run. It is read out of the manifest Chrome actually loaded rather
 * than re-derived from the rulepack, so this list is the real one — if the exclusions ever
 * shipped empty, this page would say so instead of describing a list that is not there.
 */
function renderSites(): void {
  sitesEl.replaceChildren();

  const declared = chrome.runtime.getManifest().content_scripts ?? [];
  const excluded = declared
    .flatMap((cs) => cs.exclude_matches ?? [])
    .map((p) => p.replace(/^https:\/\/\*\./, "").replace(/\/\*$/, ""))
    .sort();

  if (excluded.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent =
      "Nothing is excluded by Chrome in this build, which should be impossible. Please report it.";
    sitesEl.append(li);
  }

  for (const host of excluded) {
    const li = document.createElement("li");
    li.textContent = host;
    sitesEl.append(li);
  }

  /**
   * The honest footnote. `exclude_matches` can only name whole hosts, so most of the
   * denylist cannot go in the manifest at all and is checked in code instead, at the top of
   * the detector, before a single element is read. Saying how many there are — and that
   * Chrome is not the one enforcing them — is the difference between a checkable claim and
   * a reassuring one.
   */
  const noteEl = document.getElementById("sitesNote") as HTMLParagraphElement;
  noteEl.textContent =
    `${excluded.length} host patterns above are refused by Chrome itself — Vero's code is ` +
    `never loaded there. A further ${DENYLIST_COVERAGE.inexpressible.length} rules cannot be ` +
    "written as a Chrome pattern (things like “any site with 'bank' in its name” or “a " +
    "mychart. address on any domain”). Those are checked by Vero, on page load, before " +
    "anything is read — a weaker guarantee than the list above, and worth knowing apart.";
}

function renderFrequency(current: DigestFrequency): void {
  frequencyEl.replaceChildren();
  for (const choice of FREQUENCY_CHOICES) {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "frequency";
    radio.value = choice.value;
    radio.checked = choice.value === current;
    radio.addEventListener("change", () => {
      void send({ type: "set-settings", patch: { digestFrequency: choice.value } });
    });
    const span = document.createElement("span");
    span.textContent = choice.label;
    label.append(radio, span);
    frequencyEl.append(label);
  }
}

/** Mirrors the stored setting so a toggle can write the whole array back. */
let disabled = new Set<string>();

function persistDisabled(): void {
  void send({ type: "set-settings", patch: { disabledDetectors: [...disabled] } });
}

function renderPatterns(): void {
  patternsEl.replaceChildren();

  for (const group of PATTERN_GROUPS) {
    const section = document.createElement("div");
    section.className = "group";

    const heading = document.createElement("h3");
    heading.textContent = group.title;
    section.append(heading);

    if (group.note) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = group.note;
      section.append(note);
    }

    for (const id of group.ids) {
      const entry = TAXONOMY[id as PatternId];
      if (!entry) continue;

      const label = document.createElement("label");
      label.className = "row pattern";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !disabled.has(id);
      // A stable handle for the e2e. Matching on the visible label would make renaming a
      // pattern break a test about wiring, which teaches the wrong lesson when it fails.
      box.dataset.pattern = id;
      box.addEventListener("change", () => {
        if (box.checked) disabled.delete(id);
        else disabled.add(id);
        persistDisabled();
      });

      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = entry.label;
      // The mechanism, verbatim from the taxonomy. It is already written to the same
      // grade-8 bar as the card copy, and restating it here in different words is how two
      // descriptions of one thing drift apart.
      const why = document.createElement("span");
      why.className = "muted";
      why.textContent = entry.mechanism;
      text.append(name, document.createElement("br"), why);

      label.append(box, text);
      section.append(label);
    }

    patternsEl.append(section);
  }
}

async function renderSummary(): Promise<void> {
  const reply = await send<{ rows: PrevalenceRow[] }>({ type: "get-summary" });
  const rows = reply?.rows ?? [];
  summaryEl.replaceChildren();

  if (rows.length === 0) {
    const body = summaryEl.createTBody();
    const cell = body.insertRow().insertCell();
    cell.className = "muted";
    cell.textContent = "Nothing noticed yet today.";
    return;
  }

  const head = summaryEl.createTHead().insertRow();
  for (const [text, cls] of [
    ["Pattern", ""],
    ["Where", ""],
    ["Noticed", "num"],
    ["Shown", "num"],
    ["No room", "num"],
    ["Off-screen", "num"],
    ["Sites", "num"],
  ] as const) {
    const th = document.createElement("th");
    th.textContent = text;
    if (cls) th.className = cls;
    head.append(th);
  }

  const body = summaryEl.createTBody();
  for (const row of rows.slice(0, 25)) {
    const tr = body.insertRow();
    // The label, not the id. `anchoring.reference_price` is how the code refers to it; the
    // person reading their own summary should see the same words the card used.
    tr.insertCell().textContent = TAXONOMY[row.patternId as PatternId]?.label ?? row.patternId;
    tr.insertCell().textContent = row.funnelStage;
    for (const n of [
      row.detected,
      row.surfaced,
      row.placementSuppressed,
      row.belowSalience,
      row.origins,
    ]) {
      const cell = tr.insertCell();
      cell.className = "num";
      cell.textContent = String(n);
    }
  }
}

/**
 * The queue, rendered verbatim.
 *
 * Consent to "anonymous statistics" means nothing if the person consenting cannot see the
 * rows. This renders the actual records that would be POSTed — the same objects, no
 * summary — so the claim in the paragraph above is checkable rather than merely stated.
 */
async function renderPending(): Promise<void> {
  const reply = await send<{ records: Record<string, unknown>[]; endpoint: string }>({
    type: "get-pending-telemetry",
  });
  const records = reply?.records ?? [];
  pendingEl.replaceChildren();

  const where = document.createElement("p");
  where.textContent =
    reply?.endpoint && reply.endpoint.length > 0
      ? `Destination: ${reply.endpoint}`
      : "No destination is configured, so nothing is being sent anywhere right now.";
  pendingEl.append(where);

  if (records.length === 0) {
    const none = document.createElement("p");
    none.textContent = telemetryEl.checked
      ? "Nothing queued. Counts appear here as patterns are found while you shop."
      : "Nothing queued, because sharing is switched off. Nothing is recorded while it is off.";
    pendingEl.append(none);
    return;
  }

  const count = document.createElement("p");
  const outcomes = records.filter((r) => "addedToCart" in r).length;
  count.textContent =
    `${records.length} report(s) queued` +
    (outcomes > 0 ? `, ${outcomes} of them add-to-cart outcomes` : "") +
    ". Newest first:";
  pendingEl.append(count);

  const pre = document.createElement("pre");
  pre.style.cssText =
    "overflow-x:auto;font-size:11.5px;line-height:1.5;white-space:pre;margin:8px 0 0";
  pre.textContent = records.map((r) => JSON.stringify(r)).join("\n");
  pendingEl.append(pre);
}

pendingWrap.addEventListener("toggle", () => {
  if (pendingWrap.open) void renderPending();
});

telemetryEl.addEventListener("change", () => {
  void send({
    type: "set-settings",
    patch: { telemetryConsent: telemetryEl.checked, telemetryConsentAskedAt: Date.now() },
  }).then(() => {
    // Switching it off clears the queue on the worker side; reflect that immediately rather
    // than leaving a stale list on screen implying data is still pending.
    if (pendingWrap.open) void renderPending();
  });
});

interface ExportRow {
  ts: number;
  origin: string;
  patternId: string;
  [k: string]: unknown;
}

/**
 * Hand the whole detection log over as JSONL.
 *
 * JSONL rather than JSON or CSV: one row per line means the file streams into pandas, jq,
 * DuckDB or a spreadsheet without a parser that has to hold the lot in memory, and appending
 * two exports together is `cat`. A single JSON array is the shape that breaks at the size
 * this is meant to reach.
 *
 * This is the only path by which anything leaves the device, and a person clicked it. It is
 * a download to their own disk, not a network request — the zero-egress guarantee is about
 * what the extension sends on its own, and this sends nothing anywhere.
 */
exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportedEl.hidden = false;
  exportedEl.textContent = "Collecting…";
  try {
    const reply = await send<{ rows: ExportRow[] }>({ type: "export-events" });
    const rows = reply?.rows ?? [];
    if (rows.length === 0) {
      exportedEl.textContent = "Nothing recorded yet, so there is nothing to export.";
      return;
    }
    const jsonl = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `vero-events-${stamp}.jsonl`;
    a.click();
    // Revoked on the next turn of the event loop: revoking synchronously can race the
    // download on some Chrome versions and produce an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const sites = new Set(rows.map((r) => r.origin)).size;
    const oldest = new Date(Math.min(...rows.map((r) => r.ts))).toISOString().slice(0, 10);
    exportedEl.textContent =
      `Exported ${rows.length} detection(s) across ${sites} site(s), back to ${oldest}. ` +
      `Retention trims anything older, so export again to keep accumulating.`;
  } catch (err) {
    exportedEl.textContent = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    exportBtn.disabled = false;
  }
});

/**
 * Retention was a real setting — stored, validated, and applied by the worker's prune — with no
 * control anywhere to change it, while PRIVACY.md said it was adjustable in Settings. Now it is.
 * Pruning runs on the housekeeping alarm, so a shorter window takes effect within hours.
 */
retentionEl.addEventListener("change", () => {
  const days = Number(retentionEl.value);
  if (Number.isInteger(days) && days >= 1 && days <= 365) {
    void send({ type: "set-settings", patch: { retentionDays: days } });
  }
});

clearBtn.addEventListener("click", async () => {
  await send({ type: "clear-data" });
  clearedEl.hidden = false;
  await renderSummary();
});

async function init(): Promise<void> {
  const settings = await send<Settings>({ type: "get-settings" });
  renderFrequency(settings?.digestFrequency ?? "every_checkout");
  telemetryEl.checked = settings?.telemetryConsent ?? false;
  const days = String(settings?.retentionDays ?? 30);
  if (![...retentionEl.options].some((o) => o.value === days)) {
    // A value set some other way (an older build, a test) is shown rather than silently
    // replaced by whichever option happens to be first.
    retentionEl.add(new Option(`${days} days`, days));
  }
  retentionEl.value = days;
  disabled = new Set(settings?.disabledDetectors ?? []);
  renderPatterns();
  renderSites();
  await renderSummary();
}

void init();
