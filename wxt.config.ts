import { cpSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";
import { CONTENT_SCRIPT_FILE } from "./src/shared/constants";
import { type DenylistShape, toExcludeMatches } from "./src/shared/denylistPatterns";

/**
 * The denylist, read here and converted into `exclude_matches`.
 *
 * Same file the runtime `isDenied()` reads, deliberately: two lists would drift, and the
 * one that drifts is always the one nobody looks at.
 */
const denylist = JSON.parse(
  readFileSync(new URL("./rulepacks/denylist.v1.json", import.meta.url), "utf8"),
) as DenylistShape;

const { matches: DENY_EXCLUDES, inexpressible: RUNTIME_ONLY_DENIES } = toExcludeMatches(denylist);

/** The one pattern Vero asks for, and the only one this build will let through. */
const REQUIRED_HOST = "https://*/*";

export default defineConfig({
  srcDir: "src",
  modules: [],
  /**
   * A stamp so a loaded extension can say which build it is.
   *
   * `wxt build` recreates .output from scratch, which can leave Chrome's unpacked load
   * pointing at a directory that no longer exists — the reload button then quietly does
   * nothing and the browser keeps running an old snapshot. That cost a full manual test
   * cycle: the fix was already built and on disk while the browser ran code from before it.
   * There is no way to tell by looking, so the build now says so out loud.
   */
  vite: () => ({
    plugins: [preact()],
    define: {
      __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace("T", " ").slice(0, 16)),
      /**
       * Where anonymous counts are POSTed. Empty unless the build says otherwise.
       *
       * Build-time rather than hardcoded, because there is more than one legitimate value —
       * nothing for a normal build, a local server for the round-trip e2e, a staging host,
       * and eventually production. A constant in the source would mean the send path could
       * only ever be tested by editing the source, which is the same as not testing it.
       *
       * Empty is the default, so a plain `npm run build` produces an extension that sends
       * nothing and the zero-egress tests keep meaning what they say.
       */
      __TELEMETRY_ENDPOINT__: JSON.stringify(process.env.TELEMETRY_ENDPOINT ?? ""),
    },
  }),

  manifest: {
    manifest_version: 3,
    name: "Vero",
    short_name: "Vero",
    description:
      "Notices persuasion techniques on shopping pages and asks a question about them. Runs on your device; sharing is off by default.",
    version: "1.0.0",

    // Justification for each, for the store listing:
    //   storage   - chrome.storage.session (the per-site session ledger, frequency state)
    //               and chrome.storage.local (settings). IndexedDB needs no permission.
    //   activeTab - read the CURRENT tab's URL in the popup on pages the host permission
    //               below does not cover (http://, chrome://, a PDF viewer), so the popup
    //               can say "Vero does not run here" instead of showing nothing at all.
    //   alarms    - the retention prune, offer-store eviction, and the six-hourly telemetry
    //               flush. Without it `chrome.alarms` is undefined and all three silently
    //               never run.
    //
    // `scripting` is not requested. The detector is declared in the manifest, so nothing
    // registers content scripts at runtime.
    //
    // `declarativeContent` is GONE. It existed to light the toolbar icon on plausible
    // shopping URLs without reading pages, back when lighting the icon meant "you can turn
    // Vero on here". Vero is now on everywhere it is allowed to be, the action is enabled
    // by default, and the popup opens on every page and says which state applies — so the
    // page rules decided nothing and the permission bought nothing.
    permissions: ["storage", "activeTab", "alarms"],

    /**
     * REQUIRED, granted at install, and the install warning says so: "Read and change all
     * your data on all websites you visit."
     *
     * This replaces the two-tier optional-permission design, and the trade is not subtle.
     * What is given up: the extension no longer has to be invited onto a site, so a user
     * cannot decide site by site, and the install prompt is the scariest one Chrome shows.
     * What is bought: the detector actually runs. Under the old model nothing happened
     * until someone found the popup, understood a permission prompt, and accepted it per
     * site — and cross-stage detection needs the whole funnel, which repeatedly meant a
     * second grant mid-checkout on a different subdomain.
     *
     * `https://` only, and that is load-bearing. `<all_urls>` and the any-scheme wildcard
     * would also take ftp, file and data URLs; the http variant would take plaintext pages,
     * where anything Vero can read is already readable by every hop in between. The build
     * hook below refuses all four by name.
     *
     * The denylist is still absolute. It is enforced twice: `exclude_matches` on the
     * content script below, so Chrome never injects on what it can express; and
     * `isDenied()` at the top of the detector, which covers the rest. Neither layer alone
     * is sufficient and both ship.
     */
    host_permissions: [REQUIRED_HOST],

    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },

    action: {
      default_title: "Vero",
      default_popup: "popup.html",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    options_ui: { page: "options.html", open_in_tab: true },
  },

  hooks: {
    /**
     * Declare the content script HERE, and assert the permission model in the same place.
     *
     * The detector is still built with `defineUnlistedScript`, so WXT emits `detector.js`
     * and writes nothing into the manifest; the entry below is written by hand. That is
     * deliberate. `exclude_matches` is the only part of this extension Chrome enforces on
     * our behalf, it is generated from the denylist, and generating it in the same function
     * that asserts it is non-empty means there is no arrangement of this file in which a
     * build ships the broad host pattern with the exclusions quietly missing.
     *
     * Manifest-declared rather than runtime-registered, now that the permission is held at
     * install. A runtime registration has to be re-derived every time the service worker
     * wakes, it can fail silently in a context with no console anyone is watching, and it
     * is a strictly worse way to say a fixed fact. The manifest entry is loaded by Chrome
     * before any of our code runs and cannot drift from what we asked for.
     */
    "build:manifestGenerated": (wxt, manifest) => {
      const m = manifest as chrome.runtime.ManifestV3 & Record<string, unknown>;

      m.content_scripts = [
        {
          matches: [REQUIRED_HOST],
          exclude_matches: DENY_EXCLUDES,
          js: [CONTENT_SCRIPT_FILE],
          run_at: "document_idle",
          all_frames: false,
        },
      ];

      wxt.logger.info(
        `content script: ${DENY_EXCLUDES.length} exclude_matches from the denylist; ` +
          `${RUNTIME_ONLY_DENIES.length} denylist patterns are regex-only and are covered ` +
          "at runtime by isDenied() alone",
      );

      /**
       * THE assertion, inverted.
       *
       * It used to throw if `host_permissions` was non-empty, because the whole design was
       * that the extension held nothing at install. That is no longer the design, so the
       * old rule would now fail every build — but the reasoning behind it was never "no
       * host permissions", it was "never ship a broader reach than the one that was argued
       * for". That is what is asserted now.
       *
       * Exactly REQUIRED_HOST. Not `<all_urls>` (adds file:, ftp:, data:), not the
       * any-scheme wildcard, and not the http variant (adds plaintext pages). A build that
       * widens this has changed what the install warning means, and it should have to
       * change this line to do it.
       */
      const hosts = (m.host_permissions ?? []) as string[];
      if (hosts.length !== 1 || hosts[0] !== REQUIRED_HOST) {
        throw new Error(
          `host_permissions must be exactly ["${REQUIRED_HOST}"]. Found: ${JSON.stringify(hosts)}. ` +
            "http:// and non-web schemes stay out: on a plaintext page anything Vero can " +
            "read is already readable by every hop in between, and file:/ftp:/data: are " +
            "not shopping.",
        );
      }

      if (m.optional_host_permissions) {
        throw new Error(
          "optional_host_permissions is obsolete. Every origin worth asking for is already " +
            "covered by the required https://*/*, and a leftover optional list is a second " +
            "source of truth for the same question.",
        );
      }

      const broad = ["<all_urls>", "http://*/*", "https://*/*", "*://*/*"];
      for (const p of (m.permissions ?? []) as string[]) {
        if (broad.includes(p)) {
          throw new Error(
            `"${p}" is a host pattern and belongs in host_permissions, not permissions.`,
          );
        }
      }

      /**
       * The denylist has to SHIP, and it has to be non-empty.
       *
       * An empty or unreadable denylist is the one failure this build must never produce
       * quietly: the extension would hold the broad pattern and exclude nothing, so Chrome would
       * inject on banks, patient portals and webmail, and the only thing standing between
       * that and the user would be a runtime check in a file nobody re-reads. Losing the
       * rulepack — a bad merge, a renamed file, a JSON typo caught as an empty array — has
       * to stop the build rather than change the product.
       */
      const scripts = m.content_scripts as { exclude_matches?: string[] }[];
      const excludes = scripts[0]?.exclude_matches ?? [];
      if (excludes.length === 0) {
        throw new Error(
          "The content script ships NO exclude_matches. host_permissions is https://*/* — " +
            "without the denylist-derived exclusions Chrome would inject on banking, " +
            "health, government and webmail hosts. Check rulepacks/denylist.v1.json.",
        );
      }
      if (denylist.hostPatterns.length === 0 || denylist.hostSuffixes.length === 0) {
        throw new Error("rulepacks/denylist.v1.json is empty or lost its shape.");
      }
      for (const pattern of excludes) {
        if (!/^https:\/\/\*\.[a-z0-9.-]+\/\*$/.test(pattern)) {
          throw new Error(`Generated an invalid exclude_matches pattern: "${pattern}"`);
        }
      }
    },

    /**
     * Keep `dist/` current on EVERY build.
     *
     * `dist` exists because `.output` is deleted and recreated by each build, which can
     * leave Chrome's unpacked load pointing at a directory that no longer exists — the
     * reload button then quietly does nothing and the browser keeps running old code. A
     * stable path avoids that.
     *
     * It was created by a separate `build:dist` npm script, which meant a plain `wxt build`
     * silently left it stale. That is exactly what happened: a full manual test cycle ran
     * against an eleven-hour-old copy while four fixes sat unloaded in `.output`. A second
     * output path is only safe if it cannot fall behind, so it is refreshed here rather
     * than by remembering to use the right script.
     */
    "build:done": (wxt) => {
      const out = wxt.config.outDir;
      const stable = resolve(wxt.config.root, "dist");
      rmSync(stable, { recursive: true, force: true });
      cpSync(out, stable, { recursive: true });
      wxt.logger.info(`Synced ${stable} (load this path in Chrome, not .output)`);
    },
  },
});
