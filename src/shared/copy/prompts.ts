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

  "interference.visual_asymmetry": [
    "The two choices here were not given equal weight on screen. If both had looked the same, which would you have picked?",
    "One option here was far easier to see than the other. Does the quieter one say what you actually want?",
    "The accept and decline controls were styled very differently. Would your answer change if they matched?",
    "One button here was much larger and brighter than the other. Which choice did you come here to make?",
    "The page gave one option more visual weight. Is that the option you would have chosen unprompted?",
  ],

  "decoy.asymmetric_dominance": [
    "One option here is labelled as the popular choice, and it costs more per unit than another. Which works out cheaper for what you need?",
    "The options here are not priced evenly per unit. Have you worked out which is actually the better rate?",
    "A badge marks one plan out from the others. Does the arithmetic agree with the badge?",
    "One of these choices costs more and gives no more than another. What is it doing on the page?",
    "The middle option is highlighted here. Is the amount it offers the amount you want?",
  ],

  "nagging.repeat_interstitial": [
    "This page interrupted you more than once. Has repeating the request changed what you want?",
    "The same kind of prompt has appeared several times here. Would you say yes if it had only asked once?",
    "You have been asked more than once on this page. Is agreeing easier than declining again?",
    "This site has interrupted you repeatedly. Does that tell you anything about the offer itself?",
  ],

  "framing.savings_ratio": [
    "The saving here is shown in whichever form looks larger. What is it in the other form?",
    "This discount is presented one way rather than the other. Does it read the same as a plain amount?",
    "The page picked a way of describing the saving. Do you know what you are actually paying?",
    "This saving looks different as a percentage than as an amount. Which one matters to your budget?",
    "The discount was framed in the flattering direction. What does the other framing say?",
  ],

  "loss_aversion.exit_intent": [
    "This offer appeared as you were about to leave. Would it have interested you before you decided to go?",
    "The page made an offer at the moment you tried to leave. Does the timing change its value?",
    "Something new was offered right as you were leaving. Was the original price the real one?",
    "This appeared only when you moved to close the page. Would you have wanted it a minute ago?",
    "An offer arrived at the exit. Is it better than the reason you were leaving?",
  ],

  // The temporal claims. These are the strongest statements this tool makes, so the wording
  // is the most careful: every one reports what THIS BROWSER observed, and none asserts that
  // the merchant did anything. "The timer showed a different deadline on your last visit" is
  // checkable from our own records. "The timer is fake" would not be.
  "temporal.evergreen_countdown": [
    "This timer showed a different deadline the last time you visited. Does a deadline that moves change what it means to you?",
    "The countdown here has restarted since your last visit. If it resets again tomorrow, is it a deadline?",
    "You have seen this timer before, ending at a different moment. What would you do if there were no clock?",
    "The end time on this timer has moved between your visits. Does the offer feel different now?",
  ],

  "temporal.stock_nonmonotonic": [
    "The number left has gone up as well as down across your visits. Does the count tell you how many there are?",
    "This count has shown the same figure on every visit for over a week. Is it tracking anything you can use?",
    "The remaining-units number has moved in both directions since you first saw it. What would you rely on instead?",
    "You have seen this count before and it did not simply fall. Does it change how quickly you want to decide?",
  ],

  "temporal.reference_price_ungrounded": [
    "The higher price here has not been the actual price on any visit you have made. Is it a useful comparison?",
    "You have seen this item several times and always at the same price. What is the crossed-out number describing?",
    "Across your visits, the was-price has never been the price. Does the saving mean what it appears to?",
    "This item has cost the same every time you looked. Is the comparison price telling you anything?",
  ],

  "temporal.social_proof_synthetic": [
    "The viewer count here has stayed within a very narrow range across your visits. Does it move the way real traffic would?",
    "You have seen this number many times and it barely changes. What would it look like if it were counting people?",
    "This count has been remarkably steady across times of day. Does it tell you anything about demand?",
    "The number of people viewing has varied little over your visits. Would you decide differently without it?",
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
