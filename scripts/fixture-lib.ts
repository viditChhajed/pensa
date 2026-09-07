/**
 * Fixture normalisation and PII scrubbing (plan §6).
 *
 * Fixtures are captured from REAL retailer pages, which means they can contain real personal
 * data — the capturer's own if they were signed in, and third parties' regardless (reviewer
 * names, avatars, Q&A authors). Committing that to a repository is the kind of mistake that
 * is trivial to make and impossible to fully undo, so the scrub runs before commit and CI
 * fails the build on any hit.
 *
 * Deliberately conservative: it over-redacts. A fixture with a placeholder where a price
 * should be is a broken test that someone fixes in a minute. A fixture with a stranger's
 * home address is a different kind of problem.
 */

export interface ScrubHit {
  rule: string;
  match: string;
  index: number;
}

export interface ScrubResult {
  output: string;
  hits: ScrubHit[];
}

/** Luhn check, so a 16-digit product id is not mistaken for a card number. */
export function isLuhnValid(digits: string): boolean {
  const s = digits.replace(/\D/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /**
   * Receives the whole match plus its capture groups and returns the replacement.
   *
   * A function, always. An earlier version accepted a string and applied it by calling
   * `match.replace(rule.pattern, ...)` inside the outer replace callback — but `pattern` is
   * a stateful global regex, so re-entering it there mutated `lastIndex` and the
   * substitution silently did nothing. Card numbers were reported as redacted while
   * remaining in the file, which is the worst failure mode a privacy control can have.
   */
  replace: (match: string, groups: string[]) => string;
  /** Extra test beyond the regex — used to Luhn-check card-shaped runs. */
  guard?: (m: string) => boolean;
}

const RULES: Rule[] = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => PLACEHOLDER.email,
  },
  {
    name: "card-number",
    // Only replaced when it passes Luhn — order numbers are frequently 16 digits.
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    replace: () => PLACEHOLDER.card,
    guard: (m) => isLuhnValid(m),
  },
  {
    name: "phone-us",
    pattern: /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
    replace: () => PLACEHOLDER.phone,
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replace: () => PLACEHOLDER.ssn,
  },
  {
    name: "postal-us",
    pattern: /\b\d{5}(?:-\d{4})?\b(?=[^\d]*(?:zip|postal|address)|\s*(?:,|<))/gi,
    replace: () => PLACEHOLDER.postal,
  },
  {
    name: "street-address",
    pattern:
      /\b\d{1,5}\s+[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter)\b\.?/g,
    replace: () => PLACEHOLDER.address,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => PLACEHOLDER.jwt,
  },
  {
    name: "set-cookie",
    pattern:
      /\b(?:session|sess|sid|auth|token|jwt|csrf|xsrf)[_-]?(?:id|token)?=[A-Za-z0-9._%-]{8,}/gi,
    replace: () => PLACEHOLDER.cookie,
  },
  {
    name: "account-token",
    // 8+ alphanumeric adjacent to an account-ish word.
    pattern:
      /\b(order|account|member|customer|loyalty|reward|invoice|confirmation)([\s#:_-]{1,3})([A-Za-z0-9]{8,})\b/gi,
    replace: (_m, g) => `${g[0] ?? ""}${g[1] ?? " "}${PLACEHOLDER.token}`,
  },
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    replace: () => PLACEHOLDER.bearer,
  },
];

