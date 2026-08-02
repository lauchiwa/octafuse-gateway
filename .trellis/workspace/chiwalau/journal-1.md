# Journal - chiwalau (Part 1)

> AI development session journal
> Started: 2026-07-24

---



## Session 1: Provider 自定义上游 header（provider × protocol）

**Date**: 2026-07-25
**Task**: Provider 自定义上游 header（provider × protocol）
**Branch**: `main`

### Summary

新增 providers.custom_headers(JSON) 列，按 provider × 协议注入上游 fetch header（主要 User-Agent）。合并语义 { ...custom, ...base } 保证驱动内置鉴权/协议 header 永远覆盖 custom，外加校验器 denylist 双保险。贯穿三驱动 DB 层（三份同号迁移 0014 + schema + impl）、proxy 四驱动 egress、admin provider 弹窗（四语言）。core 95 测试 / proxy 34 / admin 58 全过，lint+typecheck 通过。AC8（Workers 出站 UA 是否被 runtime 覆盖）待部署后 wrangler tail 实测。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c2d6592` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Merge upstream v2.0.0 — merge to main & finish

**Date**: 2026-08-02
**Task**: Merge upstream v2.0.0 — merge to main & finish
**Branch**: `main`

### Summary

Merged merge-upstream-v2 into main (reset + force-push to github & gitee). Verified 515 tests green, typecheck x3, build, lint 0 err. Archived 08-01-merge-upstream-v2. End-to-end audio/route-strategy testing still pending (needs real API keys); Postgres/MySQL migrations statically reviewed only.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `766c1c8` | (see git log) |
| `8c72785` | (see git log) |
| `0528d64` | (see git log) |
| `39ed55e` | (see git log) |
| `328156f` | (see git log) |
| `aceb5bf` | (see git log) |
| `84d8ae0` | (see git log) |
| `42d614c` | (see git log) |
| `3424559` | (see git log) |
| `f42eef2` | (see git log) |
| `56ab191` | (see git log) |
| `89df1e1` | (see git log) |
| `4a6e64a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
