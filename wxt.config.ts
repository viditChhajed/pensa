import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

interface AllowlistFile {
  version: string;
  entries: { origin: string; category: string; note?: string }[];
}

const allowlist = JSON.parse(
  readFileSync(new URL("./rulepacks/allowlist.v1.json", import.meta.url), "utf8"),
) as AllowlistFile;

/** `https://www.example.com` -> `https://www.example.com/*` */
const matchPatterns = allowlist.entries.map((e) => `${e.origin}/*`);

export default defineConfig({
  srcDir: "src",
  modules: [],
  vite: () => ({ plugins: [preact()] }),

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

    // The whole point of §14.2: near-empty install prompt. These are requested one at a
    // time, from a popup button, only when the user asks.
    optional_host_permissions: matchPatterns,

    action: {
      default_title: "Persuasion Patterns",
      default_popup: "popup.html",
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

      const leaked = (m.host_permissions ?? []) as string[];
      if (leaked.length > 0) {
        const optional = new Set((m.optional_host_permissions ?? []) as string[]);
        for (const p of leaked) optional.add(p);
        m.optional_host_permissions = [...optional].sort();
        m.host_permissions = [];
      }

      if (Array.isArray(m.host_permissions) && m.host_permissions.length > 0) {
        throw new Error(
          `host_permissions must be empty (plan §1.2). Found: ${JSON.stringify(m.host_permissions)}`,
        );
      }

      if (Array.isArray(m.content_scripts) && m.content_scripts.length > 0) {
        throw new Error(
          "No content script may be declared in the manifest — declaring one implicitly " +
            "grants its match patterns at install. Register at runtime instead (plan §1.2).",
        );
      }

      const broad = ["<all_urls>", "http://*/*", "https://*/*", "*://*/*"];
      const all = [
        ...((m.optional_host_permissions ?? []) as string[]),
        ...((m.permissions ?? []) as string[]),
      ];
      for (const p of all) {
        if (broad.includes(p)) {
          throw new Error(`Broad host permission "${p}" is never acceptable (plan §2).`);
        }
      }
    },
  },
});
