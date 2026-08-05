# Upstream Merge Thinking Guide

> **Purpose**: Resolve fork-vs-upstream conflicts without silently losing a feature or a semantic.

Use this when merging `upstream/main` into this fork. Companion doc with the
fork's specific divergences: [docs/developers/upstream-sync.md](../../../docs/developers/upstream-sync.md).

---

## The Core Trap

**"It compiles and tests pass" does not mean the merge is correct.**

A conflict can be resolved into code that type-checks, passes every existing test, and still
has lost a behavior — because the tests that would have caught it were written against the
pre-merge shape, or never existed. Every finding below came from a real merge (upstream v2.0.0)
where typecheck was green *before* the defect was found.

---

## Step 1: Classify Each Conflict Before Editing

| Shape | Meaning | Default action |
|---|---|---|
| Both sides add a field / key / row | Additive | **Keep both** |
| Upstream deleted the file (`DU`/`UD`) | Upstream dropped the feature | Decide explicitly: is our change still wanted? |
| Upstream rewrote the surrounding module | Structural | **Take upstream wholesale, then graft ours in** |
| Same line, different intent | Semantic | Read both implementations before choosing |

### Don't: splice conflict blocks in a rewritten module

When upstream has restructured a file (renamed types, changed a data model), resolving
block-by-block produces code that references a structure that no longer exists.

```
# Wrong: stitch the two halves of each <<<<<<< block together
# Right:
git checkout --conflict=diff3 -- <file>   # inspect
git show upstream/main:<path> > <file>     # take upstream baseline
# then re-apply only our delta at the 2-3 real insertion points
```

**Why**: our delta is usually small and localized; upstream's rewrite is the new ground truth.
Rebuilding our change on top is faster *and* leaves no dangling references.

---

## Step 2: Verify Order-Sensitive Code Explicitly

Merging never warns you about ordering. Check these by hand:

- [ ] **Positional SQL binds** — column list length must equal bind list length, in the same order
- [ ] **Function parameter order** — if both sides added a param, callers may now pass the right
      value into the wrong slot. This type-checks whenever the params share a type.
- [ ] **Array/tuple destructuring** in test fakes that mirror a real signature

> **Real defect**: a merged `INSERT` grew from 5 to 7 columns. A test fake destructured the
> old 5-position bind order and mapped `status` onto `custom_headers` — it failed loudly.
> The same reorder in a `(…, isAudioModel, openaiSurface)` signature passed a surface value
> into the audio slot and type-checked silently.

---

## Step 3: Ask "Does Upstream Already Do This Better?"

Before defending our version of a conflicted file, read upstream's implementation fully.

> **Real case**: this fork patched the deploy scripts for Windows using `shell: true` plus
> manual `shellQuote`. Upstream had independently solved it with `npm_execpath` + a `cmd.exe`
> fallback and **no shell at all** — strictly better, since it removes the injection surface.
> Keeping ours would have preserved a weaker fix.

Check before discarding ours: does upstream's version actually cover our case, or just look similar?

---

## Step 4: Hunt for Overridden Semantics

The subtlest loss: both sides' code survives, but one side's *intent* is now overridden by
the other's control flow.

- [ ] Did we sort/filter something that upstream now re-sorts downstream?
- [ ] Did we set a default that upstream now recomputes later?
- [ ] Did we add a guard that upstream's new early-return skips?

> **Real case**: `/v1/responses` sorted routes "passthrough-first". Upstream's new planner
> re-sorts within each priority tier, silently discarding that preference. Nothing failed.
> The fix was better than restoring the old behavior: demote the preference to *tier-local*,
> so admin's priority tiers win (upstream's semantic) and passthrough-first still holds
> inside a tier (ours) — which also removed the original design's "overrides admin config" cost.

**Lesson**: when upstream's architecture subsumes our hand-rolled mechanism, re-express our
intent in *their* extension point instead of reinstating our version.

---

## Step 5: Check Data Already Written to Disk

