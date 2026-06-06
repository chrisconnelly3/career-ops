/**
 * Small color helpers for brand-accurate, WCAG-AA-safe resume accents.
 *
 * The tailored CV colors its prominent text with the company's brand color.
 * Some brand colors (bright pink, yellow, cyan) don't have enough contrast on
 * white for body text, so we darken them in code until they clear WCAG AA
 * (4.5:1 for normal text). Darkening is done by scaling the RGB channels toward
 * black, which preserves the hue exactly (hue depends on channel ratios, and
 * uniform scaling leaves those ratios unchanged) — so a purple stays purple,
 * just deep enough to read.
 */

export type Rgb = { r: number; g: number; b: number };

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function clampChannel(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (x: number) => clampChannel(x).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG relative luminance of an sRGB color. */
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors (1 to 21). */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Return `hex` unchanged if it already meets `target` contrast on `bg`
 * (default white, AA normal text = 4.5). Otherwise darken it toward black —
 * preserving hue — until it does. Always converges (black is 21:1 on white).
 */
export function ensureContrastAA(hex: string, bg = "#ffffff", target = 4.5): string {
  if (contrastRatio(hex, bg) >= target) return hex.toLowerCase();
  const { r, g, b } = hexToRgb(hex);
  for (let k = 0.98; k > 0; k -= 0.02) {
    const cand = rgbToHex(r * k, g * k, b * k);
    if (contrastRatio(cand, bg) >= target) return cand;
  }
  return "#000000";
}
