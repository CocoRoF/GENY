# Geny UI — shared design-system primitives

`src/components/ui/` is the single home for reusable, design-language
primitives. Prefer these over hand-rolled markup so buttons, dropdowns and
chrome stay visually consistent and theme-correct (light + dark) from one
place. All primitives resolve colours from the CSS tokens in
`app/globals.css` (`--bg-*`, `--text-*`, `--primary-*`, `--grad-primary`,
`hsl(var(--…))`), so they follow the lavender light / dark-lavender themes
automatically.

## Button (`Button`, from `./button`)

The canonical button. cva variant + size matrix:

- `variant`: `gradient` (Bold lavender CTA — the one main action of a
  surface) · `default` (solid primary) · `secondary` · `outline` · `ghost`
  · `destructive` · `link`
- `size`: `default` · `sm` · `lg` · `icon` · `icon-sm`

```tsx
import { Button } from '@/components/ui/button';
<Button variant="gradient" size="sm"><Plus size={13} /> 새 세션</Button>
<Button variant="secondary">취소</Button>
<Button variant="ghost" size="icon-sm"><RefreshCw size={12} /></Button>
```

Rule of thumb: **one `gradient` button per surface** (the primary action);
everything else is `secondary` / `ghost` / `outline`. Don't hand-roll
`bg-[var(--primary-color)]` buttons — add a variant here instead.

## Selector (`Selector`, from `./Selector`)

The reusable dropdown switcher (promoted from the env-management nav). A
trigger shows the active item; the popover lists items with icon + label +
optional description + active marker. Outside-click / Escape close built in.

```tsx
import Selector, { type SelectorItem } from '@/components/ui/Selector';
const items: SelectorItem<MyId>[] = [
  { id: 'a', label: 'Alpha', description: '…', icon: Layers },
];
<Selector items={items} value={tab} onChange={setTab} />
```

## Sparkle (`Sparkle`, from `./Sparkle`)

The ✦ four-point star motif. Pair with the `geny-sparkle` class for the
twinkle animation, or use plain for a static accent.

---

Also here: shadcn-derived primitives (`badge`, `card`, `dialog`, `input`,
`select`, `switch`, `tabs`, `textarea`, `tooltip`, …), `InfoTooltip`,
`NumberStepper`. Extend a primitive (new variant/prop) rather than forking
a one-off in a feature folder.
