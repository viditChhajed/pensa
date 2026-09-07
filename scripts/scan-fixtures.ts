#!/usr/bin/env node
/**
 * CI gate over the committed fixture tree (plan §6).
 *
 * Fails the build if any fixture still matches a PII pattern, so a fixture added without
 * running the normaliser cannot merge. This is the backstop for the one step of the protocol
 * that depends on a human remembering.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findPii } from "./fixture-lib";

const ROOT = "tests/fixtures";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".html") || full.endsWith(".json")) out.push(full);
  }
  return out;
}

function main(): void {
  const files = walk(ROOT);
  if (files.length === 0) {
    console.log(`no fixtures under ${ROOT}/ — nothing to scan`);
    return;
  }

  let failures = 0;
  for (const file of files) {
    const hits = findPii(readFileSync(file, "utf8"));
    if (hits.length > 0) {
      failures += hits.length;
      console.error(`FAIL ${file}`);
      for (const h of hits) console.error(`  [${h.rule}] ${h.match}`);
    }
  }

  console.log(`scanned ${files.length} fixture file(s)`);
  if (failures > 0) {
    console.error(
      `\n${failures} PII pattern(s) found. Run: npx tsx scripts/normalize-fixture.ts <file>`,
    );
    process.exit(1);
  }
  console.log("clean");
}

main();
