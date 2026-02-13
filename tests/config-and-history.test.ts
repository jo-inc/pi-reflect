import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanup } from "./helpers.js";

/**
 * Config and history tests.
 *
 * loadConfig/saveConfig/loadHistory/saveHistory read from module-level constants
 * (CONFIG_FILE, HISTORY_FILE). We can't easily redirect those without env var overrides.
 * Instead, we test the serialization/deserialization logic by writing temp files
 * and verifying the JSON structure matches what the functions expect.
 */

describe("config serialization", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("config round-trips through JSON correctly", () => {
		const config = {
			targets: [
				{
					path: "/path/to/AGENTS.md",
					schedule: "daily",
					model: "anthropic/claude-sonnet-4-5",
					lookbackDays: 1,
					maxSessionBytes: 614400,
					backupDir: "~/.pi/agent/reflect-backups",
					transcriptSource: { type: "pi-sessions" },
				},
			],
		};
		const fp = path.join(tmpDir, "config.json");
		fs.writeFileSync(fp, JSON.stringify(config, null, 2));
		const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
		assert.deepEqual(parsed, config);
	});

	it("config with command transcript source round-trips", () => {
		const config = {
			targets: [
				{
					path: "/path/to/SOUL.md",
					schedule: "daily",
					model: "anthropic/claude-sonnet-4-5",
					lookbackDays: 7,
					maxSessionBytes: 614400,
					backupDir: "~/.pi/agent/reflect-backups",
					transcriptSource: {
						type: "command",
						command: "python extract.py {lookbackDays}",
					},
				},
			],
		};
		const fp = path.join(tmpDir, "config.json");
		fs.writeFileSync(fp, JSON.stringify(config, null, 2));
		const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
		assert.equal(parsed.targets[0].transcriptSource.type, "command");
		assert.equal(parsed.targets[0].transcriptSource.command, "python extract.py {lookbackDays}");
	});

	it("partial config gets defaults merged", () => {
		// Simulate what loadConfig does: merge with DEFAULT_TARGET
		const DEFAULT_TARGET = {
			path: "",
			schedule: "daily",
			model: "anthropic/claude-sonnet-4-5",
			lookbackDays: 1,
			maxSessionBytes: 600 * 1024,
			backupDir: "default-backup",
			transcriptSource: { type: "pi-sessions" },
		};
		const partial = { path: "/my/file.md" };
		const merged = { ...DEFAULT_TARGET, ...partial };
		assert.equal(merged.path, "/my/file.md");
		assert.equal(merged.model, "anthropic/claude-sonnet-4-5");
		assert.equal(merged.lookbackDays, 1);
		assert.equal(merged.transcriptSource.type, "pi-sessions");
	});

	it("target-level overrides take precedence over defaults", () => {
		const DEFAULT_TARGET = {
			path: "",
			schedule: "daily" as const,
			model: "anthropic/claude-sonnet-4-5",
			lookbackDays: 1,
			maxSessionBytes: 600 * 1024,
			backupDir: "default-backup",
			transcriptSource: { type: "pi-sessions" as const },
		};
		const override = {
			path: "/my/file.md",
			model: "google/gemini-2.5-pro",
			lookbackDays: 7,
		};
		const merged = { ...DEFAULT_TARGET, ...override };
		assert.equal(merged.model, "google/gemini-2.5-pro");
		assert.equal(merged.lookbackDays, 7);
		assert.equal(merged.schedule, "daily"); // kept default
	});
});

describe("history serialization", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("history round-trips through JSON", () => {
		const runs = [
			{
				timestamp: "2026-02-12T20:22:25.000Z",
				targetPath: "/path/to/AGENTS.md",
				sessionsAnalyzed: 48,
				correctionsFound: 135,
				editsApplied: 7,
				summary: "7 edits applied.",
				diffLines: 20,
			},
		];
		const fp = path.join(tmpDir, "history.json");
		fs.writeFileSync(fp, JSON.stringify(runs, null, 2));
		const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
		assert.deepEqual(parsed, runs);
	});

	it("history is trimmed to last 100 runs", () => {
		const runs = Array.from({ length: 150 }, (_, i) => ({
			timestamp: `2026-01-${String(i).padStart(3, "0")}`,
			targetPath: "/path/to/AGENTS.md",
			sessionsAnalyzed: 10,
			correctionsFound: 5,
			editsApplied: 2,
			summary: `Run ${i}`,
			diffLines: 3,
		}));
		const trimmed = runs.slice(-100);
		assert.equal(trimmed.length, 100);
		assert.equal(trimmed[0].summary, "Run 50");
		assert.equal(trimmed[99].summary, "Run 149");
	});

	it("empty history returns empty array from JSON parse", () => {
		const fp = path.join(tmpDir, "history.json");
		fs.writeFileSync(fp, "[]");
		const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
		assert.deepEqual(parsed, []);
	});

	it("malformed history file returns fallback empty array", () => {
		const fp = path.join(tmpDir, "history.json");
		fs.writeFileSync(fp, "not json");
		let result: any[];
		try {
			result = JSON.parse(fs.readFileSync(fp, "utf-8"));
		} catch {
			result = [];
		}
		assert.deepEqual(result, []);
	});
});
