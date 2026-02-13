/**
 * Reflect — Self-improving behavioral files for pi coding agents.
 *
 * Analyzes recent session transcripts for correction patterns — places where
 * the user had to redirect, correct, or express frustration with the agent —
 * and makes surgical edits to a target markdown file to prevent recurrence.
 *
 * Commands:
 *   /reflect [path]     — Run reflection on a file (or configured default)
 *   /reflect-config     — Show/edit reflection configuration
 *   /reflect-history    — Show recent reflection runs
 *
 * Configuration (~/.pi/agent/reflect.json):
 *   {
 *     "targets": [
 *       {
 *         "path": "/path/to/AGENTS.md",
 *         "schedule": "daily",
 *         "model": "anthropic/claude-sonnet-4-5",
 *         "lookbackDays": 1,
 *         "maxSessionBytes": 614400,
 *         "backupDir": "~/.pi/agent/reflect-backups"
 *       }
 *     ]
 *   }
 *
 * Headless execution for cron/launchd:
 *   pi -p --no-session "/reflect /path/to/AGENTS.md"
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// --- Paths ---

const HOME = process.env.HOME ?? "~";
const CONFIG_DIR = path.join(HOME, ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "reflect.json");
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, "reflect-backups");
const HISTORY_FILE = path.join(CONFIG_DIR, "reflect-history.json");

// --- Types ---

interface TranscriptSource {
	type: "pi-sessions" | "command";
	/** Shell command that outputs transcript text to stdout. `{lookbackDays}` is interpolated. */
	command?: string;
}

interface ReflectTarget {
	path: string;
	schedule: "daily" | "manual";
	model: string;
	lookbackDays: number;
	maxSessionBytes: number;
	backupDir: string;
	transcriptSource: TranscriptSource;
}

interface ReflectConfig {
	targets: ReflectTarget[];
}

interface ReflectRun {
	timestamp: string;
	targetPath: string;
	sessionsAnalyzed: number;
	correctionsFound: number;
	editsApplied: number;
	summary: string;
	diffLines: number;
}

interface SessionExchange {
	role: "user" | "assistant";
	text: string | null;
	thinking: string | null;
}

interface SessionData {
	userCount: number;
	exchangeCount: number;
	transcript: string;
	size: number;
	project: string;
	time: string;
}

interface TranscriptResult {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
}

interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}

interface AnalysisEdit {
	type: "strengthen" | "add";
	section?: string;
	old_text?: string | null;
	new_text: string;
	after_text?: string | null;
	reason?: string;
}

type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

// --- Defaults ---

const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: DEFAULT_BACKUP_DIR,
	transcriptSource: { type: "pi-sessions" },
};

const MAX_ASSISTANT_MSG_CHARS = 2000;
const MAX_THINKING_MSG_CHARS = 1500;

// --- Config ---

function loadConfig(): ReflectConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			targets: (parsed.targets ?? []).map((t: any) => ({
				...DEFAULT_TARGET,
				...t,
			})),
		};
	} catch {
		return { targets: [] };
	}
}

function saveConfig(config: ReflectConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function loadHistory(): ReflectRun[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
	} catch {
		return [];
	}
}

function saveHistory(runs: ReflectRun[]): void {
	const trimmed = runs.slice(-100);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}

// --- Helpers ---

function resolvePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(HOME, p.slice(1));
	}
	return path.resolve(p);
}

function formatTimestamp(): string {
	return new Date().toISOString().replace("T", "_").replace(/[:.]/g, "").slice(0, 15);
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateText(text: string | null, limit: number): string | null {
	if (!text) return text;
	if (text.length > limit) {
		return text.slice(0, limit) + `\n[...truncated, ${text.length - limit} chars omitted]`;
	}
	return text;
}

// --- Session extraction ---

function projectNameFromDir(dirname: string): string {
	let name = dirname;
	// Strip the home directory prefix that pi uses for session dir names
	const user = process.env.USER ?? "user";
	const homePrefix = `--Users-${user}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	// Also handle Linux-style paths: --home-user-
	const linuxPrefix = `--home-${user}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}

async function extractTranscript(filepath: string): Promise<SessionExchange[]> {
	const exchanges: SessionExchange[] = [];
	try {
		const rl = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
		for await (const line of rl) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const content = msg.content;
			if (!Array.isArray(content)) continue;

			const textParts: string[] = [];
			const thinkingParts: string[] = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type === "text" && part.text?.trim()) {
					textParts.push(part.text.trim());
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					thinkingParts.push(part.thinking.trim());
				}
			}

			if (textParts.length === 0 && thinkingParts.length === 0) continue;

			exchanges.push({
				role,
				text: textParts.length > 0 ? textParts.join("\n") : null,
				thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : null,
			});
		}
	} catch {
		// Skip unreadable files
	}
	return exchanges;
}

