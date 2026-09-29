/**
 * Preflight for a local run: paste into the SERVICE WORKER console
 * (chrome://extensions, Pensa, "Inspect views: service worker").
 *
 * Checks the loaded build (version, endpoint compiled in), the sharing answer, the card
 * frequency, switched-off techniques, the queue, and the alarms, then says READY or lists
 * exactly what to fix. Verified against .output/chrome-mv3-live before it was committed.
 */
(async () => {
  const m = chrome.runtime.getManifest();
  const src = await (await fetch(chrome.runtime.getURL("background.js"))).text();
  const endpoint = (src.match(/https:\/\/[a-z0-9.-]*workers\.dev\/\w+/) || ["NONE"])[0];
  const { settings = {} } = await chrome.storage.local.get("settings");
  const count = (store) =>
    new Promise((res) => {
      const q = indexedDB.open("pensa");
      q.onerror = () => res("?");
      q.onsuccess = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains(store)) return res(0);
        const c = db.transaction(store).objectStore(store).count();
        c.onsuccess = () => res(c.result);
      };
    });
  const alarms = (await chrome.alarms.getAll()).map(
    (a) => `${a.name} in ${Math.max(0, Math.round((a.scheduledTime - Date.now()) / 60000))} min`,
  );
  const r = {
    version: m.version,
    endpoint,
    sharingOn: settings.telemetryConsent === true,
    questionAnswered: settings.telemetryConsentAskedAt !== undefined,
    cardFrequency: settings.digestFrequency ?? "every_checkout",
    techniquesSwitchedOff: (settings.disabledDetectors ?? []).length,
    reportsQueued: await count("telemetry"),
    detectionsStored: await count("events"),
    alarms: alarms.join(", "),
  };
  console.table(r);
  const problems = [];
  if (r.version !== "1.2.0")
    problems.push(`version is ${r.version}, expected 1.2.0: wrong folder loaded`);
  if (r.endpoint === "NONE") problems.push("no endpoint compiled in: load .output/chrome-mv3-live");
  if (!r.sharingOn) problems.push("sharing is off: answer Yes on the card, or tick it in Settings");
  if (r.cardFrequency !== "every_checkout")
    problems.push(
      `card frequency is ${r.cardFrequency}: set 'Every time I reach checkout' in Settings`,
    );
  if (r.techniquesSwitchedOff > 0)
    problems.push(`${r.techniquesSwitchedOff} technique(s) switched off in Settings`);
  if (!/telemetry/.test(r.alarms)) problems.push("telemetry alarm missing: reload the extension");
  console.log(
    problems.length === 0 ? "READY. Start shopping." : "NOT READY:\n- " + problems.join("\n- "),
  );
  return problems.length === 0 ? "READY" : problems;
})();
