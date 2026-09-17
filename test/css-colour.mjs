/**
 * CSS colour, resolved to a value rather than matched as text.
 *
 * WHY THIS EXISTS. The palette guards used to read tokens with /#[0-9a-f]{6}/. Anything
 * else — an oklch(), an rgb(), uppercase hex, an eight-digit hex whose alpha the regex
 * silently cut off — was not a colour as far as the tests knew, so the no-twins check, the
 * sign allowlist and the no-literals check all passed over it without a word. That is the
 * same shape as the --accent-soft bug (a second NAME for a sign colour) moved one level
 * down: a second NOTATION for one. It was already live: five rgba() literals sat in
 * app.css under a test that said "no exceptions".
 *
 * So everything here is built on one rule: A VALUE THAT LOOKS LIKE A COLOUR AND CANNOT BE
 * RESOLVED IS AN ERROR, never a skip. An unsupported notation fails the suite with its
 * name attached, and the fix is to teach this file the notation — not to loosen a guard.
 *
 * Every colour is carried as linear-light sRGB (unclamped, so a P3 value stays out of
 * gamut rather than being quietly clipped into a different colour) plus alpha, and
 * compared in OKLab, where Euclidean distance approximates what a reader can tell apart.
 * Matrices are the ones CSS Color 4 publishes in its sample code.
 */

/** @typedef {{ lin: [number, number, number], alpha: number }} Colour */

export class ColourError extends Error {}

/** @param {number[][]} m @param {number[]} v @returns {[number, number, number]} */
const mul = (m, v) => /** @type {[number, number, number]} */ (
  m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]));

const LIN_SRGB_TO_XYZ = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const XYZ_TO_LIN_SRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const LIN_P3_TO_XYZ = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

/** @param {number} u gamma-encoded sRGB channel, 0..1 */
const toLinear = (u) => {
  const s = Math.sign(u) || 1;
  const a = Math.abs(u);
  return s * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4);
};
/** @param {number} u linear channel */
const toGamma = (u) => {
  const s = Math.sign(u) || 1;
  const a = Math.abs(u);
  return s * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055);
};

