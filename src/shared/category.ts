/**
 * Which shop a URL belongs to, and what kind of shop it is. Worker and popup only.
 *
 * Kept out of `urlScore.ts` deliberately: that file ships in the content script on every page
 * load, and the allowlist table plus a Public Suffix List have no business there.
 */
import allowlistJson from "../../rulepacks/allowlist.v1.json";
import { registrableDomain } from "./domain";
import type { OriginCategory } from "./schema";

const allowlist = allowlistJson as {
  version: string;
  entries: { origin: string; category: OriginCategory; note?: string }[];
};

export const ALLOWLIST_VERSION = allowlist.version;

/**
 * Keyed by registrable domain, so us.shein.com and www.shein.com are the same shop.
 */
const DOMAIN_TO_CATEGORY = new Map<string, OriginCategory>(
  allowlist.entries.map((e) => [registrableDomain(new URL(e.origin).hostname), e.category]),
);

export function categoryForOrigin(origin: string): OriginCategory | undefined {
  try {
    return DOMAIN_TO_CATEGORY.get(registrableDomain(new URL(origin).hostname));
  } catch {
    return undefined;
  }
}
