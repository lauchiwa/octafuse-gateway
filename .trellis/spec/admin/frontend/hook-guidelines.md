# Hook Guidelines — `@octafuse/admin`

> Custom hooks and data-fetching conventions.

---

## Overview

There is **no** React Query / SWR in this project. Data fetching is done with the native `fetch` API, wrapped per domain in `<domain>-api.ts`, and orchestrated by a single per-page state hook `use-<domain>-page-state.ts`. State lives in `useState` / `useRef`; effects drive loading and URL sync.

---

## Custom Hook Patterns

**The page-state hook is the core pattern.** Each feature page has one:

```ts
export function useModelsPageState() {
	const tCatalog = useTranslations('models.catalog');
	const searchParams = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();

	const [models, setModels] = useState<ModelListItem[]>([]);
	const [selectedVendor, setSelectedVendor] = useState(ALL_VENDORS_KEY);
	// ... more UI + data state

	const reload = useCallback(async () => {
		const list = await fetchModelsList();   // from model-api.ts
		setModels(list);
	}, []);

	useEffect(() => { void reload(); }, [reload]);

	return { models, selectedVendor, setSelectedVendor, /* actions */ };
}
```

Conventions:
- Wrap async actions in `useCallback`; call from effects with `void reload()` to make the floating promise explicit.
- Return a flat object of state + setters + actions; the page shell destructures it.
- Keep DOM/presentation out of the hook — it returns data and callbacks only.
- Sub-hooks are allowed for focused concerns (e.g. `use-model-edit-modal.ts`, `useBillingCurrency`, `useReplaceListPageQuery`); compose them inside the page-state hook.

---

## Data Fetching

- All network calls go through `<domain>-api.ts` functions, which use `fetch('/api/admin/...')` + `readApiJson<T>` from `lib/api-json.ts`.
- The API wrapper unwraps `{ success, data?, message? }`: on success return `data`; on failure `throw new Error(data.message || '<fallback>')`.
- `readApiJson` auto-fires `notifyAdminSessionExpired()` on a 401 from `/api/admin` — do not re-implement session-expiry handling in each caller.
- Encode path params: `encodeURIComponent(id)` when building URLs.

```ts
export async function fetchModelDetail(id: string): Promise<ModelListItem> {
	const response = await fetch(`/api/admin/models/${encodeURIComponent(id)}`);
	const data = await readApiJson<ModelListItem>(response);
	if (data.success && data.data) return data.data;
	throw new Error(data.message || 'Failed to load model');
}
```

---

## Naming Conventions

- Page-state hook: `use-<domain>-page-state.ts` → `use<Domain>PageState()`.
- Focused hooks: `use-<thing>.ts` → `use<Thing>()`.
- API functions: verbs — `fetch*`, `save*`, `delete*`, `import*`.

---

## Common Mistakes

- Calling `fetch` directly in a component or hook instead of a `<domain>-api.ts` wrapper → inconsistent error handling and lost 401 session-expiry hook.
- Forgetting `useCallback` deps → stale closures or effect loops.
- Putting derived/pure computation in the hook body instead of `<domain>-utils.ts` (harder to unit-test).
