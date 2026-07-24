# pi-codebase-memory-hooks

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) lifecycle hooks for the [pi coding agent](https://pi.dev) — a faithful port of the hooks CBM installs for Claude Code, adapted to pi's Extensions API.

It bundles three things:

1. **Extension** (`extensions/cbm-graph-context.ts`) — replicates the four CBM lifecycle hooks:
   - `SessionStart` / `SubagentStart` reminder → pi `before_agent_start` (appends CBM guidance to the system prompt, gated to indexed projects)
   - `PreToolUse` Grep/Glob augment → pi `tool_result` for `grep`/`find` (enriches results with matching graph symbols)
   - `PostToolUse` Read coverage → pi `tool_result` for `read` (flags code files that have no graph nodes)
2. **Skill** (`skills/codebase-memory/SKILL.md`) — the canonical CBM knowledge-graph tool guide (same content CBM installs for Claude Code).
3. **`AGENTS.md`** — the CBM managed-context block, shipped as a template for users who want the static guidance without the extension.

> **Design note:** pi's `tool_call` can block or mutate tool input but cannot attach `additionalContext` beside a tool call the way Claude's `PreToolUse` does. Enriching `tool_result` is the pi-idiomatic equivalent — the LLM still sees the graph context attached to grep/find/read results. Non-blocking and fail-open, exactly like CBM's own hooks.

## Prerequisites

- The [`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) binary on `$PATH` (or pointed to by `CBM_BIN`). Install it first:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash
  ```
- The MCP server configured for pi (the installer writes `~/.pi/agent/mcp.json` automatically; if not, add it manually).
- At least one project indexed by CBM. Hooks only enrich when the working directory is inside an indexed project — otherwise they stay quiet.

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
| `CBM_BIN` | _(unset)_ | Path to the `codebase-memory-mcp` binary. If unset, the extension auto-resolves `codebase-memory-mcp` from `$PATH`; falls back to a hardcoded default only if not on `$PATH`. Set this only to override. |
| `CBM_HOOKS_DISABLE` | unset | `1` or `true` disables all enrichment. |
| `CBM_HOOKS_DEBUG` | unset | `1` or `true` logs actions to stderr. |

> The extension auto-resolves `codebase-memory-mcp` from `$PATH` at runtime, so it works on any machine where CBM is installed — no `CBM_BIN` needed unless you want to override.

## Optional: install the AGENTS.md managed block

The bundled `AGENTS.md` contains the same `<!-- codebase-memory-mcp:start -->…:end -->` block CBM writes for other agents. It's optional — the extension's `before_agent_start` hook already injects equivalent guidance at runtime. To use the static block instead (or in addition), append its contents to `~/.pi/agent/AGENTS.md`:

```bash
cat AGENTS.md >> ~/.pi/agent/AGENTS.md
```

## License

MIT — same license as codebase-memory-mcp.