/** @param {[number, number, number]} lin @returns {[number, number, number]} */
export function toOklab(lin) {
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
/** @param {number[]} lab @returns {[number, number, number]} */
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
/** CIE Lab (D50), as CSS lab() and lch() define it. @param {number[]} lab */
function fromCieLab([L, a, b]) {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const y = L > k * e ? fy ** 3 : L / k;
  const z = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const d50 = [x * (0.3457 / 0.3585), y, z * ((1 - 0.3457 - 0.3585) / 0.3585)];
  return mul(XYZ_TO_LIN_SRGB, mul(D50_TO_D65, d50));
}
/** @param {number[]} lin */
function toCieLab(lin) {
  const d65 = mul(LIN_SRGB_TO_XYZ, lin);
  // Bradford D65 -> D50, the inverse of the matrix above.
  const d50 = mul([
    [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
    [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
    [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
  ], d65);
  const white = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const f = (/** @type {number} */ t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = d50.map((v, i) => f(v / white[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** @param {number} h degrees */
const polar = (h) => (h * Math.PI) / 180;

// The 148 named colours of CSS Color 4. A name is a colour literal like any other.
const NAMED = Object.fromEntries(('aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 '
  + 'azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff '
  + 'blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 '
  + 'chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff '
  + 'darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 '
  + 'darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 '
  + 'darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b '
  + 'darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 '
  + 'deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff '
  + 'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc '
  + 'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f '
  + 'grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 '
  + 'khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd '
  + 'lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 '
  + 'lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a '
  + 'lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 '
  + 'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 '
  + 'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 '
  + 'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a '
  + 'mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa '
  + 'mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 '
  + 'olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa '
  + 'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 '
  + 'peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 '
  + 'red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 '
  + 'sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb '
  + 'slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f '
  + 'steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 '
  + 'violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32')
  .split(' ').reduce((/** @type {string[][]} */ acc, w, i) => {
    if (i % 2 === 0) acc.push([w]); else acc[acc.length - 1].push(w);
    return acc;
  }, []));
// CSS system colours resolve per user agent, so they have no value to compare. They are
// still colours, and still refused: a later "just use CanvasText" would dodge every check.
const SYSTEM = ['accentcolor', 'accentcolortext', 'activetext', 'buttonborder', 'buttonface',
  'buttontext', 'canvas', 'canvastext', 'field', 'fieldtext', 'graytext', 'highlight',
  'highlighttext', 'linktext', 'mark', 'marktext', 'selecteditem', 'selecteditemtext',
  'visitedtext'];

const FUNCS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color',
  'color-mix', 'light-dark', 'device-cmyk', 'contrast-color'];

/**
 * Split a value into its top-level parts, respecting parentheses.
 * @param {string} s @param {RegExp} sep
 */
function splitTop(s, sep) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      if (ch === '/' || ch === ',') out.push(ch);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** @param {string} t @param {number} pctScale value that 100% maps to */
function num(t, pctScale = 1) {
  if (t === 'none') return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/i.exec(t);
  if (!m) throw new ColourError(`not a number: "${t}"`);
  const v = Number(m[1]);
  switch ((m[2] ?? '').toLowerCase()) {
    case '%': return (v / 100) * pctScale;
    case 'rad': return (v * 180) / Math.PI;
    case 'grad': return v * 0.9;
    case 'turn': return v * 360;
    default: return v;
  }
}

/**
 * The arguments of a colour function: three channels and an optional alpha, in either the
 * legacy comma syntax or the modern space-and-slash one.
 * @param {string} name @param {string} inner
 */
function channels(name, inner) {
  const parts = splitTop(inner, /[\s,/]/);
  if (parts[0] === 'from') {
    throw new ColourError(`relative colour syntax is not resolved here: ${name}(${inner})`);
  }
  const values = parts.filter((p) => p !== ',' && p !== '/');
  const slash = parts.indexOf('/');
  const commas = parts.filter((p) => p === ',').length;
  let alpha = '1';
  if (slash !== -1) {
    alpha = parts[slash + 1];
    values.splice(values.indexOf(alpha), 1);
  } else if (commas === 3 || values.length === 4) {
    alpha = /** @type {string} */ (values.pop());
  }
  if (values.length !== 3) throw new ColourError(`${name}() needs three channels: ${inner}`);
  const a = Math.min(1, Math.max(0, num(alpha, 1)));
  return { c: values, alpha: a };
}

/** @param {string} hex */
function fromHex(hex) {
  let h = hex.slice(1);
  if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-f]/i.test(h)) {
    throw new ColourError(`not a hex colour: ${hex}`);
  }
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const byte = (/** @type {number} */ i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return /** @type {Colour} */ ({
    lin: [toLinear(byte(0)), toLinear(byte(2)), toLinear(byte(4))],
    alpha: h.length === 8 ? byte(6) : 1,
  });
}

/** @param {number} h @param {number} s @param {number} l */
function hslToRgb(h, s, l) {
  const f = (/** @type {number} */ n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/**
 * color-mix(in <space> [<hue> hue]?, <colour> [<p>]?, <colour> [<p>]?), per CSS Color 5:
 * premultiplied interpolation, percentages normalised, an under-100 sum scaling alpha.
 * @param {string} inner
 * @returns {Colour}
 */
function colorMix(inner) {
  const parts = splitTop(inner, /,/).filter((p) => p !== ',');
  if (parts.length !== 3) throw new ColourError(`color-mix() needs a space and two colours: ${inner}`);
  const spaceM = /^in\s+([\w-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/i.exec(parts[0]);
  if (!spaceM) throw new ColourError(`color-mix() space not understood: ${parts[0]}`);
  const space = spaceM[1].toLowerCase();
  const hueMode = (spaceM[2] ?? 'shorter').toLowerCase();

  const sides = parts.slice(1).map((p) => {
    const bits = splitTop(p, /\s/);
    const pct = bits.find((b) => /%$/.test(b));
    const colour = bits.filter((b) => b !== pct).join(' ');
    return { colour: parseColour(colour), p: pct === undefined ? null : num(pct, 1) };
  });
  let [p1, p2] = [sides[0].p, sides[1].p];
  if (p1 === null && p2 === null) { p1 = 0.5; p2 = 0.5; }
  else if (p1 === null) p1 = 1 - /** @type {number} */ (p2);
  else if (p2 === null) p2 = 1 - p1;
  const sum = /** @type {number} */ (p1) + /** @type {number} */ (p2);
  if (sum === 0) throw new ColourError(`color-mix() percentages sum to zero: ${inner}`);
  const w = /** @type {number} */ (p2) / sum;
  const alphaScale = Math.min(1, sum);

  /** @type {Record<string, [(lin: [number, number, number]) => number[], (v: number[]) => [number, number, number], number | null]>} */
  const spaces = {
    srgb: [(l) => l.map(toGamma), (v) => /** @type {[number, number, number]} */ (v.map(toLinear)), null],
    'srgb-linear': [(l) => [...l], (v) => /** @type {[number, number, number]} */ ([...v]), null],
    'xyz-d65': [(l) => mul(LIN_SRGB_TO_XYZ, l), (v) => mul(XYZ_TO_LIN_SRGB, v), null],
    xyz: [(l) => mul(LIN_SRGB_TO_XYZ, l), (v) => mul(XYZ_TO_LIN_SRGB, v), null],
    oklab: [toOklab, fromOklab, null],
    lab: [toCieLab, fromCieLab, null],
    oklch: [(l) => toPolar(toOklab(l)), (v) => fromOklab(fromPolar(v)), 2],
    lch: [(l) => toPolar(toCieLab(l)), (v) => fromCieLab(fromPolar(v)), 2],
    hsl: [(l) => rgbToHsl(l.map(toGamma)), (v) => /** @type {[number, number, number]} */ (
      hslToRgb(v[0], v[1], v[2]).map(toLinear)), 0],
  };
  const conv = spaces[space];
  if (!conv) throw new ColourError(`color-mix() in ${space} is not resolved here`);
  const [to, from, hueIdx] = conv;
  const [a, b] = sides.map((s) => s.colour);
  const va = to(a.lin);
  const vb = to(b.lin);
  if (hueIdx !== null) {
    let d = vb[hueIdx] - va[hueIdx];
    if (hueMode === 'shorter') { if (d > 180) d -= 360; else if (d < -180) d += 360; }
    else if (hueMode === 'longer') { if (d > 0 && d < 180) d -= 360; else if (d > -180 && d <= 0) d += 360; }
    else if (hueMode === 'increasing') { if (d < 0) d += 360; }
    else if (d > 0) d -= 360;
    vb[hueIdx] = va[hueIdx] + d;
  }
  const alpha = a.alpha * (1 - w) + b.alpha * w;
  const mixed = va.map((x, i) => {
    if (i === hueIdx) return x * (1 - w) + vb[i] * w;
    const pre = x * a.alpha * (1 - w) + vb[i] * b.alpha * w;
    return alpha === 0 ? 0 : pre / alpha;
  });
  return { lin: from(mixed), alpha: alpha * alphaScale };
}

/** @param {number[]} lab @returns {number[]} */
const toPolar = ([L, a, b]) => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
/** @param {number[]} lch @returns {number[]} */
const fromPolar = ([L, C, H]) => [L, C * Math.cos(polar(H)), C * Math.sin(polar(H))];

/** @param {number[]} rgb gamma-encoded @returns {number[]} */
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/**
 * Parse one CSS colour, in any notation this file knows. Throws ColourError on anything
 * that is a colour but cannot be resolved; never returns a guess.
 * @param {string} input
 * @returns {Colour}
 */
export function parseColour(input) {
  const s = input.trim();
  const lower = s.toLowerCase();
  if (lower.startsWith('#')) return fromHex(lower);
  if (lower === 'transparent') return { lin: [0, 0, 0], alpha: 0 };
  if (lower in NAMED) return fromHex(`#${NAMED[lower]}`);
  if (lower === 'currentcolor' || SYSTEM.includes(lower)) {
    throw new ColourError(`${s} has no fixed value to compare`);
  }
  const fm = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(s);
  if (!fm) throw new ColourError(`not a colour: "${s}"`);
  const name = fm[1].toLowerCase();
  const inner = fm[2].trim();
  if (/var\(/i.test(inner)) throw new ColourError(`unresolved var() inside ${name}(): ${s}`);

  switch (name) {
    case 'color-mix':
      return colorMix(inner);
    case 'rgb': case 'rgba': {
      const { c, alpha } = channels(name, inner);
      const [r, g, b] = c.map((t) => num(t, 255) / 255);
      return { lin: [toLinear(r), toLinear(g), toLinear(b)], alpha };
    }
    case 'hsl': case 'hsla': {
      const { c, alpha } = channels(name, inner);
      const h = num(c[0]);
      // Modern syntax allows bare numbers for s and l, meaning percentages.
      const pct = (/** @type {string} */ t) => (/%$/.test(t) ? num(t, 1) : num(t) / 100);
      const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, pct(c[1]), pct(c[2]));
      return { lin: [toLinear(r), toLinear(g), toLinear(b)], alpha };
    }
    case 'hwb': {
      const { c, alpha } = channels(name, inner);
      const h = ((num(c[0]) % 360) + 360) % 360;
      const pct = (/** @type {string} */ t) => (/%$/.test(t) ? num(t, 1) : num(t) / 100);
      let wh = pct(c[1]);
      let bl = pct(c[2]);
      if (wh + bl >= 1) { const g = wh / (wh + bl); return { lin: [toLinear(g), toLinear(g), toLinear(g)], alpha }; }
      const base = hslToRgb(h, 1, 0.5);
      const [r, g, b] = base.map((u) => u * (1 - wh - bl) + wh);
      return { lin: [toLinear(r), toLinear(g), toLinear(b)], alpha };
    }
    case 'lab': {
      const { c, alpha } = channels(name, inner);
      return { lin: fromCieLab([num(c[0], 100), num(c[1], 125), num(c[2], 125)]), alpha };
    }
    case 'lch': {
      const { c, alpha } = channels(name, inner);
      return { lin: fromCieLab(fromPolar([num(c[0], 100), num(c[1], 150), num(c[2])])), alpha };
    }
    case 'oklab': {
      const { c, alpha } = channels(name, inner);
      return { lin: fromOklab([num(c[0], 1), num(c[1], 0.4), num(c[2], 0.4)]), alpha };
    }
    case 'oklch': {
      const { c, alpha } = channels(name, inner);
      return { lin: fromOklab(fromPolar([num(c[0], 1), num(c[1], 0.4), num(c[2])])), alpha };
    }
    case 'color': {
      const bits = splitTop(inner, /\s/);
      const space = (bits.shift() ?? '').toLowerCase();
      const { c, alpha } = channels(`color(${space})`, bits.join(' '));
      const v = c.map((t) => num(t, 1));
      switch (space) {
        case 'srgb': return { lin: /** @type {[number, number, number]} */ (v.map(toLinear)), alpha };
        case 'srgb-linear': return { lin: /** @type {[number, number, number]} */ (v), alpha };
        case 'display-p3': return { lin: mul(XYZ_TO_LIN_SRGB, mul(LIN_P3_TO_XYZ, v.map(toLinear))), alpha };
        case 'xyz': case 'xyz-d65': return { lin: mul(XYZ_TO_LIN_SRGB, v), alpha };
        case 'xyz-d50': return { lin: mul(XYZ_TO_LIN_SRGB, mul(D50_TO_D65, v)), alpha };
        default: throw new ColourError(`color(${space} …) is not resolved here`);
      }
    }
    default:
      throw new ColourError(`${name}() is not resolved here: ${s}`);
  }
}

/** Distance a reader could perceive, in OKLab. Alpha counts as a full axis. @param {Colour} a @param {Colour} b */
export function deltaE(a, b) {
  const [L1, a1, b1] = toOklab(a.lin);
  const [L2, a2, b2] = toOklab(b.lin);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2, a.alpha - b.alpha);
}

/**
 * Below this, two colours are the same colour for the purposes of these checks. 0.02 in
 * OKLab is roughly one just-noticeable difference; a synonym that is off by a rounding
 * step, or a hand-converted oklch() that lands one 8-bit value away, is still a synonym.
 */
export const SAME = 0.02;

/** @param {Colour} c */
export function inGamut(c, eps = 1e-3) {
  return c.lin.every((u) => u >= -eps && u <= 1 + eps);
}

/**
 * The colour as a #rrggbb (or #rrggbbaa) string, clipped to sRGB. For contrast arithmetic
 * and messages only; comparisons use deltaE on the unclipped value.
 * @param {Colour} c
 */
export function toHex(c) {
  const byte = (/** @type {number} */ u) => Math.round(Math.min(1, Math.max(0, u)) * 255 + 1e-6)
    .toString(16).padStart(2, '0');
  const hex = `#${c.lin.map((u) => byte(toGamma(u))).join('')}`;
  return c.alpha < 1 ? hex + byte(c.alpha) : hex;
}

const COLOUR_WORD = new RegExp(`(^|[^\\w-])(${[...Object.keys(NAMED), ...SYSTEM].join('|')})(?![\\w(-])`, 'gi');
const COLOUR_FN = new RegExp(`(^|[^\\w-])(${FUNCS.join('|')})\\(`, 'gi');

/**
 * Every colour LITERAL written in a declaration value: hex, colour functions and named
 * colours. `transparent` and `currentColor` are keywords, not palette colours, and are not
 * reported. A colour-mix() of var()s is not a literal; its arguments are scanned like any
 * other text, so a literal hiding inside one is still found.
 * @param {string} value
 */
export function literalsIn(value) {
  const v = stripNonColour(value);
  /** @type {string[]} */
  const found = [];
  for (const m of v.matchAll(/#[0-9a-f]{3,8}(?![\w-])/gi)) found.push(m[0]);
  for (const m of v.matchAll(COLOUR_FN)) {
    const start = /** @type {number} */ (m.index) + m[1].length;
    const call = balanced(v, start + m[2].length);
    const text = v.slice(start, call);
    if (m[2].toLowerCase() === 'color-mix') continue;
    found.push(text);
  }
  for (const m of v.matchAll(COLOUR_WORD)) found.push(m[2]);
  return found;
}

/** Remove strings, url()s and comments, which can hold colour-shaped text that is not a colour. @param {string} v */
function stripNonColour(v) {
  return v.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/url\([^)]*\)/gi, ' ');
}

/** Index just past the ")" matching the "(" at `open`. @param {string} s @param {number} open */
function balanced(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    if (s[i] === ')') { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new ColourError(`unbalanced parentheses in: ${s}`);
}

/**
 * Substitute var() references from a token table, following chains. A reference with no
 * definition and no fallback is left in place, so the caller can see it.
 * @param {string} value @param {Map<string, string>} table
 */
export function substitute(value, table) {
  let out = value;
  for (let hop = 0; hop < 12; hop += 1) {
    if (!/var\(/i.test(out)) return out;
    let changed = false;
    let result = '';
    let i = 0;
    for (const m of out.matchAll(/var\(/gi)) {
      const start = /** @type {number} */ (m.index);
      if (start < i) continue;
      const end = balanced(out, start + 3);
      const inner = out.slice(start + 4, end - 1);
      const comma = splitTop(inner, /,/);
      const name = comma[0].trim().replace(/^--/, '');
      const fallback = comma.length > 2 ? inner.slice(inner.indexOf(',') + 1).trim() : null;
      const hit = table.get(name) ?? fallback;
      result += out.slice(i, start);
      if (hit === null || hit === undefined) {
        result += ` unresolved(--${name})`;
      } else {
        result += hit;
        changed = true;
      }
      i = end;
    }
    result += out.slice(i);
    out = result;
    if (!changed) break;
  }
  if (/var\(/i.test(out)) throw new ColourError(`var() chain does not terminate: ${value}`);
  return out.replaceAll(' unresolved', 'var');
}

/**
 * Every colour a (substituted) value contains: each top-level colour, each argument of a
 * color-mix(), and the mix itself. A value that names a colour and cannot be resolved throws.
 * @param {string} value
 * @returns {Colour[]}
 */
export function coloursIn(value) {
  const v = stripNonColour(value);
  /** @type {Colour[]} */
  const out = [];
  for (const lit of literalsIn(v)) out.push(parseColour(lit));
  for (const m of v.matchAll(/(^|[^\w-])color-mix\(/gi)) {
    const start = /** @type {number} */ (m.index) + m[1].length;
    const text = v.slice(start, balanced(v, start + 'color-mix'.length));
    out.push(parseColour(text));
  }
  // transparent is a colour too, and the one that matters for a twin at alpha 0.
  for (const m of v.matchAll(/(^|[^\w-])transparent(?![\w-])/gi)) {
    if (m) out.push({ lin: [0, 0, 0], alpha: 0 });
  }
  return out;
}

/** @param {string} v */
export const looksLikeColour = (v) => literalsIn(v).length > 0
  || /(^|[^\w-])(color-mix|transparent)\b/i.test(stripNonColour(v));

/**
 * Parse a stylesheet into rules, each with the at-rule preludes it sits inside.
 * @param {string} css
 * @returns {{ selector: string, at: string[], decls: [string, string][] }[]}
 */
export function rules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // @import and @charset are statements, and an import URL can carry semicolons.
    .replace(/@(import|charset)\s+(url\((?:'[^']*'|"[^"]*"|[^)]*)\)|'[^']*'|"[^"]*")[^;]*;/gi, '');
  /** @type {{ selector: string, at: string[], decls: [string, string][] }[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [];
  let buf = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      if (prelude.startsWith('@')) { stack.push(prelude); continue; }
      let depth = 0;
      let end = i;
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1;
        if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const body = src.slice(i + 1, end);
      /** @type {[string, string][]} */
      const decls = splitTop(body, /;/).filter((d) => d !== ';')
        .map((d) => d.trim()).filter((d) => d.includes(':'))
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]);
      out.push({ selector: prelude, at: [...stack], decls });
      i = end;
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

/** A selector that defines page-wide tokens rather than styling a component. @param {string} sel */
const isRootish = (sel) => /^(:root|html)(\[[^\]]+\]|:[\w-]+(\([^)]*\))?)*$|^\[data-[\w-]+(=[^\]]+)?\]$/.test(sel.trim());

/**
 * The token table for every theme the stylesheets declare.
 *
 * The unconditional :root is the base. Every other root-level context — a
 * [data-theme="dark"] block, a prefers-color-scheme media query, :root:not(...) — is a
 * theme laid over it. A reskin that adds a dark theme therefore adds a table, and every
 * check runs against each one; a guard that only ever sees the light values would be the
 * same silent gap in a different place.
 *
 * Custom properties declared on component selectors are added to every table as well, so
 * `.card { --c: var(--up) } .card b { color: var(--c) }` resolves rather than slipping past
 * as an unknown name.
 * @param {string[]} sheets
 * @returns {Map<string, Map<string, string>>}
 */
export function themes(sheets) {
  /** @type {Map<string, Map<string, string>>} */
  const contexts = new Map([['base', new Map()]]);
  /** @type {Map<string, string>} */
  const scoped = new Map();
  for (const css of sheets) {
    for (const r of rules(css)) {
      const props = r.decls.filter(([p]) => p.startsWith('--'));
      if (!props.length) continue;
      for (const sel of r.selector.split(',').map((x) => x.trim())) {
        if (!isRootish(sel)) {
          for (const [p, v] of props) scoped.set(`${p.slice(2)}@${sel}`, v);
          continue;
        }
        const key = r.at.length === 0 && /^(:root|html)$/.test(sel) ? 'base' : `${r.at.join(' ')} ${sel}`.trim();
        if (!contexts.has(key)) contexts.set(key, new Map());
        const table = /** @type {Map<string, string>} */ (contexts.get(key));
        for (const [p, v] of props) table.set(p.slice(2), v);
      }
    }
  }
  const base = /** @type {Map<string, string>} */ (contexts.get('base'));
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  for (const [key, table] of contexts) {
    const merged = new Map([...base, ...table]);
    for (const [k, v] of scoped) {
      const name = k.slice(0, k.indexOf('@'));
      if (!merged.has(name)) merged.set(name, v);
    }
    out.set(key, merged);
  }
  return out;
}

/**
 * Resolve every colour-valued token in a table. Tokens that are not colours (spacing,
 * fonts) are left out; tokens that look like colours and do not resolve are returned as
 * errors, by name.
 * @param {Map<string, string>} table
 */
export function resolveTokens(table) {
  /** @type {Map<string, Colour>} */
  const colours = new Map();
  /** @type {string[]} */
  const errors = [];
  for (const [name, raw] of table) {
    let value;
    try {
      value = substitute(raw, table);
    } catch (e) {
      errors.push(`--${name}: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    if (!looksLikeColour(value)) continue;
    // A shadow or gradient holds colours but is not one; its parts are checked where used.
    const top = splitTop(value, /\s/);
    if (top.length > 1 && !/^[a-z-]+\(/i.test(value.trim())) continue;
    try {
      colours.set(name, parseColour(value));
    } catch (e) {
      errors.push(`--${name}: ${/** @type {Error} */ (e).message}`);
    }
  }
  return { colours, errors };
}

/*
 * THE GUARDS, as functions, so every stylesheet gets the same ones. The live site and the
 * flagged preview are checked by one implementation; two copies would drift, and the one
 * that drifted would be the one nobody was looking at.
 */

/** Properties that paint. */
const PAINTS = /^(--|color$|background|border|outline|fill$|stroke$|box-shadow$|text-shadow$|text-decoration|caret-color$|accent-color$|column-rule|stop-color$|flood-color$|lighting-color$|scrollbar-color$|text-emphasis)/;

/**
 * Load stylesheets as the guards see them: every theme's token table, resolved.
 * @param {string[]} tokenSheets where tokens are defined (literals allowed)
 * @param {string[]} componentSheets where tokens are used (literals refused)
 */
export function palette(tokenSheets, componentSheets) {
  const tables = themes([...tokenSheets, ...componentSheets]);
  const resolved = new Map([...tables].map(([k, t]) => [k, resolveTokens(t)]));
  return { tables, resolved, components: componentSheets.join('\n') };
}
/** @typedef {ReturnType<typeof palette>} Palette */

/** Unresolvable or out-of-gamut colour tokens, by theme. @param {Palette} p */
export function unresolvedTokens(p) {
  /** @type {string[]} */
  const problems = [];
  for (const [theme, { colours, errors }] of p.resolved) {
    for (const e of errors) problems.push(`${theme}: ${e}`);
    for (const [name, c] of colours) {
      if (!inGamut(c)) problems.push(`${theme}: --${name} is outside sRGB; its contrast figures are not real`);
    }
  }
  return problems;
}

/** Colour literals written in component CSS, in any notation. @param {string} css */
export function componentLiterals(css) {
  /** @type {string[]} */
  const out = [];
  for (const r of rules(css)) {
    for (const [prop, value] of r.decls) {
      // A mask is an alpha ramp, not a colour: `mask-image: linear-gradient(black, transparent)`
      // means "opaque here, clear there" and has no palette meaning at all.
      if (/^(-webkit-)?mask/.test(prop)) continue;
      for (const lit of literalsIn(value)) out.push(`${r.selector} { ${prop}: ${lit} }`);
    }
  }
  return out;
}

/**
 * Tokens other than `names` that resolve to the same colour as one of them, per theme.
 * @param {Palette} p @param {string[]} names
 */
export function twins(p, names) {
  /** @type {string[]} */
  const out = [];
  for (const [theme, { colours }] of p.resolved) {
    for (const ref of names) {
      const target = colours.get(ref);
      if (!target) { out.push(`${theme}: --${ref} did not resolve`); continue; }
      for (const [name, c] of colours) {
        if (names.includes(name)) continue;
        const d = deltaE(c, target);
        if (d < SAME) out.push(`${theme}: --${name} is ${toHex(c)}, ${d.toFixed(3)} from --${ref}`);
      }
    }
  }
  return out;
}

/**
 * Every selector in the component CSS whose painted value resolves to one of the named
 * tokens' colours, in any theme — by value, so aliases and other notations count. Paint
 * declarations that name an unknown token, or hold a colour that cannot be resolved, are
 * returned as problems rather than skipped.
 * @param {Palette} p @param {string[]} names
 */
export function usersOf(p, names) {
  /** @type {Map<string, string[]>} selector -> evidence */
  const users = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const [theme, table] of p.tables) {
    const { colours } = /** @type {{colours: Map<string, Colour>}} */ (p.resolved.get(theme));
    for (const r of rules(p.components)) {
      for (const [prop, raw] of r.decls) {
        if (!PAINTS.test(prop)) continue;
        let found;
        try {
          const value = substitute(raw, table);
          const unknown = value.match(/var\(--[\w-]+\)/g);
          if (unknown) { problems.push(`${theme}: ${r.selector} { ${prop}: ${raw} } — ${unknown.join(', ')} is not a token`); continue; }
          found = coloursIn(value);
        } catch (e) {
          problems.push(`${theme}: ${r.selector} { ${prop}: ${raw} } — ${/** @type {Error} */ (e).message}`);
          continue;
        }
        for (const name of names) {
          const ref = colours.get(name);
          if (!ref || !found.some((c) => deltaE(c, ref) < SAME)) continue;
          for (const sel of r.selector.split(',').map((x) => x.trim())) {
            const ev = users.get(sel) ?? [];
            ev.push(`${theme}: ${prop}: ${raw} resolves to --${name}`);
            users.set(sel, ev);
          }
        }
      }
    }
  }
  return { users, problems: [...new Set(problems)] };
}

/**
 * Text colours that do not clear AA against a set of grounds, in any theme. Reads every
 * `color:` declaration in the component CSS, resolves it, and checks it against each
 * ground token — so a token that fails on the page cannot be used as text anywhere,
 * without anyone having to list it.
 * @param {Palette} p @param {string[]} grounds @param {number} [min]
 */
export function weakText(p, grounds, min = 4.5) {
  /** @type {string[]} */
  const out = [];
  for (const [theme, table] of p.tables) {
    const { colours } = /** @type {{colours: Map<string, Colour>}} */ (p.resolved.get(theme));
    for (const r of rules(p.components)) {
      for (const [prop, raw] of r.decls) {
        if (prop !== 'color') continue;
        const value = substitute(raw, table).trim();
        if (/^(inherit|currentcolor|initial|unset)$/i.test(value) || /var\(/.test(value)) continue;
        // WCAG 1.4.3 exempts text in a disabled control: it is not meant to be read as an
        // available option, and darkening it would make disabled look enabled.
        if (/:disabled|\[disabled\]|\[aria-disabled=/.test(r.selector)) continue;
        const fg = parseColour(value);
        // Large text clears at 3:1. "Large" is 24px, or 18.66px bold — read off the rule
        // itself, or off the heading it is scoped inside.
        const size = fontSize(r, p.components);
        const threshold = size !== null && size >= 24 ? 3 : min;
        const on = groundOf(r, p.components) ?? pairedGround(raw) ?? grounds;
        for (const g of on) {
          const bg = colours.get(g);
          if (!bg) continue;
          const ratio = contrastRatio(fg, bg);
          if (ratio < threshold) {
            out.push(`${theme}: ${r.selector} { color: ${raw} } on --${g} is ${ratio.toFixed(2)}`
              + (threshold === 3 ? ' (large text, 3:1)' : ''));
          }
        }
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Tokens that name their own ground. `--inv-fg` is the foreground of `--inv-bg` and nothing
 * else; a medal's ink sits on its own chip. Without this the checker tests them against the
 * page grounds they never touch, which is 64 false failures on one landing page and a pin
 * nobody trusts.
 * @param {string} raw @returns {string[] | null}
 */
function pairedGround(raw) {
  const m = /^var\(--([\w-]+)\)$/.exec(raw.trim());
  if (!m) return null;
  const name = m[1];
  if (name === 'inv-fg') return ['inv-bg'];
  if (name === 'accent-ink') return ['accent'];
  if (name === 'inv-hover') return ['inv-bg'];
  const medal = /^medal-(gold|silver|bronze)$/.exec(name);
  if (medal) return [`medal-${medal[1]}-bg`];
  return null;
}

/**
 * The font size a rule sets, or the one the selector it is scoped inside sets.
 * @param {{ selector: string, decls: [string, string][] }} r @param {string} css
 * @returns {number | null}
 */
function fontSize(r, css) {
  const own = r.decls.find(([q]) => q === 'font-size');
  const px = (/** @type {string | undefined} */ v) => {
    const m = v && /^(\d+(?:\.\d+)?)px$/.exec(v.trim());
    return m ? Number(m[1]) : null;
  };
  if (own && px(own[1]) !== null) return px(own[1]);
  // `.lp-h1 em` inherits the size `.lp-h1` sets.
  const parts = r.selector.split(',')[0].trim().split(/\s+/);
  if (parts.length > 1) {
    const parent = parts.slice(0, -1).join(' ');
    for (const other of rules(css)) {
      if (!other.selector.split(',').map((x) => x.trim()).includes(parent)) continue;
      const size = other.decls.find(([q]) => q === 'font-size');
      if (size && px(size[1]) !== null) return px(size[1]);
    }
  }
  return null;
}

/**
 * The background token a rule's text sits on: declared on the rule itself, or on the rule
 * whose selector is this one with trailing compounds removed.
 * @param {{ selector: string, decls: [string, string][] }} r @param {string} css
 * @returns {string[] | null}
 */
function groundOf(r, css) {
  const all = rules(css);
  /** @param {[string, string][]} decls */
  const bg = (decls) => {
    const d = decls.find(([q]) => q === 'background' || q === 'background-color');
    const m = d && /^var\(--([\w-]+)\)$/.exec(d[1].trim());
    return m ? m[1] : null;
  };
  const own = bg(r.decls);
  if (own) return [own];
  let sel = r.selector.split(',')[0].trim().replace(/::?[\w-]+(\([^)]*\))?$/, '');
  while (sel) {
    const hit = all.find((x) => x.selector.split(',').map((y) => y.trim()).includes(sel) && bg(x.decls));
    if (hit) return [/** @type {string} */ (bg(hit.decls))];
    const parts = sel.split(/\s+/);
    if (parts.length === 1) break;
    parts.pop();
    sel = parts.join(' ');
  }
  return null;
}

/** WCAG contrast, compositing a translucent foreground over its ground first. @param {Colour} fg @param {Colour} bg */
export function contrastRatio(fg, bg) {
  const over = /** @type {[number, number, number]} */ (fg.lin.map((u, i) => {
    const g = toGamma(Math.min(1, Math.max(0, u))) * fg.alpha
      + toGamma(Math.min(1, Math.max(0, bg.lin[i]))) * (1 - fg.alpha);
    return toLinear(g);
  }));
  const Y = (/** @type {number[]} */ l) => 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  const clip = (/** @type {number[]} */ l) => l.map((u) => Math.min(1, Math.max(0, u)));
  const [hi, lo] = [Y(clip(over)), Y(clip(bg.lin))].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Rules that set colour on a bare strong/span/b/i at more than one class of specificity,
 * and would therefore beat .up/.down on a nested signed figure. :where() counts for nothing.
 * @param {string} css
 */
export function signOverrides(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @param {string} sel */
  const specificity = (sel) => {
    const outside = sel.replace(/:where\([^)]*\)/g, ' ');
    const ids = (outside.match(/#[\w-]+/g) || []).length;
    const classes = (outside.match(/[.[][\w-]+|:[a-z-]+(\([^)]*\))?/g) || []).length;
    return ids * 100 + classes * 10;
  };
  /** @type {string[]} */
  const offenders = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|;)\s*color\s*:/.test(m[2])) continue;
    for (const one of m[1].split(',').map((x) => x.trim())) {
      if (!one || one.startsWith('@')) continue;
      const last = one.split(/\s+|>/).filter(Boolean).pop() ?? '';
      if (/^(strong|span|b|i)$/.test(last) && specificity(one) >= 10) offenders.push(one);
    }
  }
  return offenders;
}