**The one class of defect no test and no typecheck can catch.** Code compatibility is not data
compatibility. If our fork changed how a value is *stored*, dropping our code does not un-transform
rows already in the database.

Ask for every feature being dropped or restructured:

- [ ] Did our version write a **different on-disk representation** (encrypted, hashed, encoded,
      renamed, re-scaled) than upstream's?
- [ ] Does the migration that folds those rows into the new schema **transform** them, or just
      `SELECT`/copy them verbatim? Raw SQL copies ciphertext as happily as plaintext.
- [ ] After the merge, does *any* code path still know how to read the old representation?
- [ ] Is the transform **destructive** (`DROP TABLE`, column drop) — i.e. is the original
      recoverable afterwards at all?
- [ ] Does an escape hatch (export script, backup runbook) actually round-trip the *transformed*
      value, or does it silently dump the unusable form?

> **Real defect (2026-08 merge, found only in post-merge review)**: this fork encrypted provider
> credentials at rest (`ofk1.` AES-GCM). Adopting upstream's single-key model deleted every
> decryption path, while upstream's migration copied `provider_api_keys.api_key` into
> `providers.api_key` with plain SQL and then `DROP TABLE`d the source. Net effect: the gateway
> would send `ofk1.…` as a bearer token — every provider 401s, plaintext unrecoverable.
> All 511 tests were green, because every fixture used plaintext.
> Worse, upstream's documented escape hatch (`export-provider-api-keys.mjs`) reads over raw SQL,
> so it "backs up" ciphertext and restores nothing usable.

**Rule**: when dropping a storage-format feature, write the decrypt/decode **down-migration first**
or explicitly confirm with the owner that the data is disposable — and record which was chosen.
Never infer from "tests pass" that stored data survived.

> **Deployment follow-up (2026-08-02)**: the owner's "data disposable" call was made after
> checking only the *local* D1 database (3 rows, all plaintext, `ofk1.` count 0 → "trap not
> triggered"). The **remote production database** had never been checked: it held 9 `ofk1.`
> ciphertext rows across 6 providers. Applying `0017` copied ciphertext into
> `providers.api_key`, `DROP TABLE` discarded the only copy, and the deployed gateway now
> 401s on every provider until keys are re-entered. Lesson: the Step 5 data check must run
> against **every deployed environment** (local + each remote D1/Postgres/MySQL), not just
> the dev database — "safe locally" is not evidence about production.

---

## Step 6: Prove the New Tests Actually Bite

After adding tests for merged behavior, mutate the source to confirm they fail.

```bash
# break the behavior deliberately, run the test, expect red, then restore
```

A test that passes against both the correct and the broken implementation documents nothing.
Verify each *distinct* semantic separately — for a tier-local preference, that means one
mutation for "preference not applied" and another for "preference leaks across tiers".

---

## Step 7: Audit Both Directions

Grep for both sets of features after the merge — not just ours.

- [ ] Every feature **we** added still present and wired (not merely file-exists: check the call site)
- [ ] Every feature **upstream** added still present
- [ ] Every file upstream **deleted** is fully gone, with no dangling imports or dead env plumbing
- [ ] Docs and CHANGELOGs that contain *executable instructions* (paths, migration filenames,
      commands) updated — a stale path in an ops runbook is a real defect

> **Real case**: dropping the provider-key encryption left `PROVIDER_KEY_ENCRYPTION_KEY`
> threaded through two files and an ops doc still instructing "keep ours" for a deleted feature.

> **Real case (2026-08, custom headers regression)**: a fork feature's *file* survived the merge
> but its **call site semantics** silently broke. Upstream refactored `updateProviderService` from
> `const patch = { ...body }` (spread the whole body, then mutate) to an empty object filled
> per-field. Our merge re-applied the fork logic (`if ('customHeaders' in patch) { ... }`) onto
> the new shape — but `patch` no longer contained `customHeaders` (it now lives only in `body`),
> so the branch never fired and `custom_headers` was silently never written. A second upstream
> addition, `if (Object.keys(patch).length === 0) return`, turned header-only edits into a no-op.
> The admin UI saved fine and the DB just lost the data; only "save then refresh the modal"
> exposed it. Lesson: after a merge, a feature check is not "file present" — verify the *binding*
> between the fork's shape assumptions and the merged code (camelCase→snake_case conversion,
> spread-vs-fieldwise object building, early returns) with a regression test that asserts on the
> actual write path, and mutate it to confirm it fails against the merged (broken) shape.

