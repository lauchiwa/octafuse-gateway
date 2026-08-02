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
