/**
 * Socratic prompt pools (plan §9, T27).
 *
 * Every string here is enforced by `tests/unit/copy-lint.test.ts`:
 *   - must end in a question mark
 *   - must not contain any banned word (scam, trick, deceptive, fake, manipulat*, …)
 *   - must not be an imperative ("don't buy this")
 *   - must read at roughly grade 8
 *
 * The shape is always: one observational clause about what the page displayed, then a
 * question. The observation is checkable and the question is open. Neither asserts intent.
 *
 * 4-6 variants per pattern, sampled without replacement within a session, so a repeat user
 * is not shown the same sentence every time they check out.
 */
import type { PatternId } from "../taxonomy";

export const PROMPTS: Partial<Record<PatternId, readonly string[]>> = {
  "anchoring.reference_price": [
    "This page showed a crossed-out higher price next to the one you would pay. If you had only seen the price you are being asked for, would it still seem right?",
    "There was a higher price shown next to this one. What would you have been willing to pay if that number were not on the page?",
    "The page displayed a was-price above the current price. Do you know what this item usually sells for?",
    "A higher price was shown alongside this one. Is the item worth the asking price on its own terms?",
    "This listing set up a comparison with a higher number. Would the deal still appeal if the comparison were missing?",
    "The page framed this price against a larger one. What would you compare it to instead?",
  ],

  "pricing.charm": [
    "This price ends just below a round number. If it were rounded up to the next dollar, would you still want it?",
    "The page priced this a cent under a round figure. Does the first digit change how the cost feels?",
    "This ends in .99 rather than a whole number. What would you say the price is, rounded?",
    "The cents here sit just under the next dollar. Would you notice the difference if it were a dollar more?",
    "This price stops short of a round number. Does that change what you think it costs?",
  ],

  "scarcity.stock": [
    "This page said the stock was limited. If the same item were available next week, would you still buy it today?",
    "A limited-availability message was shown. How would you decide if that message were not there?",
    "The page said only a few were left. Does knowing that change what the item is worth to you?",
    "There was a low-stock note on this page. Would you still want this if it were always in stock?",
    "This listing mentioned limited supply. What would you do if you found out tomorrow it was still available?",
    "The page signalled that stock was running out. Is that affecting how quickly you are deciding?",
  ],

  "urgency.countdown": [
    "This page showed a timer counting down. If the price were the same tomorrow, does the timer change what the item is worth to you?",
    "A countdown was running on this page. How much time would you want to think this over?",
    "The page displayed a deadline. Would you make the same choice with a week to decide?",
    "There was a clock counting down here. Is the deadline changing your answer, or only your speed?",
    "This offer was shown with a time limit. What would you decide if there were no limit?",
    "A timer was visible while you browsed. Would you still choose this if the timer restarted every visit?",
  ],

  "social_proof.live_activity": [
    "This page showed how many other people were looking at this. Does what others are doing tell you whether it suits you?",
    "A live activity notice appeared here. Would this be right for you if nobody else were buying it?",
    "The page reported other shoppers viewing this item. How would you judge it without that number?",
    "There was a note about recent purchases. Does that tell you anything about the item itself?",
    "This listing showed activity from other people. What do you need to know that their choices cannot tell you?",
  ],

  "defaults.preselected": [
    "An option was already selected for you here. If it had started unselected, would you have added it yourself?",
    "This page pre-selected a choice. Is it the one you would have picked?",
    "Something was ticked before you arrived. Would you notice if you did not look for it?",
    "A default was set on your behalf. What would you choose starting from nothing?",
    "This form came with an option already on. Do you want what it adds?",
    "One choice was made for you in advance. Is it the one you want?",
  ],

  "confirmshaming.decline_copy": [
    "The option to say no here was worded to describe you. Does the wording change what you actually want?",
    "This page phrased declining as a statement about yourself. What would you choose if it just said no?",
    "The decline option carried a judgement. Would your answer differ if both choices were worded plainly?",
    "Saying no here meant agreeing with something about you. Is that description accurate?",
    "The two options were not worded evenly. Which would you pick if they were?",
  ],

  "goal_gradient.threshold": [
    "This page showed how much more you would need to spend to reach a reward. Would you have bought that much otherwise?",
    "A spending threshold was shown here. Does reaching it cost less than what it saves?",
    "The page tracked your progress toward free shipping. Is the extra item something you wanted?",
    "There was a target to unlock here. What would you have added if there were no target?",
    "This showed you how close you were to a threshold. Is the shipping worth what it takes to earn it?",
  ],

  "bnpl.installments": [
    "This price was also shown as smaller payments over time. Does the full amount still fit your budget?",
    "The page offered to split this cost into instalments. What is the total across every payment?",
    "A pay-later option was displayed. Would you buy this if the whole amount were due today?",
    "This was presented as a monthly figure. How does the total compare with what you meant to spend?",
    "The cost was broken into parts here. Do you know what you would owe in three months?",
  ],

  "pricing.drip": [
    "Charges appeared later here that were not in the first price you saw. Is the total still what you expected?",
    "The final amount includes fees added after the starting price. Would you have compared differently knowing the total up front?",
    "Extra charges were disclosed further along. What was the price when you started?",
    "The total grew between the listing and this page. Does it still compare well with other options?",
    "Fees were added after the first number you saw. Is this still the option you would choose?",
  ],

  "basket.sneak": [
    "There is an item here you may not have added. Did you choose it?",
    "Something in this order does not match anything you selected. Do you want it?",
    "An extra line appeared in the order. Is it one you asked for?",
    "This order includes an addition that was not part of what you added. Should it be there?",
  ],
};

/**
 * Pick a variant that has not been used this session, so a repeat user sees fresh wording.
 * Falls back to reuse once the pool is exhausted, rather than showing nothing.
 */
export function pickPrompt(
  patternId: PatternId,
  used: ReadonlySet<string>,
  random: () => number = Math.random,
): string | null {
  const pool = PROMPTS[patternId];
  if (!pool || pool.length === 0) return null;

  const unused = pool.filter((p) => !used.has(p));
  const from = unused.length > 0 ? unused : pool;
  const idx = Math.min(from.length - 1, Math.floor(random() * from.length));
  return from[idx] ?? null;
}

export const PROMPTED_PATTERNS = Object.keys(PROMPTS) as PatternId[];
