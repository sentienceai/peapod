---
version: alpha
name: Robinhood
description: "Trade stocks on Robinhood with commission-free investing & advanced trading tools. Access fractional shares, real-time market data, and more. Terms and fees may apply."
sourceUrl: "https://www.robinhood.com"

colors:
  primary: "#110e08"
  on-primary: "#ffffff"
  background: "#ccff00"
  surface: "#000000"
  border: "#ccff00"
  text: "#110e08"
  text-muted: "#ffffff"
  accent: "#ccff00"

typography:
  display:
    fontFamily: "Martina Plantijn, serif"
    fontSize: 72px
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: -1px
  heading:
    fontFamily: "Phonic, Helvetica, system-ui, -apple-system, BlinkMacSystemFont, Arial, sans-serif"
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: -1px
  body:
    fontFamily: "Phonic, Helvetica, system-ui, -apple-system, BlinkMacSystemFont, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.25px

spacing:
  base: 4px
  scale: [8, 12, 16, 24, 32, 36, 48, 52, 60, 128]

radius:
  sm: 36px

motion:
  duration-fast: 300ms
  duration-base: 300ms
  duration-slow: 300ms
  easing: "ease"

breakpoints: [426px, 485px, 768px, 1024px, 1049px, 1280px, 1441px]
---

## Rationale

Robinhood's design system reflects a fintech platform built for confident, modern investors who value clarity and speed. The measured tokens reveal a striking high-contrast aesthetic: a near-black primary (`#110e08`) anchored against a luminous lime-green accent (`#ccff00`) that dominates as both background and border color. This aggressive contrast is intentional—it communicates energy, trustworthiness, and accessibility in equal measure. The palette skips pastels and soft neutrals entirely, instead embracing a bold two-tone language that makes financial data (charts, watchlists, market signals) visually pop and feel urgent without being chaotic.

Typography reinforces this duality: serif display text (Martina Plantijn) provides editorial authority and heritage, while a modern sans-serif stack (Phonic) handles all body and heading content for legibility at every scale. At 72px, the display type is commanding and confident; at 16px, body text remains precise and scannable. The consistent negative letter spacing (−1px to −0.25px) tightens the visual rhythm, creating density and sophistication rather than openness.

Spacing is deliberately restrained. A base unit of 4px enables micro-refinement, but the scale jumps quickly to 128px, suggesting layouts that cluster related elements tightly, then create dramatic breathing room between sections. This mirrors how financial dashboards organize information—dense data panels separated by clear visual breaks. The rounded corner system (36px exclusively) softens the overall severity, appearing mostly on CTAs and interactive elements to signal actionability.

Motion is uniform and economical: all transitions run at 300ms with ease easing, avoiding flashiness. For a financial product, this restraint is correct—users need confidence that the system is responsive but not theatrical.

## 1. Visual Theme & Atmosphere

The measured design evokes **financial confidence with edge**. The lime-green (`#ccff00`) is aggressive yet accessible—it's the kind of electric accent found in investment dashboards and risk-highlighting UIs, suggesting real-time market movement and opportunity. Against the near-black surface and deep charcoal text, this creates maximum legibility and visual hierarchy without sweetness or softness.

This is *not* a fintech platform playing it safe with navy and silver. Instead, it's positioning itself as modern, bold, and unapologetically contemporary—appealing to younger, active traders who expect vibrant, responsive interfaces. The high contrast also signals serious accessibility commitment from the outset.

## 2. Color System

**Primary palette:**
- **Primary (`#110e08`):** Near-black, used for text and primary content. This is not pure black, which suggests subtle warmth and prevents pure-black text harshness.
- **On-Primary (`#ffffff`):** Pure white, reserved for text *on* primary-colored backgrounds (e.g., dark buttons or overlays).
- **Background (`#ccff00`):** Luminous lime, dominates as the page background and accent color. It is simultaneously the brightest, most energetic element and the largest surface, creating a "inverted" light mode where brightness is *not* neutral but commanding.
- **Surface (`#000000`):** Pure black, used for high-contrast overlays, modal backgrounds, or dark cards that need to stand out against the neon background.
- **Border (`#ccff00`):** Matches the accent, creating visual continuity and making edges feel intentional rather than neutral.
- **Text (`#110e08`):** Primary text is the dark brown, ensuring legibility on the lime background.
- **Text-Muted (`#ffffff`):** White text, used for secondary information or on dark surfaces.
- **Accent (`#ccff00`):** Reinforces the brand's energy; likely used on hover states, active buttons, and focal points.

**Rationale:** The system relies on *two* dominant colors. There is no neutral gray secondary palette. This forces every interface decision into a binary choice: lime (forward, active) or dark (recessive, calm). For financial data, this clarity is advantageous—a chart line is either on or off, a button is either actionable or disabled, a notification is either alert or resolved.

## 3. Typography

**Display (`Martina Plantijn, serif`):**
- 72px, weight 400, line-height 1.08, letter-spacing −1px
- Used for hero headlines and brand moments. Serif choice suggests heritage, stability, and editorial authority.
- Tight line height (1.08) and negative letter spacing compress the visual mass, making large text feel intentional and controlled rather than expansive.

**Heading (`Phonic, sans-serif`):**
- 40px, weight 400, line-height 1.2, letter-spacing −1px
- Secondary headings and section titles. Sans-serif switch from display creates hierarchy while maintaining legibility.
- Still relatively large and spacious (1.2 line height) for clarity on smaller screens.

