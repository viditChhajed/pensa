/**
 * Denylist -> MV3 match patterns, for the content script's `exclude_matches`.
 *
 * MV3 host permissions have no exclusion syntax: once the broad https pattern is granted at
 * install there is no manifest field that says "…except these". `exclude_matches` on the content
 * script is the only place Chrome will refuse to inject on our behalf, and it is worth
 * having because it is the ONLY layer that stops our code from ever touching the page. The
 * runtime `isDenied()` bail-out in the detector runs after injection has already happened.
 *
 * The conversion is deliberately incomplete, and says so. A match pattern can express
 * "this host and its subdomains" and nothing else — no substring wildcards inside a DNS
 * label, no "this label under any TLD", no alternation. Most of the denylist is regexes of
 * exactly those shapes, so most of it CANNOT be expressed here. What comes back in
 * `inexpressible` is not covered by Chrome at all and is covered only by the runtime check.
 *
 * Nothing here is allowed to guess. A regex that does not match one of the two shapes below
 * is reported as inexpressible rather than approximated, because an approximation that is
 * too broad silently kills legitimate sites and one that is too narrow silently ships a
 * denylist entry that does nothing.
 */

export interface DenylistShape {
  hostSuffixes: string[];
  hostPatterns: string[];
  schemes: string[];
}

export interface ExcludeConversion {
  /** Valid MV3 match patterns, sorted and deduped. Safe to put in `exclude_matches`. */
  matches: string[];
  /** Denylist regexes with no match-pattern equivalent. Runtime-only coverage. */
  inexpressible: string[];
}

/**
 * `(^|\.)(chase|bofa)\.com$`            -> chase.com, bofa.com
 * `(^|\.)(facebook|x)\.(com|app)$`      -> facebook.com, facebook.app, x.com, x.app
 *
 * The `(^|\.)` prefix is the denylist's own label-anchoring convention, and it means exactly
 * what `*.host` means in a match pattern: the bare host, or any subdomain of it.
 */
const LABELS_WITH_TLD = /^\(\^\|\\\.\)\(([a-z0-9|-]+)\)\\\.(?:\(([a-z0-9|]+)\)|([a-z0-9-]+))\$$/;

/** `\.local$` -> any host under `.local`. Same meaning as a hostSuffix entry. */
const BARE_SUFFIX = /^\\\.([a-z0-9-]+)\$$/;

/** A hostname is a match-pattern host only if every label is plain. Belt and braces. */
const PLAIN_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function toExcludeMatches(denylist: DenylistShape): ExcludeConversion {
  const hosts = new Set<string>();
  const inexpressible: string[] = [];

  // `.gov` -> `*.gov`, which in match-pattern terms covers `gov` itself and every subdomain.
  // The denylist's own suffix test is `host === suffix.slice(1) || host.endsWith(suffix)`,
  // which is the same set.
  for (const suffix of denylist.hostSuffixes) {
    hosts.add(suffix.replace(/^\./, ""));
  }

  for (const pattern of denylist.hostPatterns) {
    const labelled = LABELS_WITH_TLD.exec(pattern);
    if (labelled) {
      const names = (labelled[1] ?? "").split("|").filter(Boolean);
      const tlds = (labelled[2] ?? labelled[3] ?? "").split("|").filter(Boolean);
      for (const name of names) {
        for (const tld of tlds) hosts.add(`${name}.${tld}`);
      }
      continue;
    }

    const suffix = BARE_SUFFIX.exec(pattern);
    if (suffix?.[1]) {
      hosts.add(suffix[1]);
      continue;
    }

    inexpressible.push(pattern);
  }

  const matches = [...hosts]
    .filter((h) => PLAIN_HOST.test(h) || /^[a-z0-9-]+$/.test(h))
    .map((h) => `https://*.${h}/*`)
    .sort();

  return { matches, inexpressible };
}
