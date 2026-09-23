/**
 * Which patterns the settings page offers a switch for, and how they are grouped.
 *
 * Separated from `main.ts` purely so it can be asserted on. `main.ts` touches the DOM at
 * module scope, so a test cannot import it; without this split the only way to check that
 * every shipped detector is reachable from the settings page would be to read the file and
 * trust it, which is how a detector ships with no off switch.
 *
 * Grouped by WHAT EACH ONE NEEDS in order to say anything, not by the taxonomy's tiers.
 * Tier is an internal confidence ranking and means nothing to the person reading this page.
 * What they will notice is that two of these groups stay quiet for a while, the cross-stage
 * pair needs you to move from a product to a cart before it has two prices to compare, and
 * the history group needs a second visit to the same item. Grouping them this way makes
 * "why has this never fired?" answerable from the page itself.
 */
import {
  DERIVED_FROM_HISTORY,
  SHIPPED_CROSS_STAGE_DETECTORS,
  SHIPPED_PAGE_DETECTORS,
} from "@/shared/scope";

export interface PatternGroup {
  title: string;
  note?: string;
  ids: readonly string[];
}

export const PATTERN_GROUPS: readonly PatternGroup[] = [
  { title: "On the page in front of you", ids: SHIPPED_PAGE_DETECTORS },
  {
    title: "Across a checkout flow",
    note: "These compare one page against the next, so they stay quiet until you move from a product to a cart.",
    ids: SHIPPED_CROSS_STAGE_DETECTORS,
  },
  {
    title: "Across repeat visits",
    note: "These compare today against what this site showed you before, so they say nothing until you have seen the same item more than once.",
    ids: DERIVED_FROM_HISTORY,
  },
];