/** Reviewer names and avatars in JSON-LD — third-party personal data is still personal data. */
const JSONLD_PERSON_RULES: Rule[] = [
  {
    name: "jsonld-person-name",
    pattern:
      /("(?:author|reviewedBy|creator)"\s*:\s*\{[^}]*?"name"\s*:\s*")(?!\[name redacted\])([^"]{1,80})(")/g,
    replace: (_m, g) => `${g[0] ?? ""}${PLACEHOLDER.person}${g[2] ?? '"'}`,
  },
  {
    name: "jsonld-avatar",
    pattern: /("(?:image|photo|avatar)"\s*:\s*")https?:\/\/[^"]{1,300}(")/g,
    replace: (_m, g) => `${g[0] ?? ""}${PLACEHOLDER.avatar}${g[1] ?? '"'}`,
  },
];

/**
 * Every placeholder is deliberately shaped so it CANNOT match the rule that produced it.
 *
 * This is not cosmetic. `scan-fixtures` fails CI on any hit, so if the replacement for a card
 * number were itself a valid card number — as "4111 1111 1111 1111" is — then every
 * correctly-scrubbed fixture would fail the gate forever, and the first thing anyone would do
 * is switch the gate off. `scrub` must be idempotent; there is a test asserting it.
 */
const PLACEHOLDER = {
  email: "[email redacted]",
  card: "[card redacted]",
  phone: "[phone redacted]",
  ssn: "[ssn redacted]",
  postal: "[postal redacted]",
  address: "[address redacted]",
  jwt: "[jwt redacted]",
  cookie: "[cookie redacted]",
  token: "[token redacted]",
  bearer: "[bearer redacted]",
  person: "[name redacted]",
  avatar: "about:blank",
} as const;

/**
 * Apply every rule, returning the scrubbed text and what was hit.
 * `hits` being non-empty on an already-committed fixture is a CI failure.
 */
export function scrub(input: string): ScrubResult {
  let output = input;
  const hits: ScrubHit[] = [];

  for (const rule of [...RULES, ...JSONLD_PERSON_RULES]) {
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.guard && !rule.guard(match)) return match;
      // trailing args are (offset, wholeString[, groups]); everything before is a capture.
      const groups = rest.filter((r): r is string => typeof r === "string");
      const offset = rest.find((r): r is number => typeof r === "number") ?? 0;
      hits.push({ rule: rule.name, match: match.slice(0, 60), index: offset });
      return rule.replace(match, groups);
    });
  }

  return { output, hits };
}

/** Scan without modifying — what CI runs over the committed fixture tree. */
export function findPii(input: string): ScrubHit[] {
  return scrub(input).hits;
}

export interface NormaliseOptions {
  /** Rewrite absolute future epochs so countdown fixtures are deterministic under Vitest. */
  freezeClockTo?: number;
}

/**
 * Structural normalisation (plan §6). Strips what cannot be replayed and would only add
 * noise to a diff, while keeping JSON-LD — detectors read it.
 */
export function normalise(html: string, opts: NormaliseOptions = {}): string {
  let out = html;

  // Scripts, except application/ld+json which the funnel classifier and offerKey parse.
  out = out.replace(
    /<script\b(?![^>]*type\s*=\s*["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );

  out = out.replace(
    /<link\b[^>]*rel\s*=\s*["'](?:preload|prefetch|dns-prefetch|preconnect)["'][^>]*>/gi,
    "",
  );

  // Inline event handlers — a fixture must never execute anything.
  out = out.replace(/\son[a-z]+\s*=\s*"(?:[^"]*)"/gi, "");
  out = out.replace(/\son[a-z]+\s*=\s*'(?:[^']*)'/gi, "");

  // Remote references become inert. data: URIs are already inline and are kept.
  out = out.replace(/\s(src|href)\s*=\s*"(?!data:|#)([^"]*)"/gi, ' $1="about:blank"');
  out = out.replace(/\s(src|href)\s*=\s*'(?!data:|#)([^']*)'/gi, " $1='about:blank'");
  out = out.replace(/\ssrcset\s*=\s*"[^"]*"/gi, "");

  // Large base64 images bloat the repo without helping any detector.
  out = out.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{4096,}/gi, TRANSPARENT_PIXEL);

  if (opts.freezeClockTo !== undefined) {
    const frozen = String(opts.freezeClockTo);
    // 13-digit ms epochs in the plausible range, wherever they appear in inline JSON.
    out = out.replace(/\b1[6-9]\d{11}\b/g, frozen);
  }

  return out;
}

export const TRANSPARENT_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
