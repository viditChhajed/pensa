/**
 * Build every store package, with the report address compiled in.
 *
 *   npm run release
 *
 * Writes, into .output:
 *   pensa-<version>-chrome.zip    upload to the Chrome Web Store AND to Edge Add-ons (same file)
 *   pensa-<version>-firefox.zip   upload to addons.mozilla.org
 *   pensa-<version>-sources.zip   upload to AMO alongside it, when it asks for source code
 *
 * A plain `npm run zip` compiles the send path out, and that has already shipped once by
 * mistake. This is the one command that makes store zips, and it checks each one before
 * saying it is done.
 *
 *   node scripts/release.mjs --firefox-build
 *
 * is what Mozilla's reviewers run from the sources zip (see SOURCE-BUILD.md): the same
 * Firefox build, unzipped, to compare against the uploaded file.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENDPOINT =
  process.env.TELEMETRY_ENDPOINT ?? "https://pensa-counts.viditchhajed.workers.dev/counts";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// Pinned rather than the clock, so a rebuild from source is byte-for-byte the same.
const env = { ...process.env, TELEMETRY_ENDPOINT: ENDPOINT, BUILD_STAMP: `release ${version}` };

const wxt = (...args) => execFileSync("npx", ["wxt", ...args], { stdio: "inherit", env });

if (process.argv.includes("--firefox-build")) {
  wxt("build", "-b", "firefox");
  console.log("\n  Firefox build: .output/firefox-mv3\n");
  process.exit(0);
}

wxt("zip");
wxt("zip", "-b", "firefox");

const out = (name) => resolve(".output", `pensa-${version}-${name}.zip`);
const unzip = (zip, file) => execFileSync("unzip", ["-p", zip, file], { encoding: "utf8" });
const list = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n");

function check(ok, what) {
  if (!ok) {
    console.error(`\n  RELEASE CHECK FAILED: ${what}\n`);
    process.exit(1);
  }
}

for (const name of ["chrome", "firefox"]) {
  const zip = out(name);
  const manifest = JSON.parse(unzip(zip, "manifest.json"));
  check(manifest.version === version, `${name} zip is version ${manifest.version}`);
  check(unzip(zip, "background.js").includes(ENDPOINT), `${name} zip has no report address`);
  const bss = manifest.browser_specific_settings;
  if (name === "chrome") {
    check(manifest.background?.service_worker, "chrome zip has no service worker");
    check(!bss, "chrome zip carries Firefox settings");
  } else {
    check(manifest.background?.scripts, "firefox zip has no background script");
    check(bss?.gecko?.id, "firefox zip has no add-on id");
    check(bss?.gecko?.data_collection_permissions, "firefox zip declares no data collection");
  }
  check(manifest.options_ui?.open_in_tab === true, `${name} zip opens Settings in a dialog`);
}

const sources = list(out("sources"));
check(sources.includes("SOURCE-BUILD.md"), "sources zip has no build instructions");
check(sources.includes("package-lock.json"), "sources zip has no lockfile");
for (const f of sources) {
  check(!/^(corpus|dataset|research|server|store|tests|dist)\//.test(f), `sources zip has ${f}`);
}

// Leave .output/chrome-mv3 as the endpoint-free build the tests assert against.
execFileSync("npx", ["wxt", "build"], {
  stdio: "inherit",
  env: { ...process.env, TELEMETRY_ENDPOINT: "" },
});

console.log(`
  Chrome Web Store and Edge Add-ons: ${out("chrome")}
  Firefox Add-ons:                   ${out("firefox")}
  Firefox source code:               ${out("sources")}
  Reports go to: ${ENDPOINT}
`);
