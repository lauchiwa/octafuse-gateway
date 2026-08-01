# Playground: support the Responses protocol

## Goal

Admin debug console cannot exercise models routed to /v1/responses: playground-service maps OpenAI protocol to 'chat' or 'images.*' only (playground-service.ts:398). Add a 'responses' capability path so provider+model configs using the new endpoint are testable from the admin UI.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
