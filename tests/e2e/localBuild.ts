/**
 * Stage a test-only copy of the build that will actually run on `http://localhost`.
 *
 * Two separate things have to be patched, and missing the second one is what broke thirteen
 * specs the day the permission model changed.
 *
 * `host_permissions` is the obvious one: the production manifest asks for the broad https pattern, and
 * the fixture server speaks plain http. But the detector is now injected by a content script
 * DECLARED IN THE MANIFEST, whose `matches` are https-only too — so patching the permission
 * alone buys the right to read a page that nothing is ever injected into. The symptom is a
 * test that loads a fixture, waits, and finds no card, which reads exactly like a detector
 * regression and is not one.
 *
 * `exclude_matches` is left strictly alone. It carries the denylist, it is the load-bearing
 * control in the new permission model, and a test helper that quietly strips it would let a
 * regression in the one place the project cannot afford one sail through green.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The fixture origin, and why it is not localhost.
 *
 * It WAS localhost, and that quietly stopped working the moment the detector grew a runtime
 * denylist check at the top of its body. `isDenied()` refuses localhost and 127.0.0.1 — which
 * is correct and deliberate for the product: a router admin page or a local dev service is
 * exactly the kind of thing Pensa must never read. The fixtures were being served from a host
 * the extension is designed to refuse, so every fixture-backed spec failed with an empty
 * extension log and no other clue.
 *
 * Every fixture request is fulfilled by `page.route`, so the hostname is arbitrary — nothing
 * is resolved and nothing leaves the machine. Moving the fixtures is therefore free, and it
 * is the honest fix: weakening the denylist to make tests pass would have removed the check
 * from the one place that covers the rules `exclude_matches` cannot express.
 */
export const FIXTURE_ORIGIN = "http://shop.example.com";
export const LOCAL_ORIGINS = ["http://shop.example.com/*"];

/**
 * Copy `.output/chrome-mv3` somewhere disposable and make it run on the local origins.
 * Returns the directory to hand to `--load-extension`.
 */
export function stageLocalBuild(
  prefix: string,
  origins: string[] = LOCAL_ORIGINS,
  /**
   * Origins the WORKER must be able to reach, but where no content script should run — the
   * telemetry sink being the only current case. Kept separate because conflating "where Pensa
   * reads pages" with "what Pensa may contact" is exactly the distinction the zero-egress
   * tests exist to police.
   */
  extraPermissions: string[] = [],
): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(resolve(".output/chrome-mv3"), dir, { recursive: true });

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    host_permissions?: string[];
    content_scripts?: { matches?: string[]; exclude_matches?: string[] }[];
  };

  // The native permission dialog cannot be driven by automation, so the grant is baked in.
  manifest.host_permissions = [...origins, ...extraPermissions];

  const scripts = manifest.content_scripts ?? [];
  if (scripts.length === 0) {
    throw new Error(
      "The built manifest declares no content script. This helper exists to widen its " +
        "matches to the fixture origin; if injection moved back to runtime registration, this " +
        "helper is lying to every test that uses it.",
    );
  }
  for (const cs of scripts) {
    cs.matches = [...origins];
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}
