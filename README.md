# pi-codebase-memory-hooks

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) lifecycle hooks for the [pi coding agent](https://pi.dev) — a faithful port of the hooks CBM installs for Claude Code, adapted to pi's Extensions API.

It bundles four things:

1. **Lifecycle hooks** (`extensions/cbm-graph-context.ts`) — replicates the four CBM lifecycle hooks:
   - `SessionStart` / `SubagentStart` reminder → pi `before_agent_start` (appends CBM guidance to the system prompt, gated to indexed projects)
   - `PreToolUse` Grep/Glob augment → pi `tool_result` for `grep`/`find` (enriches results with matching graph symbols)
   - `PostToolUse` Read coverage → pi `tool_result` for `read` (flags code files that have no graph nodes)
2. **One-command bootstrap** (`extensions/cbm-bootstrap.ts`) — the `/cbm-install` and `/cbm-status` commands that install the latest CBM binary from the official repo, register the MCP server in `~/.pi/agent/mcp.json` (idempotent merge), and optionally index the current project. See [Quick start](#quick-start).
3. **Skill** (`skills/codebase-memory/SKILL.md`) — the canonical CBM knowledge-graph tool guide (same content CBM installs for Claude Code).
4. **`AGENTS.md`** — the CBM managed-context block, shipped as a template for users who want the static guidance without the extension.

> **Design note:** pi's `tool_call` can block or mutate tool input but cannot attach `additionalContext` beside a tool call the way Claude's `PreToolUse` does. Enriching `tool_result` is the pi-idiomatic equivalent — the LLM still sees the graph context attached to grep/find/read results. Non-blocking and fail-open, exactly like CBM's own hooks.

## Quick start

The package cannot bundle CBM's 200 MB binary, but it makes the whole setup one explicit command. After installing the package and reloading pi:

```bash
/cbm-install
```

This downloads the **latest official** `codebase-memory-mcp` (checksum-verified by the repo's own `install.sh`), installs it, registers the MCP server in `~/.pi/agent/mcp.json` (merging — it never clobbers existing servers), and asks whether to index the current project. Then **restart pi or run `/reload`** so the MCP graph tools load into the session.

Check readiness any time with:

```bash
/cbm-status
```

> Nothing runs automatically on package load — install, config writes, and indexing happen only when you invoke the commands (install is also gated by a confirmation dialog).

## Prerequisites

- **Either** install the CBM binary manually **or** use `/cbm-install` (recommended):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
  ```
- The MCP server configured for pi (`/cbm-install` does this for you; the manual installer writes `~/.pi/agent/mcp.json` too — if not, add it manually).
- At least one project indexed by CBM. Hooks only enrich when the working directory is inside an indexed project — otherwise they stay quiet.

The hooks and `/cbm-status` find the binary via `CBM_BIN` → `$PATH` → `~/.local/bin` (the official installer's default target), so no shell-PATH editing is required.

## Install

### From git (recommended until npm publish)

```bash
pi install git:github.com/ramaaudra/pi-codebase-memory-hooks
```

Pin a tag/commit with:

```bash
pi install git:github.com/ramaaudra/pi-codebase-memory-hooks@v0.1.0
```

### From npm

```bash
pi install npm:pi-codebase-memory-hooks
# or pinned
pi install npm:pi-codebase-memory-hooks@0.1.0
```

### Try without installing

```bash
pi -e git:github.com/ramaaudra/pi-codebase-memory-hooks
```

### From a local clone

```bash
pi install ./relative/path/to/pi-codebase-memory-hooks
# or absolute
pi install /Users/you/LocalDocument/Project/pi-codebase-memory-hooks
```

After installing, **restart pi** or run `/reload` so the extension loads.

## Uninstall

```bash
pi remove npm:pi-codebase-memory-hooks
# or
pi remove git:github.com/ramaaudra/pi-codebase-memory-hooks
```

List what's installed:

```bash
pi list
```

## What the hooks do

| Claude Code hook | pi event | Behavior |
|---|---|---|
| `SessionStart` reminder | `before_agent_start` | When `ctx.cwd` is inside an indexed CBM project, appends a short "prefer graph tools" line to the system prompt. Fires for subagent runs too. |
| `SubagentStart` reminder | `before_agent_start` | Same handler — pi fires it per agent run. |
| `PreToolUse` Grep/Glob | `tool_result` (`grep`/`find`) | Shells out to `codebase-memory-mcp cli search_code` / `search_graph` and prepends matching graph symbols to the tool result. Non-blocking, fail-open. |
| `PostToolUse` Read coverage | `tool_result` (`read`) | For code files with a code extension, checks the graph for nodes on that file. If none, appends a coverage-gap note. Skips non-code files. |

All graph lookups use the CBM CLI one-shot mode (`codebase-memory-mcp cli …`), which never starts or connects to the coordination daemon — safe to run alongside the MCP server. Every call is bounded by a 5-second timeout; any failure is silent and the original tool result passes through unchanged.

## Configuration (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `CBM_BIN` | _(unset)_ | Path to the `codebase-memory-mcp` binary. If unset, the hooks and `/cbm-status` auto-resolve from `$PATH` → `~/.local/bin`. If the binary is found nowhere, they stay quiet (no-op). Set `CBM_BIN` only to override. |
| `CBM_INSTALL_DIR` | `~/.local/bin` | Directory `/cbm-install` installs the binary into (same default as the official `install.sh`). |
| `CBM_HOOKS_DISABLE` | unset | `1` or `true` disables all enrichment and the bootstrap commands. |
| `CBM_HOOKS_DEBUG` | unset | `1` or `true` logs actions to stderr. |

## Bootstrap commands

| Command | Behavior |
|---|---|
| `/cbm-install` | Download the latest official `codebase-memory-mcp`, install to `CBM_INSTALL_DIR`, register the MCP server in `~/.pi/agent/mcp.json` (idempotent merge), verify `--version`, and optionally index the current project. Confirmation-gated. |
| `/cbm-status` | Read-only readiness report: binary present + version, MCP registered in pi's `mcp.json`, and whether the current project is indexed. |

## Optional: install the AGENTS.md managed block

The bundled `AGENTS.md` contains the same `<!-- codebase-memory-mcp:start -->…:end -->` block CBM writes for other agents. It's optional — the extension's `before_agent_start` hook already injects equivalent guidance at runtime. To use the static block instead (or in addition), append its contents to `~/.pi/agent/AGENTS.md`:

```bash
cat AGENTS.md >> ~/.pi/agent/AGENTS.md
```

## License

MIT — same license as codebase-memory-mcp.