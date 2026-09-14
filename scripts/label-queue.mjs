/**
 * Which snippets are worth a human's attention, and in what order.
 *
 * The corpus is ~95% navigation chrome — "Tires", "All Tops", "Camp Chairs". Labelling it
 * raw would be thousands of obvious noes for almost no signal, and the person doing the
 * labelling would (correctly) stop. So recruit first, in three tiers:
 *
 *   A  the current lexicon already matches it. Fast to confirm, and the only place the
 *      existing detectors' FALSE POSITIVES can be found.
 *   B  shares vocabulary with the pattern but does not match. THE valuable tier — this is
 *      precisely where recall is being lost, and it is what a classifier is for.
 *   C  superficially resembles the pattern and almost certainly is not one. Teaches the
 *      boundary; without these a model trained on A and B calls everything positive.
 *
 * Interleaved A/B/C rather than grouped, so a run of forty yeses does not turn into a reflex.
 */

/**
 * The six patterns whose detection is driven by WORDING. anchoring, charm and defaults are
 * structural — a strikethrough, a price ending, a checked box — and a text classifier adds
 * nothing to them, so they are not worth anyone's labelling time.
 */
export const TRAINABLE = [
  {
    id: "scarcity.stock",
    label: "Limited stock message",
    question: "Is this telling you the item is running out?",
    mechanism: "Things that seem rare are valued more than the same thing in plentiful supply.",
    yes: ["Only 3 left in stock", "Almost sold out", "Low stock — order soon"],
    no: ["3 sizes available", "In stock", "Ships in 3 days"],
    strict: [
      /\bonly\s+\d+\s+(?:left|remaining)/i,
      /\balmost (?:sold ?out|gone)/i,
      /\blow (?:in )?stock\b/i,
      /\b\d+\s+(?:items?\s+)?left\b/i,
    ],
    loose: [
      /\bleft\b/i,
      /\bstock\b/i,
      /\bsold ?out\b/i,
      /\bremaining\b/i,
      /\bselling (?:fast|out)\b/i,
      /\bin demand\b/i,
      /\blimited\b/i,
      /\bhurry\b/i,
    ],
  },
  {
    id: "urgency.countdown",
    label: "Countdown or deadline",
    question: "Does this put a deadline on the decision?",
    mechanism: "A visible deadline shortens deliberation and pushes a decision toward now.",
    yes: ["Sale ends in 02:14:33", "Offer expires tonight", "Ends Sunday — 2 days left"],
    no: ["Delivered in 2-3 days", "Open until 9pm", "30-day returns"],
    /**
     * A bare clock time is NOT a countdown. Treating it as one recruited 75 Ticketmaster and
     * SeatGeek showtimes — "Sat, Oct 17 - 6:00 PM" — straight into the tier reserved for
     * likely positives. Seventy-five trivially-no items dressed up as probable yeses is the
     * fastest way to teach someone to stop reading before answering.
     *
     * So: an H:MM:SS duration (clocks are not written that way), or a clock sitting beside
     * language about running out.
     */
    strict: [
      /\b\d{1,3}:\d{2}:\d{2}\b/,
      /\b(?:ends?|expires?|closes?|left|remaining)\b[^.]{0,24}\b\d{1,2}:\d{2}\b/i,
      /\b\d{1,2}:\d{2}\b[^.]{0,24}\b(?:left|remaining|to go)\b/i,
      /\bends? (?:in|today|tonight|soon)\b/i,
      /\bexpires? (?:in|today|tonight|soon)\b/i,
      /\b(?:hurry|last chance|today only|ending soon)\b/i,
      /\bonly \d+ (?:hours?|minutes?|days?) (?:left|remaining)\b/i,
    ],
    loose: [
      /\bends?\b/i,
      /\bexpires?\b/i,
      /\bdeadline\b/i,
      /\blast (?:chance|day|call)\b/i,
      /\btoday only\b/i,
      /\bcountdown\b/i,
      /\bdays? left\b/i,
      /\bact (?:now|fast)\b/i,
    ],
  },
  {
    id: "social_proof.live_activity",
    label: "What other people are doing",
    question: "Is this telling you about other shoppers' behaviour?",
    mechanism: "Seeing what others do is used as evidence about what is correct to do.",
    yes: ["23 people are viewing this", "14 sold in the last hour", "Trending — 200 bought today"],
    no: ["4.5 stars, 230 reviews", "Customer favourite", "Staff pick"],
    strict: [
      /\b\d+\s+(?:people|shoppers|others)\b/i,
      /\bviewing (?:this|now)\b/i,
      /\bsold in the last\b/i,
      /\bbought (?:this )?(?:today|in the last)\b/i,
    ],
    loose: [
      /\bviewing\b/i,
      /\bpopular\b/i,
      /\btrending\b/i,
      /\bothers?\b/i,
      /\bin (?:their|your) (?:cart|bag)\b/i,
      /\bbestsell/i,
      /\bmost[- ]loved\b/i,
    ],
  },
  {
    id: "confirmshaming.decline_copy",
    label: "Loaded way of saying no",
    question: "Does refusing here mean agreeing with something unflattering about yourself?",
    mechanism: "The decline option is written so choosing it means admitting something bad.",
    yes: ["No thanks, I don't want to save money", "I'd rather pay full price", "No, I hate deals"],
    no: ["No thanks", "Close", "Maybe later", "Decline"],
    strict: [
      /\bno,? (?:thanks,? )?i(?:'m| am)? ?(?:don'?t|hate|prefer|would rather|'d rather)\b/i,
      /\bi don'?t (?:want|like|need) to save\b/i,
      /\bfull price\b/i,
    ],
    loose: [
      /\bno thanks\b/i,
      /\bmaybe later\b/i,
      /\bnot (?:now|interested|today)\b/i,
      /\bi'?(?:m|ll) (?:good|pass)\b/i,
      /\bskip\b/i,
      /\bdon'?t want\b/i,
      /\bi'?d rather\b/i,
    ],
  },
  {
    id: "goal_gradient.threshold",
    label: "You're almost at a reward",
    question: "Does this say spending a bit more unlocks something?",
    mechanism: "Effort toward a goal rises as the goal appears closer, pulling spending upward.",
    yes: [
      "You're $12 away from free shipping",
      "Add $2.77 more for free delivery",
      "Spend $50, get 20% off",
    ],
    no: ["Free shipping on all orders", "Shipping: $5.99", "Free returns"],
    strict: [
      /\b(?:add|spend)\s*\$?[\d.,]+\s*more\b/i,
      /\$[\d.,]+\s*(?:away|more)\b/i,
      /\byou'?re\s*\$?[\d.,]+\s*(?:away|from)\b/i,
    ],
    loose: [
      /\bfree (?:shipping|delivery)\b/i,
      /\baway from\b/i,
      /\bunlock\b/i,
      /\bqualif/i,
      /\bspend\b/i,
      /\bmore to\b/i,
      /\balmost there\b/i,
    ],
  },
  {
    id: "bnpl.installments",
    label: "Pay in instalments",
    question: "Is this offering to split the price into smaller payments?",
    mechanism: "Splitting a price into small future payments reduces how much paying now hurts.",
    yes: ["4 interest-free payments of $24.99", "Pay in 4 with Klarna", "From $12/mo with Affirm"],
    no: ["Total: $99.96", "Pay now", "Monthly newsletter"],
    strict: [
      /\b\d\s*(?:interest[- ]free\s+)?(?:payments?|instal?lments?)\s+of\b/i,
      /\bpay in \d\b/i,
      /\b(?:klarna|affirm|afterpay|sezzle|clearpay|quadpay)\b/i,
    ],
    loose: [
      /\binterest[- ]free\b/i,
      /\binstal?lment/i,
      /\bas low as\b/i,
      /\bper month\b/i,
      /\/mo\b/i,
      /\bfinanc/i,
      /\bsplit\b/i,
      /\bpayments?\b/i,
    ],
  },
];

/**
 * Listing-shaped text that no recruiter should treat as a positive signal.
 *
 * Ticketing sites are made of dates, and a date is not a deadline: "Sat, Oct 17 2026 - 6:00
 * PM" is when the concert starts, not when the offer ends.
 */
const LOOKS_LIKE_A_DATE =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b[,.]?\s*\d/i;

/** Sentence-shaped and plausibly promotional — the pool tier C draws its hard negatives from. */
function plausible(text) {
  if (text.length < 8 || text.length > 180) return false;
  if (!/\s/.test(text)) return false; // single words are navigation
  return (
    /\d/.test(text) ||
    /[$£€%]/.test(text) ||
    /\b(?:now|today|free|save|get|only|new|off)\b/i.test(text)
  );
}

/**
 * Build one interleaved queue per pattern.
 *
 * `perPattern` caps the ask. Six patterns at 300 is about an hour of labelling, which is a
 * budget someone actually finishes — and a labelling job that does not get finished produces
 * a model that cannot be trained.
 */
export function buildQueue(rows, { perPattern = 300 } = {}) {
  const out = [];

  for (const p of TRAINABLE) {
    const a = [];
    const b = [];
    const c = [];

    for (const r of rows) {
      const t = r.text;
      // A date-shaped string can still be a genuine negative worth labelling; it just must
      // never be promoted into the tier reserved for likely positives.
      const dated = LOOKS_LIKE_A_DATE.test(t);
      if (!dated && p.strict.some((re) => re.test(t))) a.push(r);
      else if (p.loose.some((re) => re.test(t))) b.push(r);
      else if (plausible(t)) c.push(r);
    }

    // Tier B is the reason this exists, so it gets the largest share. Tier A is capped
    // because confirming the same shape forty times teaches a model very little.
    const wantA = Math.min(a.length, Math.round(perPattern * 0.25));
    const wantB = Math.min(b.length, Math.round(perPattern * 0.5));
    const wantC = Math.min(c.length, perPattern - wantA - wantB);

    const picked = [
      ...a.slice(0, wantA).map((r) => ({ ...r, tier: "A" })),
      ...b.slice(0, wantB).map((r) => ({ ...r, tier: "B" })),
      ...c.slice(0, wantC).map((r) => ({ ...r, tier: "C" })),
    ];

    // Interleave. Forty consecutive obvious noes trains a reflex, and a reflex mislabels the
    // one that is not obvious.
    const shuffled = deterministicShuffle(picked, p.id);
    for (const item of shuffled) out.push({ ...item, patternId: p.id });
  }

  return out;
}

/** Seeded, so re-running the labeller does not reshuffle a half-finished queue. */
function deterministicShuffle(items, seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    h = (Math.imul(h, 48271) + 11) >>> 0;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
