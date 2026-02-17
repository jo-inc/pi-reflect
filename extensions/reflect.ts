/**
 * Reflect core logic — all pure/testable functions.
 * The extension entry point (index.ts) wires these into the pi extension API.
 */

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

export interface TranscriptSource {
	type: "pi-sessions" | "command";
	/** Shell command that outputs transcript text to stdout. `{lookbackDays}` is interpolated. */
	command?: string;
}

export interface ContextSource {
	type: "files" | "command" | "url";
	/** Label shown in the context block (e.g. "daily logs", "recent conversations") */
	label?: string;
	/** For "files": glob patterns or file paths. */
	paths?: string[];
	/** For "command": shell command. `{lookbackDays}` is interpolated. */
	command?: string;
	/** For "url": HTTP GET endpoint. `{lookbackDays}` is interpolated. */
	url?: string;
	/** Max bytes to read from this source (default: 100KB) */
	maxBytes?: number;
}

export interface ReflectTarget {
	path: string;
	schedule: "daily" | "manual";
	model: string;
	lookbackDays: number;
	maxSessionBytes: number;
	backupDir: string;
	/** Transcript sources. Can be a single TranscriptSource (legacy) or array of ContextSource[].
	 *  Multiple sources are concatenated with --- separators. */
	transcriptSource?: TranscriptSource;
	transcripts?: ContextSource[];
	/** Custom prompt template. Use {fileName}, {targetContent}, {transcripts}, {context} as placeholders.
	 *  If omitted, uses the default correction-pattern prompt. */
	prompt?: string;
	/** Additional context sources to read and inject. Available via {context} placeholder in prompts.
	 *  Each source has a type: "files" (glob/paths), "command" (shell, stdout), or "url" (HTTP GET). */
	context?: ContextSource[];
}

export interface ReflectConfig {
	targets: ReflectTarget[];
}

export interface EditRecord {
	type: "strengthen" | "add";
	section: string;
	reason: string;
}

export interface ReflectRun {
	timestamp: string;
	targetPath: string;
	sessionsAnalyzed: number;
	correctionsFound: number;
	editsApplied: number;
	summary: string;
	diffLines: number;
	correctionRate: number;
	edits?: EditRecord[];
	sourceDate?: string;
	date?: string; // legacy field from bash-script/batch runs
}

export interface SessionExchange {
	role: "user" | "assistant";
	text: string | null;
	thinking: string | null;
}

export interface SessionData {
	userCount: number;
	exchangeCount: number;
	transcript: string;
	size: number;
	project: string;
	time: string;
}

export interface TranscriptResult {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
}

export interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}

export interface AnalysisEdit {
	type: "strengthen" | "add";
	section?: string;
	old_text?: string | null;
	new_text: string;
	after_text?: string | null;
	reason?: string;
}

export interface ReflectionOptions {
	sourceDateOverride?: string;
	transcriptsOverride?: TranscriptResult;
	dryRun?: boolean;
}

export type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

// --- Defaults ---

export const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: DEFAULT_BACKUP_DIR,
	transcriptSource: { type: "pi-sessions" },
};

export const MAX_ASSISTANT_MSG_CHARS = 2000;
export const MAX_THINKING_MSG_CHARS = 1500;

// --- Config ---

export function loadConfig(): ReflectConfig {
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

export function saveConfig(config: ReflectConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function loadHistory(): ReflectRun[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
	} catch {
		return [];
	}
}

export function saveHistory(runs: ReflectRun[]): void {
	const trimmed = runs.slice(-100);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}

// --- Helpers ---

export function resolvePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(HOME, p.slice(1));
	}
	return path.resolve(p);
}

export function formatTimestamp(): string {
	return new Date().toISOString().replace("T", "_").replace(/[:.]/g, "").slice(0, 15);
}

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateText(text: string | null, limit: number): string | null {
	if (!text) return text;
	if (text.length > limit) {
		return text.slice(0, limit) + `\n[...truncated, ${text.length - limit} chars omitted]`;
	}
	return text;
}

