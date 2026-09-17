# Prompt to paste into Claude Code

Put this folder in the repo at `design/` first, then run Claude Code in the repo root and paste this.

---

Read `design/DESIGN_HANDOFF.md` and `design/tokens.css` in full, then skim every file in `design/screens/`. They are the approved designs for this product. The `.dc.html` files are mockups, not code to copy. All data inside them is fake.

Your job is a reskin of the existing frontend. Do not change the backend, the API contracts or the data layer. Keep all current routes and real data working.

Plan first, do not write code yet:

1. Inventory the current frontend: framework, styling approach, component structure, routes, where API data enters the UI.
2. Map each design screen to the pages and components that exist today. Call out anything in the designs that has no backend support and anything on the site that the designs do not cover.
3. Propose the token setup (how `design/tokens.css` plugs into the current styling), the shared component list, and a phase order.

Show me that plan and wait for my approval.

Then implement in phases, one PR-sized change at a time, in this order: tokens and theme switch, shared components, leaderboard, copy trade, trader profile, copy setup, search, asset page, landing. After each phase, run the app, check the screen in light and dark mode, and show me a screenshot before moving on.

Rules:

- Every color, font, radius and shadow comes from the tokens. No new hex values in components.
- Match the spacing, sizes and radii in the mockups. Read the inline styles instead of guessing.
- Wire every screen to real API data. If a field in the design does not exist in the API yet, render a clear empty state and list it for me rather than inventing a value.
- Keep the existing accessibility and add what the designs specify: real buttons and links, labeled inputs, `aria-label` on icon-only buttons.
- No leverage, margin, liquidation or funding concepts anywhere. This product is spot only.
- Ask me before adding any new dependency.
