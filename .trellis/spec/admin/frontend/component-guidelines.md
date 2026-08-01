# Component Guidelines — `@octafuse/admin`

> How React components are built in the Admin console.

---

## Overview

- **Framework**: Next.js 16 (App Router) + React 19.
- **Styling**: Tailwind CSS 3 (`app/globals.css` is the entry; config in `tailwind.config`/`postcss.config`). Icons via `@heroicons/react` and `simple-icons`. Charts via `recharts`.
- **i18n**: all user-visible copy goes through `next-intl` — see [Type Safety](./type-safety.md) and the [i18n rules](#internationalization) below.
- **Server vs client**: default to Server Components; add `'use client'` only when the file uses hooks, state, effects, or browser APIs. Page shells that wire up a page-state hook are client components.

---

## Component Structure

A domain component file:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import type { ModelListItem } from '../types';

type ModelCardProps = {
	model: ModelListItem;
	onEdit: (id: string) => void;
};

export function ModelCard({ model, onEdit }: ModelCardProps) {
	const t = useTranslations('models.catalog');
	// ...
}
```

- One primary exported component per file; small local subcomponents may share the file.
- Presentational components take data + callbacks via props. Data fetching and mutation live in the page-state hook, not in leaf components.
- Modals follow the `<domain>-modal.tsx` / `<domain>-import-modal.tsx` naming and are controlled by the page-state hook (open/close state lifted up).

---

## Props Conventions

- Define a named `type <Component>Props = { ... }` above the component. Prefer `type` over `interface` for props (matches existing files).
- Callbacks are named `on<Event>` (`onEdit`, `onDelete`, `onClose`).
- Do not accept raw untyped API payloads; accept the domain type from `types.ts`.
- Booleans read as flags (`isOpen`, `disabled`, `readOnly`).

---

## Styling Patterns

- **Tailwind utility classes** applied inline via `className`. No CSS modules or styled-components.
- Global styles and Tailwind layers live in `app/globals.css`.
- Reuse shared shells/components (`ConfigCardShell`, `GatewayTimeRangePicker`, pricing editors) rather than re-implementing layout.
- Vendor/brand visuals: use `model-vendor-icon.tsx`, `upstream-brand-logo.tsx`, `provider-protocol-icon.tsx` instead of hardcoding logos.

---

## Accessibility

- Use semantic elements (`button` for actions, `label`+`htmlFor` for inputs). Interactive `div`s need `role` + keyboard handlers — prefer native controls.
- Provide `aria-label` / accessible text for icon-only buttons.
- Keep focus management sane in modals (Escape to close, focus trap where the shared modal provides it).

---

## Internationalization

- **Never hardcode user-visible English** in JSX or `lib/*` UI helpers. Use `useTranslations('namespace')` (client) or `getTranslations` from `next-intl/server` (server layout/metadata).
- Add every new string to **all four** `messages/{en,zh,ja,ko}.json` with identical key structure; `messages/en.json` is the structural baseline.
- For helper-produced labels, pass a `t()`-derived labels object (see `lib/pricing-ui.ts` `PricingLabels`, `getBusinessTimezoneOptions`, `getBillingCurrencyOptions`) rather than embedding strings in the helper.
- **Out of scope for i18n** (display/emit as-is): Hono/service error messages (`data.message`), JSON presets (`provider-import-presets.json`, `model-presets/*`), provider/model IDs.

---

## Common Mistakes

- Adding a string to `en.json` only → runtime missing-key gaps in zh/ja/ko. Update all four.
- Fetching inside a leaf component instead of the page-state hook → duplicated requests and untestable logic.
- Marking a whole subtree `'use client'` when only a leaf needs interactivity → lost Server Component benefits.
- Hardcoding `/api/admin/...` calls inside components instead of routing through `<domain>-api.ts`.
