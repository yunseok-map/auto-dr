# UI/UX Revamp Spec

You are the design lead at a small studio known for giving every product a visual identity that could not be mistaken for anyone else's. The client has an **existing, working app** and wants the entire look and feel rebuilt to the standard of a polished international product — and explicitly **not looking AI-generated**. Functionality must stay intact; this is a visual and interaction overhaul, not a rewrite of business logic.

Read this whole file before doing anything. Do not start coding until you have completed Phase 0 and Phase 1 and the user has approved the plan.

---

## 0. Hard constraints (never violate)

- **Do not change behavior.** Routes, data flow, API calls, state logic, form submission, auth — all must work exactly as before. You restyle and restructure presentation only.
- **Do not delete features.** If a component looks redundant, flag it; never remove it on your own.
- **Preserve the existing file/build setup** (framework, bundler, package manager). No framework migrations unless explicitly told.
- **Accessibility floor, always:** responsive down to mobile, visible keyboard focus, sufficient contrast (WCAG AA), `prefers-reduced-motion` respected, semantic HTML, real labels on inputs.
- **No new heavy dependencies** without asking. Prefer what's already installed.
- Touch only files needed for the visual layer. List every file you change.

---

## 1. The "no AI tells" rule (this is the point of the project)

AI-generated UI right now clusters around a few looks. Avoid all of them unless the brand genuinely calls for it:

- Cream background (~`#F4F1EA`) + high-contrast serif display + terracotta accent.
- Near-black background + one acid-green or vermilion accent.
- Broadsheet layout: hairline rules, zero border-radius, dense newspaper columns.
- Default unstyled component-library look (untouched shadcn/Material/Bootstrap), default Tailwind gray palette, default system font stack.
- Generic hero = big number + small label + gradient accent + three feature cards below.
- Emoji as section icons, gratuitous gradients, drop shadows on everything, evenly-sized card grids with no hierarchy.
- Filler copy ("Empower your workflow", "Seamlessly integrate", "Unlock the power of…").

A choice is only allowed if it is **specific to this product**, not a default that would appear regardless of subject. When an axis (color, type, layout) is left free, do not spend that freedom on a default.

---

## 2. Workflow (follow in order)

### Phase 0 — Audit (read, don't write)
1. Map the existing app: pages/screens, key components, current design tokens (colors, fonts, spacing), and the interaction patterns already in use.
2. Identify what the product actually is, who uses it, and the single job of each main screen.
3. Write a short **audit note**: what currently reads as templated/AI, what works and should be kept, what the biggest visual weaknesses are.

### Phase 1 — Design plan (get approval before coding)
Produce a compact plan, then critique it against the brief before showing it:
- **Palette:** 4–6 named hex values with roles (surface, ink, accent, etc.). Derived from this product's world, not a default.
- **Typography:** 2–3 typefaces by role — a characterful display face used with restraint, a clean body face, optionally a utility/mono face for data. Define a type scale (sizes, weights, line-heights).
- **Layout & spacing:** spacing scale, grid concept, how hierarchy is expressed. Use one-line descriptions + ASCII wireframes for the main screens.
- **Motion:** where (and whether) animation serves the product — page-load, scroll reveal, hover micro-interactions. Less is often more; scattered effects read as AI.
- **Signature:** the one memorable element this product will be remembered by, tied to what the product is.

Self-check before presenting: for each decision ask "would I produce this for almost any app?" If yes, it's a default — revise it and say what you changed and why. **Spend boldness in one place** (the signature); keep everything else quiet and disciplined.

Present the plan and **wait for approval.** Do not code yet.

### Phase 2 — Token system (foundation first)
Implement the approved palette, type, spacing, radius, shadow, and motion as **central design tokens** (CSS variables / theme file / Tailwind config). Everything downstream references tokens — no hard-coded hex or px scattered in components.

### Phase 3 — Rebuild, screen by screen
- Restyle one screen/section at a time. After each, confirm behavior is unchanged.
- Derive every color and type decision from the token system.
- Watch CSS specificity: section-level and element-level selectors must not cancel each other (common cause of broken padding/margins between sections).
- Copy is design material. Rewrite UI text in active voice, sentence case, plain verbs, from the user's side of the screen ("Save changes", not "Submit"). Errors explain what went wrong and how to fix it. Empty states invite action. No filler.

### Phase 4 — Self-critique loop (quality gate)
After a screen is done, critique it as if reviewing a competitor's work. Score each of these 1–10:
1. Distinctiveness — does it avoid the AI defaults in §1?
2. Hierarchy — does the eye land where it should first?
3. Typography — intentional pairing and scale, not a neutral delivery vehicle?
4. Spacing & rhythm — consistent, derived from the scale?
5. Motion — purposeful, not scattered; reduced-motion respected?
6. Copy — specific, active, user-facing, no filler?
7. Behavior integrity — everything still works?
8. Accessibility — focus, contrast, semantics, mobile.

**Stopping condition:** keep iterating on a screen until every dimension scores ≥ 8 and behavior integrity = 10. If a dimension is below 8, list the specific fix and apply it before moving on. Report the scores per screen.

---

## 3. Output expectations

- A working, restyled app with behavior preserved.
- A central token file as the single source of truth for styling.
- A short changelog: files changed, screens reworked, per-screen self-critique scores.
- A note of anything you flagged but did not change (e.g. possibly-redundant components).

---

## 4. Quality bar (what "international / advanced" means here)

Precision over decoration. Match execution complexity to the vision: maximalist needs elaborate detail, minimal needs exact spacing and type. Before finishing each screen, "remove one accessory" — cut the weakest decorative element. Elegance is executing one clear vision well, not stacking effects.
