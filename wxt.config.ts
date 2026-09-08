import { cpSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

interface AllowlistFile {
  version: string;
  entries: { origin: string; category: string; note?: string }[];
}

const allowlist = JSON.parse(
  readFileSync(new URL("./rulepacks/allowlist.v1.json", import.meta.url), "utf8"),
) as AllowlistFile;

/**
 * One pattern per REGISTRABLE DOMAIN, covering subdomains.
 *
 * Exact origins were wrong: granting www.booking.com left secure.booking.com — the actual
 * checkout host — unreadable, so the extension went blind at precisely the funnel stage the
 * cross-stage detectors exist for. Deduping by domain also shrinks the list.
 */
const TWO_PART = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "co.jp",
  "co.in",
  "com.sg",
  "com.hk",
  "com.tr",
  "co.kr",
]);
function registrable(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length <= 2) return parts.join(".");
  return TWO_PART.has(parts.slice(-2).join("."))
    ? parts.slice(-3).join(".")
    : parts.slice(-2).join(".");
}
const matchPatterns = [
  ...new Set(
    allowlist.entries.map((e) => `https://*.${registrable(new URL(e.origin).hostname)}/*`),
  ),
].sort();

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
    },
  }),

  manifest: {
    manifest_version: 3,
    name: "Persuasion Patterns",
    short_name: "Patterns",
    description:
      "Notices persuasion techniques on shopping pages and asks a question about them. Runs on-device; nothing leaves your browser.",
    version: "0.1.0",

    // Justification for each, for the store listing (plan §1.4):
    //   storage            - remember per-site choices and the local event log
    //   scripting          - register the detector script AFTER you grant a site
    //   activeTab          - read the current tab's URL in the popup so it can offer that site
    //   declarativeContent - light up the toolbar icon on shopping URLs WITHOUT reading pages
    permissions: ["storage", "scripting", "activeTab", "declarativeContent"],

    /**
     * Two tiers, per plan §14.2 (curated) and §14.3 Tier B (everything else).
     *
     * The curated domains drive the declarativeContent icon and the commerce score. The
     * broad pattern is what makes Tier B possible at all: chrome.permissions.request can
     * only grant what is declared here, so without it the popup could only ever offer a
     * dead button on any site not in the list — which is exactly what happened in manual
     * testing, twice.
     *
     * This is OPTIONAL. It is not granted at install, produces no install-time warning, and
     * is requested one origin at a time behind a user gesture. The denylist still refuses
     * banking, health, government and mail outright, before any of this is reached.
     */
    optional_host_permissions: [...matchPatterns, "https://*/*"],

    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },

    action: {
      default_title: "Persuasion Patterns",
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
     * THE assertion (plan §1.2). WXT's `registration: 'runtime'` moves content-script
     * `matches` into REQUIRED `host_permissions`, which would produce exactly the
     * install-time warning listing 150 sites that §14.2 exists to avoid. There is no
     * built-in mode that targets `optional_host_permissions` (wxt-dev/wxt#2239).
     *
     * So: move them, then assert. If a future refactor reintroduces a manifest content
     * script, this throws at build time instead of silently shipping a scary install prompt.
     */
    "build:manifestGenerated": (_wxt, manifest) => {
      const m = manifest as chrome.runtime.ManifestV3 & Record<string, unknown>;

      // NOTE: this used to MOVE any leaked host_permissions into
      // optional_host_permissions and then assert the array was empty. The assertion was
      // therefore unreachable dead code — verified by deliberately reintroducing a host
      // permission, which built cleanly and silently downgraded it to optional. Output was
      // safe by accident, but nothing detected the change, and a developer who added a
      // required permission on purpose would have had its semantics quietly altered.
      //
      // The auto-move is also no longer needed: the detector is built with
      // defineUnlistedScript, so nothing injects host permissions in the first place.
      const hosts = (m.host_permissions ?? []) as string[];
      if (hosts.length > 0) {
        throw new Error(
          `host_permissions must be empty (plan §1.2). Found: ${JSON.stringify(hosts)}. ` +
            "Declaring a host permission grants it at install and produces a 150-site " +
            "install warning. Put it in optional_host_permissions and request it at runtime.",
        );
      }

      if (Array.isArray(m.content_scripts) && m.content_scripts.length > 0) {
        throw new Error(
          "No content script may be declared in the manifest — declaring one implicitly " +
            "grants its match patterns at install. Register at runtime instead (plan §1.2).",
        );
      }

      // A broad pattern is acceptable ONLY as an optional permission, never as a required
      // one. Required means granted at install with a warning listing every site; optional
      // means the user grants one origin at a time from the popup.
      const broad = ["<all_urls>", "http://*/*", "https://*/*", "*://*/*"];
      for (const p of (m.permissions ?? []) as string[]) {
        if (broad.includes(p)) {
          throw new Error(`Broad host permission "${p}" must never be a REQUIRED permission.`);
        }
      }
      const optional = (m.optional_host_permissions ?? []) as string[];
      for (const p of optional) {
        if (p === "<all_urls>" || p === "*://*/*" || p === "http://*/*") {
          throw new Error(
            `"${p}" is broader than needed. Only https://*/* is acceptable, and only as optional.`,
          );
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
