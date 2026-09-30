/**
 * Was this finding presented so that a shopper would notice it?
 *
 * From the first human spot-check: Shein's "Almost sold out" was true, on screen for 22
 * seconds, and "written very small on the site, I didn't even notice it". Dwell could not
 * tell it apart from the cards the tester rated worth it, because every one of them was fully
 * in view for seconds. Something printed so it will not register is not persuading anyone, and
 * interrupting a person to point at it spends the card on nothing.
 *
 * Why this is RELATIVE, measured on live pages before writing it:
 *
 *   - Shein's whole page is small: median text 12-13px, the price and the title 14px. A fixed
 *     "under 12px" rule would call half of Shein fine print.
 *   - StubHub's "Only 2 left" and "Last tickets" are 12px, weight 500, on a page whose median is
 *     also 12px, and the tester wanted them shown. They stand out because they sit in red pills.
 *
 * So a finding is inconspicuous only when ALL THREE hold: its text is smaller than the page's
 * own text, it is not bold, and it is not set on a background of its own. Size alone would hide
 * StubHub's badges; each of the other two is how a page makes small text stand out on purpose.
 *
 * Pure: page statistics come from the harvested candidates, so this reads no DOM.
 */
import type { CandidateNode } from "./types";

/** Smaller than this share of the page's median text size reads as fine print. */
export const RELATIVE_SIZE_FLOOR = 0.9;
/** From here up, weight is emphasis a reader notices. */
const BOLD = 600;

export interface PageTextStats {
  /** Median font size of the page's text candidates, in px. */
  medianFontPx: number;
  /** The most common resolved background: what "on the page itself" looks like. */
  pageBackground: string;
}

export function pageTextStats(candidates: readonly CandidateNode[]): PageTextStats {
  const sizes: number[] = [];
  const backgrounds = new Map<string, number>();
  for (const n of candidates) {
    if (n.text.trim().length === 0) continue;
    if (Number.isFinite(n.style.fontSizePx) && n.style.fontSizePx > 0)
      sizes.push(n.style.fontSizePx);
    const bg = n.style.effectiveBackground;
    backgrounds.set(bg, (backgrounds.get(bg) ?? 0) + 1);
  }
  sizes.sort((a, b) => a - b);
  let pageBackground = "";
  let most = 0;
  for (const [bg, count] of backgrounds) {
    if (count > most) {
      most = count;
      pageBackground = bg;
    }
  }
  return { medianFontPx: sizes[Math.floor(sizes.length / 2)] ?? 0, pageBackground };
}

export interface Prominence {
  /** Font size relative to the page median. 1 = the same as the page's own text. */
  relativeSize: number;
  /** False when the finding is fine print: smaller, not bold, and not set apart. */
  prominent: boolean;
}

export function prominenceOf(node: CandidateNode, stats: PageTextStats): Prominence {
  const relativeSize =
    stats.medianFontPx > 0
      ? Math.round((node.style.fontSizePx / stats.medianFontPx) * 100) / 100
      : 1;
  const smaller = relativeSize < RELATIVE_SIZE_FLOOR;
  const bold = node.style.fontWeight >= BOLD;
  const setApart =
    stats.pageBackground !== "" && node.style.effectiveBackground !== stats.pageBackground;
  return { relativeSize, prominent: !(smaller && !bold && !setApart) };
}