function formatSessionTranscript(exchanges: SessionExchange[], sessionId: string, project: string): string {
	const lines: string[] = [];
	lines.push(`### Session: ${project} [${sessionId}]`);
	lines.push("");

	for (const ex of exchanges) {
		if (ex.role === "user") {
			lines.push(`**USER:** ${ex.text}`);
			lines.push("");
		} else if (ex.role === "assistant") {
			if (ex.thinking) {
				lines.push(`**THINKING:** ${truncateText(ex.thinking, MAX_THINKING_MSG_CHARS)}`);
				lines.push("");
			}
			if (ex.text) {
				lines.push(`**AGENT:** ${truncateText(ex.text, MAX_ASSISTANT_MSG_CHARS)}`);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

async function collectTranscripts(lookbackDays: number, maxBytes: number): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		targetDates.push(d.toISOString().slice(0, 10));
	}

	// Include "next day" for UTC/local timezone overlap
	const nextDates = targetDates.map((d) => {
		const next = new Date(d);
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}

	const allSessions: SessionData[] = [];
	let totalScanned = 0;

	for (const dir of sessionDirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}

		for (const file of files) {
			const fileDate = file.slice(0, 10);
			if (!allDates.has(fileDate)) continue;

			// For "next day" files, only include early hours (UTC overlap)
			if (!targetDates.includes(fileDate)) {
				try {
					const hour = parseInt(file.slice(11, 13));
					if (hour >= 8) continue;
				} catch {
					continue;
				}
			}

			totalScanned++;
			const filepath = path.join(dir, file);
			const exchanges = await extractTranscript(filepath);
			const userCount = exchanges.filter((e) => e.role === "user").length;

			if (userCount < 1 || exchanges.length < 3) continue;

			const sessionTime = file.slice(0, 19).replace("T", " ");
			const transcript = formatSessionTranscript(exchanges, sessionTime, project);

			allSessions.push({
				userCount,
				exchangeCount: exchanges.length,
				transcript,
				size: transcript.length,
				project,
				time: sessionTime,
			});
		}
	}

	if (allSessions.length === 0) {
		return { transcripts: "", sessionCount: totalScanned, includedCount: 0 };
	}

	// Sort by user interaction density (more back-and-forth = more likely corrections)
	allSessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});

	// Build output within budget
	const parts: string[] = [];
	let currentSize = 0;
	let included = 0;

	for (const sd of allSessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes) continue;
		parts.push(entry);
		currentSize += entry.length;
		included++;
	}

	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${allSessions.length} with substantive conversation, ${included} included\n` +
		`# Total user messages: ${allSessions.reduce((s, sd) => s + sd.userCount, 0)}\n\n`;

	return {
		transcripts: header + parts.join(""),
		sessionCount: totalScanned,
		includedCount: included,
	};
}

async function collectTranscriptsFromCommand(command: string, lookbackDays: number, maxBytes: number): Promise<TranscriptResult> {
	const { execSync } = await import("node:child_process");
	const interpolated = command.replace(/\{lookbackDays\}/g, String(lookbackDays));

	try {
		let output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 60_000,
			maxBuffer: maxBytes * 2,
		});

		if (output.length > maxBytes) {
			output = output.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
		}

		const sessionMatches = output.match(/^### Session:/gm);
		const count = sessionMatches?.length ?? 1;

		return { transcripts: output, sessionCount: count, includedCount: count };
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}
}

// --- LLM prompt ---

