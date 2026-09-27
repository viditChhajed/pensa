import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The reader and the schema have to agree on what exists.
 *
 * `scripts/dataset.mjs` refuses any view it does not know, which is the right default (a typo
 * should not become an arbitrary query). The cost is that a view added to schema.sql is
 * invisible until the script is told about it, which is exactly what happened when the
 * outcome views shipped: `npm run dataset --view pattern_add_rate` answered "Unknown view".
 */
describe("the dataset reader knows every view the schema defines", () => {
  const schema = readFileSync("server/cloudflare/schema.sql", "utf8");
  const script = readFileSync("scripts/dataset.mjs", "utf8");

  const defined = [...schema.matchAll(/create view if not exists (\w+)/g)].map((m) => m[1]);

  it("defines views at all (guards the regex, not the code)", () => {
    expect(defined.length).toBeGreaterThanOrEqual(7);
  });

  it("offers each of them by name", () => {
    const missing = defined.filter((v) => !script.includes(`"${v}"`));
    expect(
      missing,
      `views in schema.sql that dataset.mjs will refuse: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("offers the underlying tables too", () => {
    for (const table of ["counts", "outcomes"]) {
      expect(script.includes(`"${table}"`), `dataset.mjs cannot read ${table}`).toBe(true);
    }
  });
});
