/**
 * WCAG 2.1 relative luminance and contrast (plan §18E).
 *
 * Pure arithmetic over colour strings already captured in the read phase, so the visual
 * interference detector stays a pure function like every other one.
 *
 * The reason this is worth doing properly rather than eyeballing font sizes: contrast ratio
 * is the one dimension of visual prominence with an actual standard behind it, which makes
 * "the accept button is 6x the contrast of the decline button" a measurement rather than an
 * opinion. That distinction is the whole difference between an observation this tool can
 * defend and an accusation it cannot.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `#abc`, `#aabbcc`, `transparent`. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/.exec(s);
  if (rgb) {
    const alphaRaw = rgb[4];
    let a = 1;
    if (alphaRaw !== undefined) {
      a = alphaRaw.endsWith("%") ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    }
    return {
      r: Number.parseFloat(rgb[1] ?? "0"),
      g: Number.parseFloat(rgb[2] ?? "0"),
      b: Number.parseFloat(rgb[3] ?? "0"),
      a: Number.isFinite(a) ? a : 1,
    };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1] as string;
    if (h.length === 3) {
      return {
        r: Number.parseInt(`${h[0]}${h[0]}`, 16),
        g: Number.parseInt(`${h[1]}${h[1]}`, 16),
        b: Number.parseInt(`${h[2]}${h[2]}`, 16),
        a: 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: Number.parseInt(h.slice(0, 2), 16),
        g: Number.parseInt(h.slice(2, 4), 16),
        b: Number.parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
  }

  return null;
}

/** Composite a possibly-translucent foreground over an opaque backdrop. */
export function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(c: Rgb): number {
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

/** WCAG contrast ratio, 1..21. Returns null when either colour cannot be parsed. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;

  const solidBg = bg.a < 1 ? composite(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg;
  const solidFg = fg.a < 1 ? composite(fg, solidBg) : fg;

  const l1 = relativeLuminance(solidFg);
  const l2 = relativeLuminance(solidBg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
