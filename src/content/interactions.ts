/**
 * What the shopper did with their own hands.
 *
 * Two detections were making claims about choices without ever observing one:
 *
 *   `defaults.preselected` read a checkbox's live `checked` state, so a box the shopper ticked
 *   themselves was indistinguishable from one the page ticked for them, and the card would
 *   tell them a choice had been made on their behalf when they had just made it.
 *
 *   `basket.sneak` and `pricing.drip` were meant to ignore add-ons the shopper chose, and had
 *   no record of any choice at all.
 *
 * This module is that record. It listens for real `change` and `click` events, which only a
 * user (or assistive technology acting for one) produces, a page setting `checked` in script
 * fires no `change` event. It remembers which inputs were touched, in memory, and reports
 * add-on choices upward so the worker can attribute cart lines across page loads.
 *
 * It stores no text. The only thing that leaves this module is an add-on FAMILY key
 * (`gift_wrap`, `warranty`, …) and whether the shopper opted in.
 */
import { type AddonKey, addonKeysOf } from "@/shared/addons";

const touched = new WeakSet<Element>();

/** Did a user event change this control since the page loaded? */
export function wasTouchedByUser(el: Element): boolean {
  return touched.has(el);
}

export interface AddonChoice {
  key: AddonKey;
  selected: boolean;
}

/** The label a person reads for a control, from the most specific source available. */
function labelFor(el: Element): string {
  const parts: string[] = [];
  const aria = el.getAttribute("aria-label");
  if (aria) parts.push(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      if (ref?.textContent) parts.push(ref.textContent);
    }
  }
  if (el instanceof HTMLInputElement && el.labels) {
    for (const label of el.labels) if (label.textContent) parts.push(label.textContent);
  }
  if (parts.length === 0) {
    // Last resort: the nearest ancestor with short text, which is how most custom add-on
    // rows are built (`<div><input> Add gift wrap $5</div>`). Bounded so a whole cart form is
    // never read as one label.
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 0 && text.length <= 200) {
        parts.push(text);
        break;
      }
    }
  }
  if (el instanceof HTMLElement && parts.length === 0) parts.push(el.innerText ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
}

const OPT_IN_CLICK = /\badd\b|\binclude\b|\byes\b|\bprotect\b|\bselect\b|\bchoose\b/i;
const OPT_OUT_CLICK = /\bremove\b|\bno,? thanks\b|\bdecline\b|\bskip\b|\bdelete\b/i;

function choicesFor(el: Element, selected: boolean): AddonChoice[] {
  return addonKeysOf(labelFor(el)).map((key) => ({ key, selected }));
}

/**
 * Attach the listeners. `onChoices` receives add-on choices; it is the caller's job to decide
 * whether the page is one worth reporting from.
 */
export function watchInteractions(
  onChoices: (choices: AddonChoice[]) => void,
  doc: Document = document,
): () => void {
  const onChange = (ev: Event) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.type !== "checkbox" && el.type !== "radio") return;

    const out: AddonChoice[] = [];
    touched.add(el);

    if (el.type === "radio" && el.name) {
      // Choosing one radio unchooses its siblings, and that is the shopper's doing too:
      // picking "Standard" is a decision against the "Expedited" beside it.
      const scope = el.form ?? doc;
      for (const sibling of scope.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`,
      )) {
        touched.add(sibling);
        if (sibling !== el) out.push(...choicesFor(sibling, false));
      }
    }
    out.push(...choicesFor(el, el.checked));
    if (out.length > 0) onChoices(out);
  };

  const onClick = (ev: Event) => {
    let node = ev.target instanceof Element ? ev.target : null;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const isButton =
        node.tagName === "BUTTON" ||
        node.tagName === "A" ||
        node.getAttribute("role") === "button" ||
        (node instanceof HTMLInputElement && (node.type === "button" || node.type === "submit"));
      if (!isButton) continue;

      const label = labelFor(node);
      const keys = addonKeysOf(label);
      if (keys.length === 0) return;
      // Opt-out wording wins over opt-in: "Remove protection plan" contains neither "add" nor
      // "include", but "No thanks, I'll skip protection" would otherwise read as both.
      const selected = OPT_OUT_CLICK.test(label) ? false : OPT_IN_CLICK.test(label) ? true : null;
      if (selected === null) return;
      onChoices(keys.map((key) => ({ key, selected })));
      return;
    }
  };

  doc.addEventListener("change", onChange, { capture: true, passive: true });
  doc.addEventListener("click", onClick, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("change", onChange, { capture: true });
    doc.removeEventListener("click", onClick, { capture: true });
  };
}
