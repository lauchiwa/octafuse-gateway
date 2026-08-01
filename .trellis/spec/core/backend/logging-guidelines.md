# Logging Guidelines — `@octafuse/core`

> `core` stays quiet. Logging is the runtime's responsibility; core avoids `console.*` except for unavoidable startup diagnostics.

---

## Principles

- **Library code does not log business events.** It returns/throws; the caller (proxy/admin) logs with request context.
- **Startup diagnostics** (Node runtime banner, driver selection) may log, but must **redact secrets** — connection strings pass through `redactDatabaseConnectionUrl()` which masks the password before printing.
- No structured-logger dependency in `core`; when the Workers/Node runtimes need logs they use Hono's `logger()` middleware and plain `console.*`.

---

## What NOT to Log

- Full connection strings, `DATABASE_URL` with credentials — always redact.
- Raw API keys / `MASTER_KEY`. If a key must appear in a log for correlation, mask it (`maskKey()` in proxy auth keeps first 8 + last 4).
- Prompt/message bodies and inline multimodal `data` — request-log redaction (`openAiBodyRedactedForLog`) drops `messages`/`input`/`prompt`/`data` before persisting.

---

## Common Mistakes

- Adding `console.log` inside a hot repository path.
- Printing an un-redacted connection string in a migration or startup helper.
