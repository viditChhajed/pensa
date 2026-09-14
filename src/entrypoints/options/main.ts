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
import { PATTERN_GROUPS } from "./groups";

const sitesEl = document.getElementById("sites") as HTMLUListElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
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
  { value: "weekly_only", label: "Never interrupt me — I will check the summary" },
  { value: "off", label: "Turn detection off entirely" },
];

async function renderSites(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll();
  sitesEl.replaceChildren();

  if (origins.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "None yet. Open the toolbar icon while on a shopping site to enable it.";
    sitesEl.append(li);
    return;
  }

  for (const pattern of origins.slice().sort()) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.style.cssText = "margin-left:12px;padding:2px 8px;font-size:12px";
    remove.addEventListener("click", () => {
      chrome.permissions.remove({ origins: [pattern] }, (ok) => {
        if (ok) void renderSites();
      });
    });

    li.append(name, remove);
    sitesEl.append(li);
  }
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
      ? "Nothing queued. Counts appear here as patterns are found on sites you have enabled."
      : "Nothing queued, because sharing is switched off. Nothing is recorded while it is off.";
    pendingEl.append(none);
    return;
  }

  const count = document.createElement("p");
  count.textContent = `${records.length} count(s) queued. Newest first:`;
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

clearBtn.addEventListener("click", async () => {
  await send({ type: "clear-data" });
  clearedEl.hidden = false;
  await renderSummary();
});

async function init(): Promise<void> {
  const settings = await send<Settings>({ type: "get-settings" });
  renderFrequency(settings?.digestFrequency ?? "every_checkout");
  telemetryEl.checked = settings?.telemetryConsent ?? false;
  disabled = new Set(settings?.disabledDetectors ?? []);
  renderPatterns();
  await renderSites();
  await renderSummary();
}

void init();