function buildReflectionPrompt(targetPath: string, targetContent: string, transcripts: string): string {
	const fileName = path.basename(targetPath);
	return `You are reviewing recent agent session transcripts to improve ${fileName}.

## Input

### Target file: ${fileName}
<target_file>
${targetContent}
</target_file>

### Session transcripts
<transcripts>
${transcripts}
</transcripts>

## Step 1: Identify Correction Patterns

Read through all the transcripts carefully. Look for:
- User redirecting the agent ("no", "not that", "I said...", "wrong", "actually...")
- User expressing frustration ("bro", "wtf", "seriously", "come on", "sigh")
- User having to repeat themselves or re-explain
- User asking the agent to undo or revert something
- User telling the agent to simplify or stop over-engineering
- User correcting the agent's approach or understanding
- Agent thinking that reveals a misunderstanding that the user then corrects

For each real correction, note: what the agent did wrong, what the user wanted, and which rule in ${fileName} (if any) already covers this.

Ignore normal conversation flow — "no" in "no worries" or "actually, that looks good" are NOT corrections. Focus on genuine friction where the agent's behavior wasted the user's time.

## Step 2: Propose Edits

Based on the patterns you found:
- Only propose edits that address ACTUAL patterns in the transcripts. Don't invent hypothetical rules.
- If an existing rule already covers the pattern but the agent still violated it, STRENGTHEN the wording (make it more prominent, add emphasis, add a concrete example).
- If a correction pattern has no matching rule, propose a new bullet in the most appropriate existing section.
- Do NOT reorganize, rewrite, or restructure the file. Propose minimal, targeted edits.
- Do NOT remove any existing rules.
- Do NOT add rules for one-off situations. Only add rules for patterns (2+ occurrences across different sessions).
- Keep the same tone and style as the existing file.

## Step 3: Output

IMPORTANT: Your ENTIRE response must be a single JSON object. No markdown, no explanation, no preamble. Start with { and end with }.

For "strengthen" edits: old_text must be a COMPLETE bullet point or rule from the file, copied character-for-character. new_text is the full replacement. Do NOT use partial strings — always include the complete line/bullet from "- **" to the end of the bullet point.
For "add" edits: after_text must be a COMPLETE bullet point or line from the file, copied exactly. new_text is inserted on a new line after it. The new_text should be a complete new bullet point.
CRITICAL: Never duplicate content. new_text should EXTEND or REPLACE old_text, not repeat it.

{
  "corrections_found": <number>,
  "sessions_with_corrections": <number>,
  "edits": [
    {
      "type": "strengthen" | "add",
      "section": "which section of the file",
      "old_text": "exact text to find (for strengthen) or null (for add)",
      "new_text": "replacement text (for strengthen) or new text to insert (for add)",
      "after_text": "text after which to insert (for add) or null (for strengthen)",
      "reason": "why this edit is needed, with session evidence"
    }
  ],
  "patterns_not_added": [
    {
      "pattern": "description",
      "reason": "why it wasn't added (one-off, already covered, etc.)"
    }
  ],
  "summary": "2-3 sentence summary of what was found and changed"
}`;
}

// --- Edit application ---