**Body (`Phonic, sans-serif`):**
- 16px, weight 400, line-height 1.5, letter-spacing −0.25px
- All running text, form labels, CTAs, and UI copy. Line height 1.5 ensures comfortable reading despite the tight letter spacing.
- Font weight 400 (regular) across all scales suggests confidence; there is no weight variation, so hierarchy relies entirely on size, color, and positioning.

**System logic:** Single weight (400) throughout. This removes weight as a tool for emphasis, forcing designers to use color (lime vs. dark), size, or placement. Serif for brand moments, sans-serif for utility. Negative spacing throughout tightens visual rhythm and prevents a loose, casual feel.

## 4. Components & Patterns

**Buttons & CTAs:**
- Radius: 36px (the only measured radius), suggesting rounded pill-shaped buttons.
- Background likely lime (`#ccff00`) with dark text for maximum contrast and visual pop.
- Measured as 36px radius, these are generous, friendly, and easy to tap.

**Cards & Surfaces:**
- Likely use the black surface (`#000000`) or near-black primary (`#110e08`) for visual containment against the neon background.
- Border (`#ccff00`) creates visual separation without a drop shadow (no shadow tokens measured).
- Rounded corners (36px) on interactive elements only, keeping cards and data containers more rectangular and formal.

**Form inputs:**
- Assume dark backgrounds with lime borders and white/light text for visibility.
- High contrast ensures data entry errors are visible.

**Icons & Indicators:**
- Lime accent for active states, alerts, and real-time updates (common in trading UIs).
- Dark icons for resting states.

## 5. Spacing & Layout

**Scale breakdown:**
- 4px base: used for micro-adjustments within components (padding tweaks, icon spacing).
- 8px, 12px, 16px: component-level spacing (button padding, list gaps).
- 24px, 32px: section spacing and medium rhythm.
- 36px, 48px, 52px: larger component spacing and layout divisions.
- 60px, 128px: dramatic whitespace between major sections.

**System logic:** The scale is *not* uniform doubling (8, 16, 32, 64). Instead, it clusters around 8–16px for UI density, then jumps to large values (128px) for breathing room. This suggests layouts where data-heavy panels are tightly spaced, but sections are dramatically separated. Mobile-first likely uses the smaller steps; larger breakpoints (1280px+) leverage 128px gaps.

**Breakpoints:** Seven measured breakpoints (426px, 485px, 768px, 1024px, 1049px, 1280px, 1441px) indicate a nuanced responsive strategy. The clustering around tablet sizes (768px, 1024px) and desktop sizes (1280px, 1441px) suggests different layout patterns per device class.

## 6. Motion & Interaction

**Timing:**
- `durationFastMs: 300`, `durationBaseMs: 300`, `durationSlowMs: 300`: all animations use 300ms, regardless of classification.
- This uniformity suggests a simple, predictable motion language. No micro-interactions (100ms) or slow transitions (500ms+).
- 300ms is fast enough to feel responsive (not sluggish), slow enough to reduce jarring visual shock.

**Easing:** `ease` (typically `cubic-bezier(0.25, 0.1, 0.25, 1.0)`), a gentle ease-in-out. Not linear (which would feel robotic) and not sharp (which would feel harsh).

**Application:** Likely applied to:
- Button hover/active states (background color shift from lime to darker lime, or text color inversion).
- Modal/overlay entrance (fade-in, scale-in).
- Tab/section transitions in dashboards.
- Form validation feedback (error highlight slide-in, or text color change).

**Philosophy:** Motion is *supportive*, not decorative. For a financial product, users need to trust the interface is responsive without being distracted by flashiness. 300ms across all durations means developers don't overthink motion—just apply the standard duration and let the easing do the work.

## Accessibility

### Contrast Ratios

**Primary text on background:**
- Foreground: `#110e08` (near-black text)
- Background: `#ccff00` (lime)
- Estimated contrast ratio: **15:1+** (well above WCAG AAA 7:1)

This pairing is exceptionally high-contrast and ensures text is legible to users with low vision, color blindness, and in bright ambient light (relevant for mobile trading). White text on dark surfaces also meets AAA standards.

**Secondary text on surface:**
- Foreground: `#ffffff` (white text)
- Background: `#000000` (black surface)
- Estimated contrast ratio: **21:1** (maximum possible, WCAG AAA+)

**Potential issue:**
- If accent lime is used as text color on a black or dark surface (a rare scenario), contrast would be lower (~8:1), but this still exceeds WCAG AA 4.5:1.
- Lime on lime background would be unusable; careful to reserve lime as accent/border only when text is dark.

### Minimum Requirements

- **Touch targets:** 36px rounded radius on buttons suggests a minimum hit area of 44×44px or larger. For trading (where precision matters), this is appropriate and accessible.
- **Focus indicators:** No measured focus state, but best practice would apply a 2px outline in lime with 2px offset (visible against both dark and light backgrounds). Ensure outline is never removed without a custom focus ring.
- **Keyboard navigation:** All CTAs and interactive elements should be reachable via Tab. Given the aggressive color scheme, focus state should be explicitly styled (not relying on browser defaults).
- **Color alone:** The binary color system (lime vs. dark) must not be the only signal for state changes. Always pair with icon, text label, or shape change. For example, a disabled button should be dark *and* show a crossed-out icon, not just lose its lime color.