> **Real case (2026-08, v2.1.1 merge — a fork-only route referencing a deleted module)**: upstream
> replaced `sensitive-content-circuit-route` with `user-model-circuit-route` and migrated its own
> `chat` / `messages` / `gemini` routes. The fork's `/v1/responses` route does not exist upstream, so
> nothing migrated it — it still imported the deleted module. **Typecheck caught the import**, but the
> important part was invisible: upstream's migration also added `markUserModelSuccess()` on the
> success path, which the fork route never had. Fixing only the import would have compiled, passed
> every test, and left `/v1/responses` with a backoff ladder that never resets after a success.
> **Lesson**: when upstream deletes a module it migrated its own callers away from, a fork-only caller
> needs the *whole* migration, not just a working import. Diff the fork route against a route upstream
> migrated and reconcile the behavior, not the symbol.

> **Real case (2026-08, v2.1.1 merge — positional args after a signature change)**: both sides added a
> trailing optional parameter to `bodyTemplateForSelection` / `isBodyDirty` — upstream `toolId`, the
> fork `openaiSurface`. Keeping both means picking an order, and three existing call sites then passed
> `openaiSurface` into the `toolId` slot. Both are `string`-shaped, so it type-checked silently.
> **Lesson**: after resolving a conflict where both sides appended a parameter, grep every call site
> and re-read it against the merged signature. Type-compatible neighbours do not surface this.

> **Real case (2026-08, v2.1.1 merge — a guard that could not fail)**: the fork's Responses surface was
> centralized behind `resolvesToResponsesSurface(kind, protocol, surface)`. Mutating away its
> `kind`/`protocol` conditions turned **no test red** — because both call sites already narrowed to
> `llm` + `openai` before calling it. The guard was documentation, not protection.
> **Lesson**: mutation-test the guard itself, not just the feature. If weakening a safety condition
> cannot fail a test, the condition is either unreachable (delete it and pin the real call-site
> protection) or genuinely untested (add the test). "A check exists" is not "a check runs".

> **Docs are executable too (2026-08, v2.1.1 merge)**: three files auto-merged with **no conflict** and
> silently reintroduced upstream's `0015`/`0016` migration filenames plus a stale `2.0.0` version
> claim. This fork renumbered those to `0017`/`0018`, and migration identity is the *full filename* —
> so a clean auto-merge left operator runbooks pointing at files that do not exist here.
> **Lesson**: conflict-free does not mean correct. After a merge, grep the docs for every renumbered
> migration name and version baseline; non-conflicting prose is where fork-specific operational facts
> quietly revert.


---

## Quick Checklist

Before declaring a merge done:

- [ ] Zero conflict markers repo-wide (`rg '^(<<<<<<<|=======|>>>>>>>)'`)
- [ ] JSON files parse (`node -e "JSON.parse(...)"`) — "keep both" easily leaves a bad comma
- [ ] Test manifests in `package.json` list only files that exist, and include both sides' tests
- [ ] Positional binds and parameter orders hand-verified
- [ ] **Dropped-feature data audit**: for every feature removed in this merge, was it writing a
      transformed value to the DB? If yes, is there a decrypt/decode step before the migration
      that consumes it? (Step 5 — no test will catch this)
- [ ] Typecheck + full test suite + lint, compared against pre-merge baseline counts
- [ ] Both-direction feature audit done
- [ ] Squash/rebase was lossless (`git diff` the pre-squash tree against the result)
