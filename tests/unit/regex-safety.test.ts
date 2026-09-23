import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard against stateful-global-regex bugs across the whole codebase.
 *
 * A regex with the `g` (or `y`) flag carries a mutable `lastIndex`. Reusing one across calls
 * with `.test()` or `.exec()` makes it return alternating results for identical input, it
 * matches, then fails, then matches. That is silent, non-deterministic, and it already cost
 * us once: the PII scrubber re-entered its own global pattern inside a replace callback, so
 * card numbers were REPORTED as redacted while staying in the file.
 *
 * Safe consumers of a global regex: `String.replace` (resets lastIndex on completion) and
 * `String.matchAll` (operates on an internal clone, and throws without `g`).
 * Unsafe: `.test()` and `.exec()` on a shared instance.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".output" || name === ".wxt") continue;
      walk(full, out);
    } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = [...walk("src"), ...walk("scripts")];

/** `const NAME = /.../gi;` or `const NAME = new RegExp(..., "g")` */
function globalRegexNames(source: string): string[] {
  const names = new Set<string>();

  for (const m of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\/(?:\\.|\[[^\]]*\]|[^/\n])+\/([a-z]*)/g,
  )) {
    const flags = m[2] ?? "";
    if (flags.includes("g") || flags.includes("y")) names.add(m[1] as string);
  }

  for (const m of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new RegExp\([\s\S]{0,400}?["'`]([a-z]*)["'`]\s*\)/g,
  )) {
    const flags = m[2] ?? "";
    if (flags.includes("g") || flags.includes("y")) names.add(m[1] as string);
  }

  return [...names];
}

describe("no stateful global regex is reused with .test() or .exec()", () => {
  it("scans every source file", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(20);
  });

  for (const file of SOURCE_FILES) {
    const source = readFileSync(file, "utf8");
    const globals = globalRegexNames(source);
    if (globals.length === 0) continue;

    it(`${file} uses its global regexes safely`, () => {
      for (const name of globals) {
        const unsafe = new RegExp(`\\b${name}\\.(test|exec)\\(`);
        const match = unsafe.exec(source);
        expect(
          match,
          `${file}: "${name}" is a global regex reused with .${match?.[1]}(), lastIndex ` +
            "persists between calls, so identical input alternates between matching and not. " +
            "Use a non-global regex, or String.matchAll.",
        ).toBeNull();
      }
    });
  }
});

describe("regexes consumed by .test()/.exec() are not global", () => {
  it("holds for every call site in the codebase", () => {
    const offenders: string[] = [];

    for (const file of SOURCE_FILES) {
      const source = readFileSync(file, "utf8");
      const globals = new Set(globalRegexNames(source));

      for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\.(test|exec)\(/g)) {
        const name = m[1] as string;
        if (globals.has(name)) offenders.push(`${file}: ${name}.${m[2]}()`);
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("the scrubber's own regexes", () => {
  it("are all global, because they must replace every occurrence", () => {
    // The inverse risk: a NON-global replace pattern would silently redact only the first
    // email on a page and leave the rest.
    const source = readFileSync("scripts/fixture-lib.ts", "utf8");
    const patterns = [...source.matchAll(/pattern:\s*\/((?:\\.|\[[^\]]*\]|[^/\n])+)\/([a-z]*)/g)];
    expect(patterns.length).toBeGreaterThan(8);
    for (const p of patterns) {
      expect(p[2] ?? "", `pattern /${p[1]}/ is missing the g flag`).toContain("g");
    }
  });

  it("resets lastIndex before each pass so a prior run cannot skip a match", () => {
    const source = readFileSync("scripts/fixture-lib.ts", "utf8");
    expect(source).toContain("rule.pattern.lastIndex = 0;");
  });
});
