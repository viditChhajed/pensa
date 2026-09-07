#!/usr/bin/env node
/**
 * Normalise and scrub a captured fixture in place (plan §6).
 *
 *   npx tsx scripts/normalize-fixture.ts tests/fixtures/<detector>/<pos|neg>/<slug>.html
 *
 * Prints every redaction it made. Read that list before committing — the regexes are a first
 * pass, not a guarantee, and a human eye on the diff is part of the protocol.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalise, scrub } from "./fixture-lib";

const FROZEN_EPOCH = 1_800_000_000_000; // fixed point so countdown fixtures are deterministic

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: normalize-fixture.ts <file.html> [...]");
    process.exit(2);
  }

  let totalHits = 0;

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const structured = normalise(original, { freezeClockTo: FROZEN_EPOCH });
    const { output, hits } = scrub(structured);

    writeFileSync(file, output);
    totalHits += hits.length;

    const delta = original.length - output.length;
    console.log(`${file}  ${original.length} -> ${output.length} bytes (${delta} removed)`);
    if (hits.length === 0) {
      console.log("  no PII patterns matched");
    } else {
      for (const h of hits) console.log(`  redacted [${h.rule}] ${h.match}`);
    }
  }

  if (totalHits > 0) {
    console.log(
      `\n${totalHits} redaction(s). Read the diff before committing — this scrub is a first pass, not a guarantee.`,
    );
  }
}

main();
