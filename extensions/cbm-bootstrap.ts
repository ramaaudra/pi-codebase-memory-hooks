/**
 * cbm-bootstrap.ts — one-command install/bootstrap for codebase-memory-mcp.
 *
 * Turns the manual setup (install binary → register MCP server → index project
 * → restart pi) into explicit, idempotent commands:
 *
 *   /cbm-install   install the latest CBM from the official repo, wire pi's
 *                  mcp.json, verify, and optionally index the current project.
 *   /cbm-status    report whether the binary, the MCP registration, and the
 *                  current project index are present.
 *
 * Design notes
 * ------------
 * * Explicit, never silent. Nothing runs on package load — the binary is
 *   200+ MB and we mutate `~/.pi/agent/mcp.json`, so everything happens only
 *   when the user invokes the command and confirms.
 * * Reuses the official installer. We download the repo's `install.sh` over
 *   HTTPS with `fetch` (never `curl|bash`) and run it via `bash script`.
 *   It performs checksum verification, extraction, macOS re-signing, the
 *   transactional "live" swap, and agent auto-config. We then idempotently
 *   ensure the pi MCP entry exists and merge — never clobbering other servers.
 * * Idempotent. Re-running /cbm-install updates to the latest and merges
 *   config rather than duplicating entries.
 *
 * Env knobs:
 *   CBM_INSTALL_DIR   install directory (default: ~/.local/bin)
 *   CBM_HOOKS_DEBUG   "1" / "true" to log actions to stderr
 *   CBM_HOOKS_DISABLE "1" / "true" to disable the commands
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO = "DeusData/codebase-memory-mcp";
const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const DISABLED = /^(1|true)$/i.test(process.env.CBM_HOOKS_DISABLE ?? "");
const DEBUG = /^(1|true)$/i.test(process.env.CBM_HOOKS_DEBUG ?? "");
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

function debug(msg: string): void {
	if (DEBUG) process.stderr.write(`[cbm-bootstrap] ${msg}\n`);
}

function installDir(): string {
	return process.env.CBM_INSTALL_DIR ?? join(homedir(), ".local", "bin");
}
function binPath(): string {
	return join(installDir(), "codebase-memory-mcp");
}
function mcpJsonPath(): string {
	return join(homedir(), ".pi", "agent", "mcp.json");
}

// Resolve an installed CBM binary: explicit CBM_BIN > $PATH > managed dir.
// PATH is split on the OS delimiter to support Windows separators too.
async function resolveBinary(): Promise<string | null> {
	const envBin = process.env.CBM_BIN;
	if (envBin) return envBin;
	const dirs = (process.env.PATH ?? "").split(delimiter);
	dirs.push(installDir());
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		const candidate = join(dir, "codebase-memory-mcp");
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// not in this dir
		}
	}
	return null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
	if ("timeout" in AbortSignal) {
		return fetch(url, { redirect: "follow", signal: AbortSignal.timeout(ms) });
	}
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
	t.unref?.();
	try {
		return await fetch(url, { redirect: "follow", signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

// Download the official installer to a fresh temp dir and return its path.
async function downloadInstaller(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cbm-install-"));
	const script = join(dir, "install.sh");
	debug(`downloading installer: ${INSTALL_SH_URL}`);
	const res = await fetchWithTimeout(INSTALL_SH_URL, DOWNLOAD_TIMEOUT_MS);
	if (!res.ok) {
		await rm(dir, { recursive: true, force: true });
		throw new Error(`could not fetch official installer (HTTP ${res.status})`);
	}
	const text = await res.text();
	if (!text.includes("codebase-memory-mcp") || !text.includes("checksums.txt")) {
		await rm(dir, { recursive: true, force: true });
		throw new Error("downloaded installer failed sanity check (not a CBM installer?)");
	}
	await writeFile(script, text, { mode: 0o755 });
	return script;
}

// Stream the installer so the user sees progress, resolve on exit.
async function runInstallerScript(script: string, dir: string): Promise<void> {
	const args = ["--dir", dir];
	debug(`running bash ${script} ${args.join(" ")}`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("bash", [script, ...args], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`installer exited with code ${code ?? "unknown"}`));
		});
	});
}

// Idempotent merge of the pi MCP entry, preserving any existing servers.
async function ensureMcpRegistration(): Promise<{ changed: boolean; path: string; command: string }> {
	const path = mcpJsonPath();
	const command = binPath();
	let data: { mcpServers?: Record<string, unknown> } = {};
	try {
		data = JSON.parse(await readFile(path, "utf8"));
	} catch {
		// missing/invalid — start fresh
	}
	const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
	const changed = !("codebase-memory-mcp" in servers);
	if (changed) {
		servers["codebase-memory-mcp"] = { command, directTools: true };
		data.mcpServers = servers;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(data, null, 2) + "\n");
	}
	return { changed, path, command };
}

async function tryVersion(bin: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(bin, ["--version"], {
			timeout: 10_000,
			maxBuffer: MAX_OUTPUT,
		});
		const v = stdout.trim().split("\n")[0] ?? "";
		return v || null;
	} catch {
		return null;
	}
}

// Latest released version from the official repo (tag_name like "v0.9.0").
// Returns null when the lookup fails (offline, rate limit, …) so callers can
// fall back to a conservative "unknown latest" decision instead of guessing.
async function fetchLatestVersion(): Promise<string | null> {
	const url = `https://api.github.com/repos/${REPO}/releases/latest`;
	const res = await fetchWithTimeout(url, 15_000);
	if (!res.ok) return null;
	const data = (await res.json()) as { tag_name?: string };
	const tag = data.tag_name;
	return tag ? tag.replace(/^v/i, "") : null;
}

// Numeric 3-segment compare with fallback for unparseable strings.
// Returns <0 if a<b, 0 if equal, >0 if a>b.
function compareVersions(a: string, b: string): number {
	const toNums = (s: string): number[] => {
		const m = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s.trim());
		return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [];
	};
	const pa = toNums(a);
	const pb = toNums(b);
	if (pa.length === 0 || pb.length === 0) return a < b ? -1 : a > b ? 1 : 0;
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
	}
	return 0;
}

// Whether pi's mcp.json already registers the CBM MCP server.
async function mcpRegistered(): Promise<boolean> {
	try {
		const data = JSON.parse(await readFile(mcpJsonPath(), "utf8")) as {
			mcpServers?: Record<string, unknown>;
		};
		return Boolean(data.mcpServers?.["codebase-memory-mcp"]);
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI): void {
	if (DISABLED) {
		debug("disabled by CBM_HOOKS_DISABLE");
		return;
	}

	// ── /cbm-install ─────────────────────────────────────────────────────────
	pi.registerCommand("cbm-install", {
		description:
			"Install or update codebase-memory-mcp (latest from the official repo), configure pi's MCP server, and optionally index the current project. Skips the download when already up to date; use --force to update anyway.",
		handler: async (args, ctx) => {
			const flags = (args ?? "").trim();
			const wantIndex = !/\b--no-index\b/.test(flags);
			const force = /\b--force\b|\b-f\b/.test(flags);
			const dir = installDir();

			ctx.ui.setStatus?.("cbm", "Checking current install…");

			const [installedVer, latestVer, registered] = await Promise.all([
				tryVersion(binPath()),
				fetchLatestVersion(),
				mcpRegistered(),
			]);
			const installed = installedVer != null;
			const upToDate = latestVer != null && compareVersions(installedVer ?? "", latestVer) >= 0;

			// Already latest + registered + not forced → skip the 200 MB download.
			if (!force && installed && registered && latestVer != null && upToDate) {
				if (wantIndex) {
					ctx.ui.setStatus?.("cbm", "Indexing current project…");
					try {
						await execFileAsync(binPath(), ["cli", "index_repository", JSON.stringify({ repo_path: ctx.cwd })], {
							timeout: 300_000,
							maxBuffer: MAX_OUTPUT,
						});
						ctx.ui.notify(`Already on latest (v${latestVer}) — index refreshed for ${ctx.cwd}`, "info");
					} catch (e) {
						ctx.ui.notify(`Already on latest (v${latestVer}); indexing failed: ${(e as Error).message}`, "error");
					}
				} else {
					ctx.ui.notify(`codebase-memory-mcp is already up to date (v${latestVer}). Nothing to do.`, "info");
				}
				ctx.ui.setStatus?.("cbm", undefined);
				return;
			}

			// Everything below means we (re)install: fresh install, or an update is
			// available and the user confirms it.
			const current = installed ? ` (you have v${installedVer.trim()})` : "";
			const target = latestVer ? ` v${latestVer}` : " the latest";
			const reason = force
				? "forced reinstall"
				: latestVer != null && installed && !upToDate
					? `new version available (v${installedVer.trim()} → v${latestVer})`
					: latestVer == null && installed
						? "latest version could not be checked — reinstall anyway"
						: "first-time install";

			const confirmMsg =
				`codebase-memory-mcp is not up to date${current}.\n` +
				`=> ${reason}\n` +
				`This will download ${target} from ${REPO} (a ~200 MB binary), install to ${dir}, and ensure pi's ${mcpJsonPath()} registers the MCP server (merge, no clobber).\n` +
				(wantIndex ? `It will also index the current project (${ctx.cwd}).\n` : ``) +
				`Continue? [y/N]`;

			if (ctx.hasUI) {
				const answer = await ctx.ui.confirm("Install / update codebase-memory-mcp", confirmMsg);
				if (!answer) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}

			ctx.ui.setStatus?.("cbm", "Downloading official installer…");
			try {
				const script = await downloadInstaller();
				ctx.ui.setStatus?.("cbm", "Running installer…");
				await runInstallerScript(script, dir);
				try {
					await rm(dirname(script), { recursive: true, force: true });
				} catch {
					/* best-effort */
				}

				ctx.ui.setStatus?.("cbm", "Ensuring pi MCP registration…");
				const reg = await ensureMcpRegistration();

				const version = await tryVersion(binPath());
				if (!version) throw new Error("installed binary did not run (see installer output above)");

				if (wantIndex) {
					ctx.ui.setStatus?.("cbm", "Indexing current project…");
					try {
						await execFileAsync(binPath(), ["cli", "index_repository", JSON.stringify({ repo_path: ctx.cwd })], {
							timeout: 300_000,
							maxBuffer: MAX_OUTPUT,
						});
						ctx.ui.notify(`Indexed ${ctx.cwd}`, "info");
					} catch (e) {
						ctx.ui.notify(`Indexing failed: ${(e as Error).message}`, "error");
					}
				}

				ctx.ui.setStatus?.("cbm", undefined);
				ctx.ui.notify(
					`codebase-memory-mcp ${version} installed${reg.changed ? " (registered MCP server)" : " (MCP already registered)"}. Restart pi or run /reload to load the graph tools.`,
					"info",
				);
			} catch (err) {
				ctx.ui.setStatus?.("cbm", undefined);
				ctx.ui.notify(`Failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// ── /cbm-status ────────────────────────────────────────────────────────────
	pi.registerCommand("cbm-status", {
		description: "Report whether codebase-memory-mcp is installed, registered in pi, and the current project is indexed.",
		handler: async (_args, ctx) => {
			const bin = await resolveBinary();
			const lines: Array<[string, boolean]> = [];
			if (bin) {
				const v = await tryVersion(bin);
				lines.push(["Binary installed", true]);
				lines.push([`  version: ${v ?? "unknown"}`, false]);
				lines.push([`  path: ${bin}`, false]);
			} else {
				lines.push(["Binary installed", false]);
			}

			let registered = false;
			try {
				const data = JSON.parse(await readFile(mcpJsonPath(), "utf8")) as {
					mcpServers?: Record<string, unknown>;
				};
				registered = Boolean(data.mcpServers?.["codebase-memory-mcp"]);
			} catch {
				registered = false;
			}
			lines.push(["Registered in pi's mcp.json", registered]);
			lines.push(["", false]);

			let indexed = false;
			if (bin) {
				try {
					const { stdout } = await execFileAsync(bin, ["cli", "list_projects", "{}"], {
						timeout: 10_000,
						maxBuffer: MAX_OUTPUT,
					});
					const parsed = JSON.parse(stdout) as { projects?: Array<{ root_path?: string }> };
					const cwdRoot = ctx.cwd.endsWith("/") ? ctx.cwd : ctx.cwd + "/";
					indexed = (parsed.projects ?? []).some((p) => {
						const root = p.root_path ? (p.root_path.endsWith("/") ? p.root_path : p.root_path + "/") : "";
						return root.length > 0 && cwdRoot.startsWith(root);
					});
				} catch {
					indexed = false;
				}
			}
			lines.push(["Current project indexed", indexed]);
			lines.push(["", false]);
			lines.push(["Note: MCP tools load at session start — run /reload or restart pi to activate.", false]);

			const text = lines
				.map(([label, ok]) => `${ok ? "✔" : "✘"}  ${label}`)
				.join("\n");
			ctx.ui.notify(`codebase-memory-mcp status:\n${text}`, indexed ? "info" : "warning");
		},
	});
}