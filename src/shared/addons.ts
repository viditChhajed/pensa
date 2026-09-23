/**
 * What counts as an optional add-on, in one place.
 *
 * Three things need the same answer and used to have no shared one: the price-summary
 * classifier deciding a cart line is `optional_addon`, the page listener noticing that the
 * shopper ticked or clicked something add-on-shaped, and the worker deciding whether a given
 * add-on line was the shopper's own choice. If those three drift, attribution silently stops
 * matching, which is precisely how the previous version failed: it compared hashes of
 * add-to-cart BUTTON labels against hashes of cart LINE labels, two strings that can never be
 * equal, and so treated every add-on in every cart as one the shopper never asked for.
 *
 * Each key is a family, not a spelling. "Protection plan", "extended protection" and
 * "accident protection" are all `protection`, so a click on "Add 2-year protection" can be
 * matched to a cart line reading "Accident Protection Plan".
 */

export type AddonKey =
  | "protection"
  | "warranty"
  | "insurance"
  | "gift_wrap"
  | "tip"
  | "donation"
  | "carbon_offset"
  | "expedited"
  | "signature";

const ADDON_PATTERNS: readonly (readonly [AddonKey, RegExp])[] = [
  ["protection", /\bprotection(?: plan)?\b/],
  ["warranty", /\bwarranty\b/],
  ["insurance", /\binsurance\b|\binsured\b/],
  ["gift_wrap", /\bgift[- ]?wrap(?:ping)?\b|\bgift (?:box|bag|message)\b/],
  // Word-bounded on purpose. The old defaults lexicon matched "tip" as a substring, so
  // "Ship to multiple addresses" read as a tip.
  ["tip", /\btips?\b|\bgratuity\b/],
  ["donation", /\bdonat(?:e|ion)\b|\bround up\b/],
  [
    "carbon_offset",
    /\bcarbon (?:offset|neutral)\b|\boffset (?:my|your|the)? ?(?:carbon|emissions)\b/,
  ],
  [
    "expedited",
    /\bexpedited\b|\bpriority (?:shipping|handling|processing)\b|\brush (?:order|processing)\b/,
  ],
  ["signature", /\bsignature (?:confirmation|required)\b/],
];

/** The raw patterns, for the price-summary lexicon, which classifies by regex list. */
export const ADDON_REGEXES: readonly RegExp[] = ADDON_PATTERNS.map(([, re]) => re);

/** Every add-on family the text names. Empty if none. Expects any casing. */
export function addonKeysOf(text: string): AddonKey[] {
  const lower = text.toLowerCase();
  const keys: AddonKey[] = [];
  for (const [key, re] of ADDON_PATTERNS) {
    if (re.test(lower)) keys.push(key);
  }
  return keys;
}

export function isAddonText(text: string): boolean {
  return addonKeysOf(text).length > 0;
}