// --- Session extraction ---

export function projectNameFromDir(dirname: string): string {
	let name = dirname;
	const user = process.env.USER ?? "user";
	const homePrefix = `--Users-${user}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	const linuxPrefix = `--home-${user}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}

export async function extractTranscript(filepath: string): Promise<SessionExchange[]> {
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

export function formatSessionTranscript(exchanges: SessionExchange[], sessionId: string, project: string): string {
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

// --- Shared session scanning logic ---

function scanSessionFiles(
	effectiveSessionsDir: string,
	targetDates: string[],
	maxBytes: number,
): { allSessions: SessionData[]; totalScanned: number } {
	// Include "next day" for UTC/local timezone overlap
	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { allSessions: [], totalScanned: 0 };
	}

	return { allSessions: [], totalScanned: 0, _sessionDirs: sessionDirs, _allDates: allDates, _targetDates: new Set(targetDates) } as any;
}

async function collectSessionsForDates(
	targetDates: string[],
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const effectiveSessionsDir = sessionsDir ?? SESSIONS_DIR;

	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);
	const targetDateSet = new Set(targetDates);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
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

			if (!targetDateSet.has(fileDate)) {
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

	allSessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});

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

export async function collectTranscripts(lookbackDays: number, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		targetDates.push(d.toISOString().slice(0, 10));
	}
	return collectSessionsForDates(targetDates, maxBytes, sessionsDir);
}

export async function collectTranscriptsForDate(targetDate: string, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	return collectSessionsForDates([targetDate], maxBytes, sessionsDir);
}

export async function collectTranscriptsFromCommand(command: string, lookbackDays: number, maxBytes: number): Promise<TranscriptResult> {
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

// --- Context collection ---

/** Compute the cutoff date string (YYYY-MM-DD) for lookbackDays ago */
function lookbackCutoff(lookbackDays: number): string {
	const d = new Date();
	d.setDate(d.getDate() - lookbackDays);
	return d.toISOString().slice(0, 10);
}

/** Check if a filename contains a date and whether it's within the lookback window */
function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true; // no date in filename → include it
	return match[1] >= cutoff;
}

