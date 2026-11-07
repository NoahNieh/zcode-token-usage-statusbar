# ZCode Token Usage Status Bar (Personal Fork)

> Forked from [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) (upstream: [xhwxt/zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar)) — all credit to the original authors.
> Personal fork for self-maintenance. This README was revised to describe actual behavior: honest network-access and risk notes, promotional content removed. For feature issues, prefer reporting upstream.

Adds a status bar to the bottom of your [ZCode](https://zcode.z.ai) desktop chat window: generation speed, token spend, context usage, tool calls and subagents at a glance. Also ships a CLI (`zusage.py`), a `/usage` command and an MCP tool (`token_usage`) for querying usage history.

English · [简体中文](README.md)

Windows / macOS (macOS lightly tested) · Python 3.8+ (zero third-party dependencies) · [MIT](LICENSE)

---

## How it works (read before installing)

This is not an official plugin — it is an **injection-based add-on**:

- Installing **modifies ZCode's `app.asar` program file** (one loader line appended to the entry, full repack);
- The injected code runs in the **Electron main process** with the same privileges as any local app;
- Usage data comes from the local `~/.zcode/cli/db/db.sqlite` (read-only). ZCode updates overwrite `app.asar` and the bar stops working until reinstalled (automatic via the plugin route, manual re-run via the installer route).

Install only if you understand and accept the above. Not recommended on managed/corporate machines or wherever client integrity matters.

## What the bar looks like

```text
⚡ 86 t/s │ 62.5k 90% 7req Σ18.4s ⏱1.4s │ 1.45M 86% 23turns 187req │ 142 🔴2 │ 3.42M │ 236k 🟢 │ ⚙
   Speed        This turn                    Session total          Tools     Today   Subagents  Settings
```

- **Speed**: t/s; a character-based estimate while generating, switching to measured stats after the request completes
- **This turn**: tokens, cache-hit rate, request count, total duration, TTFT; hover for input/output/cache/thinking breakdown and estimated cost
- **Session total / Today**: this conversation / all conversations today (hover for details)
- **Tools**: call count, red badge on errors, hover for per-tool durations and errors
- **Subagents**: token spend of model-dispatched subtasks — includes dynamic-workflow spawned agents (marked "workflow" in the detail panel, with a workflow subtotal in the summary); 🟢 while one is running, click for per-agent detail
- **⚙**: display toggles, language, context-window override, update checks

Context usage lives on the **context button** in the composer toolbar (ring icon + percentage): it changes colour as it fills, pops suggestions when a request is rejected for overflow, and offers one-click compaction.

## Installation

Requires: the ZCode desktop app, Python 3.8+ (stdlib `sqlite3`). No Node.js.

**Option 1: one-line installer (simplest)**

```bash
git clone https://github.com/NoahNieh/zcode-token-usage-statusbar.git
cd zcode-token-usage-statusbar
python install.py          # macOS: python3; --lang en for English
```

After a ZCode update overwrites `app.asar`, re-run `python install.py` (near-instant when the injected line is unchanged).

**Option 2: plugin from a local directory (no terminal; syncs runtime and auto-repairs injection on session start)**

In ZCode: **Settings → Plugins → Add marketplace → Choose directory**, point it at this repository root, then install and enable **ZCode Token Usage Statusbar**.

> The remote marketplace URL (`https://github.com/…#plugin-releases`) depends on a `plugin-releases` branch and Releases, which this fork does not push — do not use the original repo's URL to install this fork's development version.

**After installing:** confirm success → **quit ZCode completely and reopen** (closing the window doesn't count) → check the bar appears. If you only want `/usage` and MCP queries without touching the client, install the plugin and run `/uninstall-overlay` to write the opt-out marker.

## Network access (honest version)

**Never touches the network**: usage stats, the bar, CLI, MCP, the Git chip — local SQLite and local git only, nothing uploaded.

**On by default** (all of it can be turned off):

| Feature | Default | What it contacts | How to disable |
|---|---|---|---|
| Plan-quota / reset-card queries | on | decrypts host credentials; requests go to **the matching providers' official domains** (BigModel/Z.ai, Anthropic, DeepSeek, Kimi, OpenRouter, …) | toggle quota off in ⚙, or `quota_enabled: false` |
| Cost-estimate pricing & FX | on | fetches models.dev pricing + an FX rate every 12 h (download only) | `pricing.fetch: false` |
| Plugin auto-update | on | downloads code from the release channel (executed in the main process) | off in ⚙, or `plugin_auto_update: false` |
| Remote sessions (SSH/WSL/Docker) | opt-in | runs the query script on the remote host via your configured channel | don't configure any |

To go fully offline, in `~/.zcode/zcode-token-usage-statusbar/config.json`:

```json
{ "quota_enabled": false, "pricing": { "fetch": false }, "plugin_auto_update": false }
```

> ⚠️ Auto-update is a remote-code channel: whatever it downloads runs in the main process. Using this fork means trusting this fork's release chain.

## Credential boundaries

- SSH passwords and private-key passphrases stored in ZCode are **never decrypted or reused**; remote queries only use channels you explicitly configure.
- Quota credentials are used in memory only and never logged; credentials manually saved in ⚙ go to `quota-secrets.json` in the runtime directory (0600).
- The Anthropic source requires explicit opt-in and may then read `~/.claude/.credentials.json`.

## Data semantics (short version)

- One `model_usage` row = one model request; `input` already includes cache-read, `output` already includes reasoning, total = input + output.
- Token usage ≠ a bill; "estimated cost" is list-price estimation — unmatched models fall back to a default average and can be far off.
- Each window shows only its own focused session; subagent usage is merged via `parent_id` and never double-counted; workflow-spawned agents (`query_source='workflow_child'`) are counted into the subagent dimension alongside Task agents.
- Full formulas and pitfalls: [docs/design-notes.md](docs/design-notes.md), [docs/user-guide.md](docs/user-guide.md) (Chinese).

## Risk notes

1. **Unofficial injection**: it modifies the client's program files and may violate ZCode's terms; AV/EDR may flag the asar rewrite.
2. **Main-process privileges + auto-update**: injected code has full local privileges and auto-update installs new code hourly by default — a supply-chain trust decision; disable it if in doubt.
3. **Update fragility**: client updates overwrite the injection; engine patches are version-allow-listed and fail closed on unknown versions rather than corrupting them.
4. **macOS**: modifying app.asar invalidates the code signature and may trip Gatekeeper; upstream hasn't tested macOS either.

## Uninstall

- **Installer route**: run `python install.py --remove` in the repository, then fully quit and reopen ZCode. Removal strips only this tool's own injected line.
- **Plugin route**: turn off auto-update in ⚙ → `/uninstall-overlay` → Settings → Plugins → Uninstall → fully quit and reopen. Don't just delete the plugin and leave the injection behind.

## More documentation

- [Installation, configuration and troubleshooting](docs/user-guide.md) (Chinese) · [Feature screenshots](docs/features.md) (Chinese) · [Quota support matrix](docs/quota-support-audit.md) (Chinese)
- [Architecture and data semantics](docs/design-notes.md) (Chinese) · [Web edition (self-hosted)](web/README.md) · [Development and releases](docs/maintaining.md) (Chinese) · [Tests](tests/README.md)

[MIT License](LICENSE)
