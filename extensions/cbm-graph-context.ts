/**
 * cbm-graph-context.ts — codebase-memory-mcp context hooks for pi.
 *
 * Replicates the 4 lifecycle hooks that codebase-memory-mcp installs for
 * Claude Code, adapted to pi's Extensions API:
 *
 *   Claude Code hook              →  pi event
 *   ─────────────────────────────    ──────────────────────────────
 *   SessionStart  (reminder)      →  before_agent_start  (append to system prompt)
 *   SubagentStart (reminder)      →  before_agent_start  (fires per subagent run too)
 *   PreToolUse  Grep/Glob augment →  tool_result  grep/find (enrich with graph symbols)
 *   PostToolUse Read coverage     →  tool_result  read     (flag unindexed code files)
 *
 * Why tool_result and not tool_call for the augmenters: pi's tool_call can
 * block or mutate input but cannot attach "additionalContext" beside a tool
 * call the way Claude's PreToolUse does. Enriching tool_result is the
 * pi-idiomatic equivalent — the LLM sees the graph context attached to the
 * grep/find/read result. Non-blocking and fail-open, exactly like CBM's hooks.
 *
 * All graph lookups shell out to the CBM CLI (`codebase-memory-mcp cli …`),
 * which is a one-shot local command that never starts/connects to the
 * coordination daemon. Every call is bounded by a timeout and any failure
 * is silent (the original tool result passes through unchanged).
 *
 * Env knobs (for review/safety):
 *   CBM_BIN           optional explicit path to the codebase-memory-mcp binary
 *                      (default: auto-resolve `codebase-memory-mcp` from $PATH)
 *   CBM_HOOKS_DISABLE "1" / "true" to disable all enrichment
 *   CBM_HOOKS_DEBUG   "1" / "true" to log actions to stderr
 */

import type {
	ExtensionAPI,
	FindToolInput,
	GrepToolInput,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { delimiter, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { access, constants as fsConstants } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const DEFAULT_CBM_BIN = "/Users/mbam1/.local/bin/codebase-memory-mcp";
const DISABLED = /^(1|true)$/i.test(process.env.CBM_HOOKS_DISABLE ?? "");
const DEBUG = /^(1|true)$/i.test(process.env.CBM_HOOKS_DEBUG ?? "");
const CLI_TIMEOUT_MS = 5000;
const MAX_BUFFER = 4 * 1024 * 1024;
const PROJECT_CACHE_TTL_MS = 10 * 60 * 1000;

// Resolve the CBM binary once: explicit CBM_BIN env > $PATH lookup > hardcoded
// fallback. Resolving via $PATH makes the package portable across machines
// without forcing users to set CBM_BIN.
async function resolveBin(): Promise<string> {
	const envBin = process.env.CBM_BIN;
	if (envBin) return envBin;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = resolve(dir, "codebase-memory-mcp");
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// not in this dir
		}
	}
	return DEFAULT_CBM_BIN;
}

let binPromise: Promise<string> | null = null;
function bin(): Promise<string> {
	return (binPromise ??= resolveBin());
}

// Extensions worth a coverage check on `read`. Non-code files are skipped.
const CODE_EXT = new Set([
	".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
	".rb", ".php", ".cs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
	".m", ".mm", ".swift", ".clj", ".cljs", ".cljc", ".ex", ".exs",
	".erl", ".hs", ".ml", ".fs", ".fsx", ".vb", ".dart", ".lua",
	".pl", ".pm", ".r", ".jl", ".vue", ".svelte", ".astro",
]);

type ProjectInfo = { name: string; root_path: string };

interface ProjectCache {
	projects: ProjectInfo[];
	at: number;
}

let cache: ProjectCache | null = null;

function debug(msg: string): void {
	if (DEBUG) process.stderr.write(`[cbm-graph-context] ${msg}\n`);
}

function textBlock(text: string) {
	return { type: "text" as const, text };
}

async function listProjects(): Promise<ProjectInfo[]> {
	if (cache && Date.now() - cache.at < PROJECT_CACHE_TTL_MS) return cache.projects;
	try {
		const { stdout } = await execFileAsync(await bin(), ["cli", "list_projects", "{}"], {
			timeout: CLI_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
		});
		const parsed = JSON.parse(stdout) as { projects?: Array<{ name: string; root_path: string }> };
		const projects = (parsed.projects ?? []).map((p) => ({ name: p.name, root_path: p.root_path }));
		cache = { projects, at: Date.now() };
		debug(`listed ${projects.length} project(s)`);
		return projects;
	} catch (err) {
		debug(`list_projects failed: ${(err as Error).message}`);
		cache = { projects: [], at: Date.now() };
		return cache.projects;
	}
}

function findProject(projects: ProjectInfo[], absPath: string): ProjectInfo | null {
	let best: ProjectInfo | null = null;
	for (const p of projects) {
		const root = p.root_path.endsWith(sep) ? p.root_path : p.root_path + sep;
		if (absPath === p.root_path || absPath.startsWith(root)) {
			if (!best || p.root_path.length > best.root_path.length) best = p;
		}
	}
	return best;
}

async function runCli(tool: string, args: Record<string, unknown>): Promise<any | null> {
	try {
		const { stdout } = await execFileAsync(await bin(), ["cli", tool, JSON.stringify(args)], {
			timeout: CLI_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
		});
		return JSON.parse(stdout);
	} catch (err) {
		debug(`cli ${tool} failed: ${(err as Error).message}`);
		return null;
	}
}

function escRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function longestToken(s: string): string {
	const tokens = s
		.replace(/\*\*\/|\*|\?|\{[^}]*\}|\[[^\]]*\]|\./g, " ")
		.split(/[\/\s]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3);
	tokens.sort((a, b) => b.length - a.length);
	return tokens[0] ?? "";
}

function getExt(p: string): string {
	const i = p.lastIndexOf(".");
	return i >= 0 ? p.slice(i).toLowerCase() : "";
}

// ── grep result enrichment ────────────────────────────────────────────────
async function augmentGrep(input: GrepToolInput, cwd: string): Promise<string | null> {
	if (!input.pattern) return null;
	const searchRoot = resolve(cwd, input.path ?? cwd);
	const projects = await listProjects();
	const project = findProject(projects, searchRoot);
	if (!project) return null;

	const res = await runCli("search_code", {
		pattern: input.pattern,
		project: project.name,
		limit: 8,
	});
	const results = res?.results;
	if (!Array.isArray(results) || results.length === 0) return null;

	const lines = results.slice(0, 8).map((r: any) => {
		const loc = r.file ? `${r.file}:${r.start_line ?? "?"}` : "?";
		return `- ${r.node} (${r.label ?? "?"}) — ${loc} [in:${r.in_degree ?? 0} out:${r.out_degree ?? 0}]`;
	});
	return [
		`[codebase-memory] Graph symbols matching /${input.pattern}/ (${res.total_results ?? results.length} total, showing ${lines.length}):`,
		...lines,
		"Use search_graph / trace_path / get_code_snippet for structural detail.",
	].join("\n");
}

// ── find result enrichment ────────────────────────────────────────────────
async function augmentFind(input: FindToolInput, cwd: string): Promise<string | null> {
	if (!input.pattern) return null;
	const searchRoot = resolve(cwd, input.path ?? cwd);
	const projects = await listProjects();
	const project = findProject(projects, searchRoot);
	if (!project) return null;

	const token = longestToken(input.pattern);
	if (!token) return null;

	const res = await runCli("search_graph", {
		name_pattern: `.*${escRegex(token)}.*`,
		label: "File",
		project: project.name,
		limit: 10,
	});
	const results = res?.results;
	if (!Array.isArray(results) || results.length === 0) return null;

	const lines = results.slice(0, 10).map((r: any) => `- ${r.name} — ${r.file_path ?? "?"}`);
	return [
		`[codebase-memory] Indexed files matching "${input.pattern}" (${res.total ?? results.length}):`,
		...lines,
	].join("\n");
}

// ── read coverage enrichment ──────────────────────────────────────────────
async function augmentRead(input: ReadToolInput, cwd: string): Promise<string | null> {
	if (!input.path) return null;
	const absPath = resolve(cwd, input.path);
	const ext = getExt(absPath);
	if (!CODE_EXT.has(ext)) return null; // only flag code files

	const projects = await listProjects();
	const project = findProject(projects, absPath);
	if (!project) return null; // not in any indexed project — stay quiet

	const relPath = relative(project.root_path, absPath);
	if (relPath.startsWith("..")) return null;

	const res = await runCli("search_graph", {
		file_pattern: relPath,
		project: project.name,
		limit: 1,
	});
	const total = res?.total ?? 0;
	if (total > 0) return null; // file is represented in the graph

	return (
		`[codebase-memory] Coverage gap: ${relPath} has no graph nodes ` +
		`(unindexed or skipped by tree-sitter). Structural queries on this file ` +
		`will miss it — re-run index_repository if it should be tracked.`
	);
}

// Dispatch enrichment by tool name. Kept as a standalone function (not
// contextually typed by the pi.on overload) so the Record<string, unknown> casts
// stay isolated — ToolResultEvent's toolName discriminant collapses to
// `string` because CustomToolResultEvent.toolName is `string`, so narrowing
// inside the handler body would not reduce the union.
async function augment(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<string | null> {
	if (toolName === "grep") return augmentGrep(input as GrepToolInput, cwd);
	if (toolName === "find") return augmentFind(input as FindToolInput, cwd);
	if (toolName === "read") return augmentRead(input as ReadToolInput, cwd);
	return null;
}

export default function (pi: ExtensionAPI): void {
	if (DISABLED) {
		debug("disabled by CBM_HOOKS_DISABLE");
		return;
	}

	// SessionStart + SubagentStart reminder: make the LLM see CBM guidance.
	// Fires per agent run (including subagent runs), gated to indexed projects.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const projects = await listProjects();
			const project = findProject(projects, ctx.cwd);
			if (!project) return;
			const reminder =
				`\n\n# Codebase Knowledge Graph (codebase-memory-mcp)\n` +
				`Project "${project.name}" is indexed. For code discovery prefer the ` +
				`codebase-memory-mcp MCP tools (search_graph, trace_path, ` +
				`get_code_snippet, query_graph, get_architecture) over grep/glob. ` +
				`Fall back to grep/glob only for string literals, configs, or non-code files.`;
			return { systemPrompt: event.systemPrompt + reminder };
		} catch (err) {
			debug(`before_agent_start failed: ${(err as Error).message}`);
		}
	});

	// PreToolUse Grep/Glob augment + PostToolUse Read coverage, rolled into
	// tool_result enrichment (the pi-idiomatic, non-blocking equivalent).
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		try {
			const extra = await augment(event.toolName, event.input, ctx.cwd);
			if (!extra) return;
			return { content: [textBlock(extra), ...event.content] };
		} catch (err) {
			debug(`tool_result failed: ${(err as Error).message}`);
		}
	});
}