export async function collectContext(sources: ContextSource[], lookbackDays: number): Promise<string> {
	const parts: string[] = [];
	const cutoff = lookbackCutoff(lookbackDays);

	for (const source of sources) {
		const maxBytes = source.maxBytes ?? 100 * 1024;
		const label = source.label ?? source.type;
		let content = "";
		let totalBytes = 0;

		try {
			if (source.type === "files" && source.paths) {
				const fileParts: string[] = [];
				for (const pattern of source.paths) {
					const expanded = pattern.replace(/\{lookbackDays\}/g, String(lookbackDays));
					let candidates: { name: string; full: string }[] = [];

					if (expanded.includes("*")) {
						const dir = path.dirname(expanded);
						const filePattern = path.basename(expanded);
						const regex = new RegExp("^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
						try {
							candidates = fs.readdirSync(dir)
								.filter(f => regex.test(f))
								.map(f => ({ name: f, full: path.join(dir, f) }));
						} catch {}
					} else if (fs.existsSync(expanded)) {
						candidates = [{ name: path.basename(expanded), full: expanded }];
					}

					// Prune by date, sort newest first
					candidates = candidates
						.filter(c => isWithinLookback(c.name, cutoff))
						.sort((a, b) => b.name.localeCompare(a.name));

					for (const c of candidates) {
						try {
							if (!fs.statSync(c.full).isFile()) continue;
							const fileContent = fs.readFileSync(c.full, "utf-8");
							if (totalBytes + fileContent.length > maxBytes) break;
							fileParts.push(`### ${c.name}\n${fileContent}`);
							totalBytes += fileContent.length;
						} catch {}
					}
				}
				content = fileParts.join("\n\n");
			} else if (source.type === "command" && source.command) {
				const { execSync } = await import("node:child_process");
				const interpolated = source.command.replace(/\{lookbackDays\}/g, String(lookbackDays));
				content = execSync(interpolated, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: maxBytes * 2,
				});
			} else if (source.type === "url" && source.url) {
				const interpolated = source.url.replace(/\{lookbackDays\}/g, String(lookbackDays));
				const response = await fetch(interpolated, { signal: AbortSignal.timeout(15_000) });
				if (response.ok) {
					content = await response.text();
				}
			}
		} catch {}

		if (content) {
			if (content.length > maxBytes) {
				content = content.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return parts.join("\n\n---\n\n");
}

// --- Scan available session dates ---

export function getAvailableSessionDates(): string[] {
	const dates = new Set<string>();
	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			if (!fs.statSync(fullDir).isDirectory()) continue;
			for (const file of fs.readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const fileDate = file.slice(0, 10);
				if (/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
					dates.add(fileDate);
				}
			}
		}
	} catch {}
	return [...dates].sort();
}

// --- LLM prompt ---

export function buildReflectionPrompt(targetPath: string, targetContent: string, transcripts: string): string {
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

/** Build the prompt for a target. If target has a custom prompt, interpolate it. Otherwise use default. */
export function buildPromptForTarget(target: ReflectTarget, targetPath: string, targetContent: string, transcripts: string, context?: string): string {
	if (!target.prompt) {
		return buildReflectionPrompt(targetPath, targetContent, transcripts);
	}
	const fileName = path.basename(targetPath);
	return target.prompt
		.replace(/\{fileName\}/g, fileName)
		.replace(/\{targetContent\}/g, targetContent)
		.replace(/\{transcripts\}/g, transcripts)
		.replace(/\{context\}/g, context ?? "");
}

// --- Edit application ---

export function applyEdits(content: string, edits: AnalysisEdit[]): EditResult {
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

export interface RunReflectionDeps {
	completeSimple: (model: any, request: any, options: any) => Promise<any>;
	getModel: (provider: string, modelId: string) => any;
	collectTranscriptsFn?: (lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
	collectTranscriptsFromCommandFn?: (command: string, lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: any,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
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

	// Collect transcripts — supports new `transcripts` array (ContextSource[]) or legacy `transcriptSource`
	let transcripts: string;
	let sessionCount = 0;
	let includedCount = 0;

	if (options?.transcriptsOverride) {
		({ transcripts, sessionCount, includedCount } = options.transcriptsOverride);
	} else if (target.transcripts && target.transcripts.length > 0) {
		// New array-based transcript sources
		notify(`Extracting transcripts from ${target.transcripts.length} source(s) (last ${target.lookbackDays} day(s))...`, "info");
		transcripts = await collectContext(target.transcripts, target.lookbackDays);
		// Estimate session count from section headers
		const headerMatches = transcripts.match(/^###\s/gm);
		sessionCount = headerMatches?.length ?? 1;
		includedCount = sessionCount;
	} else if (target.transcriptSource?.type === "command" && target.transcriptSource.command) {
		notify(`Extracting transcripts (last ${target.lookbackDays} day(s))...`, "info");
		const fn = deps?.collectTranscriptsFromCommandFn ?? collectTranscriptsFromCommand;
		const result = await fn(
			target.transcriptSource.command,
			target.lookbackDays,
			target.maxSessionBytes,
		);
		({ transcripts, sessionCount, includedCount } = result);
	} else {
		notify(`Extracting transcripts (last ${target.lookbackDays} day(s))...`, "info");
		const fn = deps?.collectTranscriptsFn ?? collectTranscripts;
		const result = await fn(
			target.lookbackDays,
			target.maxSessionBytes,
		);
		({ transcripts, sessionCount, includedCount } = result);
	}

	if (!transcripts || includedCount === 0) {
		notify(`No substantive sessions found (${sessionCount} scanned). Nothing to reflect on.`, "info");
		return null;
	}

	notify(`Extracted ${includedCount} sessions (${sessionCount} scanned, ${(transcripts.length / 1024).toFixed(0)}KB)`, "info");

	// Resolve model
	const getModelFn = deps?.getModel ?? (await import("@mariozechner/pi-ai")).getModel;
	const [provider, modelId] = target.model.split("/", 2);
	let model = getModelFn(provider as any, modelId as any);

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

	// Collect additional context
	let context = "";
	if (target.context && target.context.length > 0) {
		notify(`Collecting context from ${target.context.length} source(s)...`, "info");
		context = await collectContext(target.context, target.lookbackDays);
		if (context) {
			notify(`Collected ${(context.length / 1024).toFixed(0)}KB of additional context`, "info");
		}
	}

	// Build prompt and call LLM
	notify(`Analyzing with ${target.model}...`, "info");
	const prompt = buildPromptForTarget(target, targetPath, targetContent, transcripts, context);

	const completeFn = deps?.completeSimple ?? (await import("@mariozechner/pi-ai")).completeSimple;
	const response = await completeFn(model, {
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
	const correctionsFound = analysis.corrections_found ?? 0;
	const correctionRate = includedCount > 0 ? correctionsFound / includedCount : 0;

	// sourceDate = the date of sessions being analyzed, not when reflect ran
	let sourceDateStr: string;
	if (options?.sourceDateOverride) {
		sourceDateStr = options.sourceDateOverride;
	} else {
		const sourceDate = new Date();
		sourceDate.setDate(sourceDate.getDate() - target.lookbackDays);
		sourceDateStr = sourceDate.toISOString().slice(0, 10);
	}

	if (edits.length === 0) {
		notify(`No edits needed. ${analysis.summary ?? ""}`, "info");
		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: includedCount,
			correctionsFound,
			editsApplied: 0,
			summary: analysis.summary ?? "No edits needed.",
			diffLines: 0,
			correctionRate,
			edits: [],
			sourceDate: sourceDateStr,
		};
	}

	// In dryRun mode, skip applying edits — just record the analysis
	if (options?.dryRun) {
		const editRecords: EditRecord[] = edits
			.filter((e: any) => e.section && e.reason)
			.map((e: any) => ({
				type: e.type ?? "add",
				section: e.section,
				reason: e.reason,
			}));

		const summary = analysis.summary ?? `${edits.length} edits proposed (dry run).`;
		notify(`[dry run] ${summary}`, "info");

		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: includedCount,
			correctionsFound,
			editsApplied: 0,
			summary,
			diffLines: 0,
			correctionRate,
			edits: editRecords,
			sourceDate: sourceDateStr,
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

	// If target is in a git repo, commit the change
	try {
		const realPath = fs.realpathSync(targetPath);
		const repoDir = path.dirname(realPath);
		if (fs.existsSync(path.join(repoDir, ".git"))) {
			const { execFileSync } = require("node:child_process");
			execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore", timeout: 5000 });
			execFileSync("git", ["commit", "-m", `reflect: ${path.basename(realPath)} — ${applied} edits from ${includedCount} sessions`, "--no-verify"], { cwd: repoDir, stdio: "ignore", timeout: 5000 });
			notify(`Committed to ${path.basename(repoDir)}`, "info");
		}
	} catch {
		// Not in a git repo or commit failed — that's fine
	}

	// Extract per-edit detail for recidivism tracking
	const editRecords: EditRecord[] = edits
		.filter((e: any) => e.section && e.reason)
		.map((e: any) => ({
			type: e.type ?? "add",
			section: e.section,
			reason: e.reason,
		}));

	return {
		timestamp: new Date().toISOString(),
		targetPath,
		sessionsAnalyzed: includedCount,
		correctionsFound,
		editsApplied: applied,
		summary,
		diffLines,
		correctionRate,
		edits: editRecords,
		sourceDate: sourceDateStr,
	};
}

// Re-export path constants for the extension entry point
export { CONFIG_FILE, CONFIG_DIR, SESSIONS_DIR, DEFAULT_BACKUP_DIR, HISTORY_FILE, HOME };
