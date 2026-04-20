# 04 — Environment detail as centered modal + Builder render fix

**Cycle:** 2026-04-20 follow-up.
**Branch:** `fix/env-detail-modal-and-builder-rerender`.
**Reported:** browser console threw a minified React error #300 the
moment the user clicked the primary "빌드하기 (Open in Builder)"
button, and the right-side env detail panel's footer wrapped 5–6
labelled buttons into a broken layout in the narrow 520 px slide-over.

## Outcome

1. **No more React #300 on Build.** `EnvironmentsTab` no longer
   short-circuits with `return <BuilderTab />` *before* declaring its
   remaining hooks. The branch now lives at the bottom of the function,
   after every `useState` / `useEffect`, so the hook order stays
   stable across the list ↔ builder transition.
2. **Env detail is a centered modal.** The slide-over `aside` is
   replaced with a 720 px-wide centered modal (same backdrop pattern
   as `ConfirmModal`). Esc closes it.
3. **Footer no longer bursts.** Only the primary "Open in Builder"
   action keeps text+icon. Delete (left) and the four secondary
   actions — Compare / Clone / Export / Import — collapse to 36 × 36 px
   icon-only buttons with `title` and `aria-label` tooltips. A 1 px
   divider separates the secondary cluster from the primary CTA.

## Why React #300 fired

Before this PR, the component looked like:

```tsx
export default function EnvironmentsTab() {
  const { …, builderEnvId } = useEnvironmentStore();

  if (builderEnvId) {
    return <BuilderTab />;          // ← early return
  }

  const sessions = useAppStore(s => s.sessions);  // ← hook #2
  const [showCreate, setShowCreate] = useState(false);  // ← hook #3
  // …14 more hooks…
}
```

Mount #1 ran 17 hooks; the moment `openInBuilder(envId)` flipped
`builderEnvId` to a string, mount #2 ran exactly **one** hook, then
returned — violating the Rules of Hooks. React detected the mismatch
and threw the minified #300 / #310 family of errors. The fix is to
defer the conditional return until after every hook is called, so
both renders see the same stable hook list.

## Changes

| File | Change |
|------|--------|
| `frontend/src/components/tabs/EnvironmentsTab.tsx` | Move `if (builderEnvId) return <BuilderTab />` from above the second hook to immediately above the list-view `return`. |
| `frontend/src/components/EnvironmentDetailDrawer.tsx` | Header comment updated; container swapped from right-side `aside` to a centered backdrop+dialog `div` with `role="dialog"` / `aria-modal="true"`; new Esc handler; footer rewritten — primary CTA on the right, secondaries icon-only with tooltips, danger delete on the left, separator between groups. |

The component filename stays `EnvironmentDetailDrawer.tsx` so git
history (and the two import sites in `EnvironmentsTab.tsx` /
`InfoTab.tsx`) is unaffected. Inline comment notes the layout
migration date.

## Verification

- Manual: open Environments → create or pick an environment → modal
  opens centered with the full action row visible without wrapping.
  Press Esc → closes. Click Open in Builder → switches to the stage
  editor without throwing.
- Manual: same flow from GraphTab "Environment: …" badge — the
  drawer pops in the centered modal layout.
- TypeScript / lint: relies on CI (no local node toolchain in this
  environment).

## Out of scope

- The Builder tab's own UX (16-stage layout, manifest-driven dynamic
  rendering) — still queued from §2 stretch in `dev_docs/20260420/plan.md`.
- Tooling that would render the secondary actions inside an overflow
  menu when the modal is resized below ~520 px wide. The current
  icon-only footer already comfortably fits a 320 px modal width.