function applyEdits(content: string, edits: AnalysisEdit[]): EditResult {
	let result = content;
	let applied = 0;
	const skipped: string[] = [];

	for (const edit of edits) {
		if (edit.type === "strengthen" && edit.old_text && edit.new_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to strengthen: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			if (edit.old_text.length > 50) {
				const checkSnippet = edit.old_text.slice(0, 50);
				const occurrences = (edit.new_text.match(new RegExp(escapeRegex(checkSnippet), "g")) || []).length;
				if (occurrences > 1) {
					skipped.push(`Duplication detected in replacement text: "${edit.old_text.slice(0, 80)}..."`);
					continue;
				}
			}

			result = result.replace(edit.old_text, edit.new_text);
			applied++;
		} else if (edit.type === "add" && edit.new_text && edit.after_text) {
			if (!result.includes(edit.after_text)) {
				skipped.push(`Could not find insertion point: "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.after_text);
			const secondIdx = result.indexOf(edit.after_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous insertion point (appears multiple times): "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			if (result.includes(edit.new_text.trim())) {
				skipped.push(`Text already exists in file: "${edit.new_text.trim().slice(0, 80)}..."`);
				continue;
			}

			result = result.replace(edit.after_text, edit.after_text + "\n" + edit.new_text);
			applied++;
		} else {
			skipped.push(`Invalid edit: ${JSON.stringify(edit).slice(0, 100)}`);
		}
	}

	return { result, applied, skipped };
}

// --- Main reflection logic ---

async function runReflection(
	target: ReflectTarget,
	modelRegistry: any,
	notify: NotifyFn,
): Promise<ReflectRun | null> {
	const targetPath = resolvePath(target.path);

	if (!fs.existsSync(targetPath)) {
		notify(`Target file not found: ${targetPath}`, "error");
		return null;
	}

	const targetContent = fs.readFileSync(targetPath, "utf-8");
	if (targetContent.length < 100) {
		notify(`Target file too small (${targetContent.length} bytes): ${targetPath}`, "error");
		return null;
	}

	// Collect transcripts
	notify(`Extracting transcripts (last ${target.lookbackDays} day(s))...`, "info");
	let transcriptResult: TranscriptResult;

	if (target.transcriptSource.type === "command" && target.transcriptSource.command) {
		transcriptResult = await collectTranscriptsFromCommand(
			target.transcriptSource.command,
			target.lookbackDays,
			target.maxSessionBytes,
		);
	} else {
		transcriptResult = await collectTranscripts(
			target.lookbackDays,
			target.maxSessionBytes,
		);
	}

	const { transcripts, sessionCount, includedCount } = transcriptResult;

	if (!transcripts || includedCount === 0) {
		notify(`No substantive sessions found (${sessionCount} scanned). Nothing to reflect on.`, "info");
		return null;
	}

	notify(`Extracted ${includedCount} sessions (${sessionCount} scanned, ${(transcripts.length / 1024).toFixed(0)}KB)`, "info");

	// Resolve model
	const [provider, modelId] = target.model.split("/", 2);
	let model = getModel(provider as any, modelId as any);

	if (!model) {
		model = modelRegistry?.find(provider, modelId);
	}
	if (!model) {
		notify(`Model not found: ${target.model}`, "error");
		return null;
	}

	const apiKey = await modelRegistry?.getApiKey(model);
	if (!apiKey) {
		notify(`No API key for model: ${target.model}`, "error");
		return null;
	}

	// Build prompt and call LLM
	notify(`Analyzing with ${target.model}...`, "info");
	const prompt = buildReflectionPrompt(targetPath, targetContent, transcripts);

	const response = await completeSimple(model, {
		systemPrompt: "You are a behavioral analysis tool. You analyze agent session transcripts and output ONLY valid JSON. Never output markdown, explanations, or any text outside the JSON object.",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		],
	}, { apiKey, maxTokens: 16384 });

	const responseText = response.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();

	// Parse JSON response
	let analysis: any;
	try {
		const jsonStr = responseText.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
		analysis = JSON.parse(jsonStr);
	} catch {
		notify(`Failed to parse LLM response as JSON. Raw response:\n${responseText.slice(0, 500)}`, "error");
		return null;
	}

	const edits: AnalysisEdit[] = analysis.edits ?? [];
	if (edits.length === 0) {
		notify(`No edits needed. ${analysis.summary ?? ""}`, "info");
		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: includedCount,
			correctionsFound: analysis.corrections_found ?? 0,
			editsApplied: 0,
			summary: analysis.summary ?? "No edits needed.",
			diffLines: 0,
		};
	}

	// Backup before editing
	const backupDir = resolvePath(target.backupDir);
	fs.mkdirSync(backupDir, { recursive: true });
	const backupPath = path.join(backupDir, `${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`);
	fs.copyFileSync(targetPath, backupPath);

	// Apply edits with safety checks
	const { result, applied, skipped } = applyEdits(targetContent, edits);

	if (applied === 0) {
		notify(`All ${edits.length} edits failed to apply. Skipped: ${skipped.join("; ")}`, "warning");
		try { fs.unlinkSync(backupPath); } catch {}
		return null;
	}

	// Size sanity check — reject if result lost more than half the content
	if (result.length < targetContent.length * 0.5) {
		notify(`Result is suspiciously small (${result.length} vs ${targetContent.length} bytes). Aborting.`, "error");
		return null;
	}

	fs.writeFileSync(targetPath, result, "utf-8");

	// Count changed lines
	const originalLines = targetContent.split("\n");
	const resultLines = result.split("\n");
	let diffLines = 0;
	const maxLen = Math.max(originalLines.length, resultLines.length);
	for (let i = 0; i < maxLen; i++) {
		if (originalLines[i] !== resultLines[i]) diffLines++;
	}

	if (skipped.length > 0) {
		notify(`Applied ${applied}/${edits.length} edits (${skipped.length} skipped). Backup: ${backupPath}`, "warning");
	} else {
		notify(`Applied ${applied} edit(s). Backup: ${backupPath}`, "info");
	}

	const summary = analysis.summary ?? `${applied} edits applied from ${includedCount} sessions.`;
	notify(summary, "info");

	return {
		timestamp: new Date().toISOString(),
		targetPath,
		sessionsAnalyzed: includedCount,
		correctionsFound: analysis.corrections_found ?? 0,
		editsApplied: applied,
		summary,
		diffLines,
	};
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
	let modelRegistryRef: any = null;

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
	});

	pi.registerCommand("reflect", {
		description: "Reflect on recent sessions and improve a behavioral markdown file",
		handler: async (args, ctx) => {
			modelRegistryRef = ctx.modelRegistry;
			const targetPath = args?.trim();

			let target: ReflectTarget;

			if (targetPath) {
				const config = loadConfig();
				const existing = config.targets.find(
					(t) => resolvePath(t.path) === resolvePath(targetPath),
				);
				target = existing ?? { ...DEFAULT_TARGET, path: targetPath };
			} else {
				const config = loadConfig();
				if (config.targets.length === 0) {
					if (ctx.hasUI) {
						const filePath = await ctx.ui.input(
							"No targets configured. Enter path to a markdown file to reflect on:",
						);
						if (!filePath) return;
						target = { ...DEFAULT_TARGET, path: filePath };

						const save = await ctx.ui.confirm(
							"Save target?",
							`Save ${filePath} as a reflection target for next time?`,
						);
						if (save) {
							config.targets.push(target);
							saveConfig(config);
							ctx.ui.notify("Saved to reflect.json", "info");
						}
					} else {
						console.error("No targets configured. Use: /reflect <path>");
						return;
					}
				} else if (config.targets.length === 1) {
					target = config.targets[0];
				} else if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Which target?",
						config.targets.map((t) => path.basename(t.path)),
					);
					if (choice === undefined) return;
					target = config.targets[choice];
				} else {
					target = config.targets[0];
				}
			}

			const notify: NotifyFn = ctx.hasUI
				? (msg, level) => ctx.ui.notify(msg, level)
				: (msg, level) => console.log(`[reflect] [${level}] ${msg}`);

			const run = await runReflection(target, modelRegistryRef, notify);

			if (run) {
				const history = loadHistory();
				history.push(run);
				saveHistory(history);
			}
		},
	});

	pi.registerCommand("reflect-config", {
		description: "Show and manage reflection targets",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			if (!ctx.hasUI) {
				console.log(JSON.stringify(config, null, 2));
				return;
			}

			if (config.targets.length === 0) {
				ctx.ui.notify("No targets configured. Use /reflect <path> to add one.", "info");
				return;
			}

			const lines = config.targets.map((t, i) => {
				return `${i + 1}. **${path.basename(t.path)}** — ${t.schedule}, ${t.model}, ${t.lookbackDays}d lookback\n   ${t.path}`;
			});

			ctx.ui.notify(
				`Reflection targets:\n${lines.join("\n")}\n\nEdit: ${CONFIG_FILE}`,
				"info",
			);
		},
	});

	pi.registerCommand("reflect-history", {
		description: "Show recent reflection runs",
		handler: async (_args, ctx) => {
			const history = loadHistory();

			if (history.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("No reflection runs yet. Use /reflect to run one.", "info");
				}
				return;
			}

			const recent = history.slice(-10).reverse();
			const lines = recent.map((r) => {
				const date = r.timestamp.slice(0, 16).replace("T", " ");
				const file = path.basename(r.targetPath);
				return `- **${date}** ${file}: ${r.editsApplied} edits, ${r.correctionsFound} corrections (${r.sessionsAnalyzed} sessions)\n  ${r.summary}`;
			});

			if (ctx.hasUI) {
				ctx.ui.notify(`Recent reflections:\n${lines.join("\n")}`, "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});
}
