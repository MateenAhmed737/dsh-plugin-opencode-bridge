# Changelog

## 0.1.1 (2026-11-03)

- First release published from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.1.0 (2026-11-02)

First version.

- Registers the "OpenCode (local)" LLM provider in DeepSeek Harness.
- Starts one shared `opencode serve` from your own install on 127.0.0.1 with your full environment and a random password per start, or attaches to a server you already run (`serverUrl` + `serverPassword`).
- Works with OpenCode 1.x (from 1.14.19) and 2.x.
- One OpenCode session per DSH conversation; only the new turn is sent, and the session is rebuilt from the DSH transcript when the history changed.
- T3 Code's permission policy, with restricted tools asked through DSH's approval prompt or rejected with a message the model sees. Nothing is configured as `deny`.
- Streams text, reasoning, tool activity and token usage; supports abort and png/jpeg/gif/webp images up to 20 MB.
- A watchdog stops the OpenCode server if DSH is killed without cleaning up, and on Windows the real `opencode.exe` behind npm's `.cmd` shim is run directly.
- Maps OpenCode errors to DSH failures: 429 / FreeUsageLimitError → rate limit with OpenCode's message, 401/403 → auth, network and timeouts → transport.
