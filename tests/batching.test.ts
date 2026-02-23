import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildTranscriptBatches,
	runReflection,
	type ReflectTarget,
	type RunReflectionDeps,
	type NotifyFn,
	type SessionData,
	type TranscriptResult,
	DEFAULT_TARGET,
} from "../extensions/reflect.js";
import { makeTempDir, cleanup, SAMPLE_AGENTS_MD } from "./helpers.js";

// --- buildTranscriptBatches tests ---

function makeSession(id: string, sizeBytes: number): SessionData {
	const transcript = "x".repeat(sizeBytes);
	return {
		transcript,
		project: "test-project",
		sessionId: id,
		date: "2026-02-20",
		size: sizeBytes,
	};
}

describe("buildTranscriptBatches", () => {
	it("puts all sessions in one batch when they fit", () => {
		const sessions = [makeSession("a", 100), makeSession("b", 100), makeSession("c", 100)];
		const batches = buildTranscriptBatches(sessions, 1000);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 3);
	});

	it("splits sessions across batches when they exceed maxBytes", () => {
		const sessions = [makeSession("a", 500), makeSession("b", 500), makeSession("c", 500)];
		// Each entry is transcript + "\n---\n\n" = 506 bytes
		const batches = buildTranscriptBatches(sessions, 600);
		assert.equal(batches.length, 3);
		assert.equal(batches[0].length, 1);
		assert.equal(batches[1].length, 1);
		assert.equal(batches[2].length, 1);
	});

	it("groups multiple small sessions into one batch", () => {
		const sessions = [
			makeSession("a", 100),
			makeSession("b", 100),
			makeSession("c", 100),
			makeSession("d", 100),
		];
		// Each entry ~106 bytes, 4 × 106 = 424 bytes
		const batches = buildTranscriptBatches(sessions, 250);
		assert.equal(batches.length, 2);
		assert.equal(batches[0].length, 2);
		assert.equal(batches[1].length, 2);
	});

	it("returns empty array for empty sessions", () => {
		const batches = buildTranscriptBatches([], 1000);
		assert.equal(batches.length, 0);
	});

	it("handles a single session larger than maxBytes", () => {
		const sessions = [makeSession("a", 2000)];
		const batches = buildTranscriptBatches(sessions, 500);
		// Single session still gets its own batch even if it exceeds budget
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 1);
	});

	it("preserves session order across batches", () => {
		const sessions = [
			{ ...makeSession("1st", 300), transcript: "FIRST_SESSION_CONTENT" + "x".repeat(279) },
			{ ...makeSession("2nd", 300), transcript: "SECOND_SESSION_CONTENT" + "x".repeat(278) },
			{ ...makeSession("3rd", 300), transcript: "THIRD_SESSION_CONTENT" + "x".repeat(279) },
		];
		const batches = buildTranscriptBatches(sessions, 400);
		assert.equal(batches.length, 3);
		assert.ok(batches[0][0].includes("FIRST_SESSION"));
		assert.ok(batches[1][0].includes("SECOND_SESSION"));
		assert.ok(batches[2][0].includes("THIRD_SESSION"));
	});

	it("each entry includes separator suffix", () => {
		const sessions = [makeSession("a", 50)];
		const batches = buildTranscriptBatches(sessions, 1000);
		assert.ok(batches[0][0].endsWith("\n---\n\n"));
	});
});

// --- Tool call parsing + batched runReflection tests ---

let tmpDir: string;
let notifications: Array<{ msg: string; level: string }>;
let notify: NotifyFn;

beforeEach(() => {
	tmpDir = makeTempDir();
	notifications = [];
	notify = (msg, level) => notifications.push({ msg, level });
});

afterEach(() => {
	cleanup(tmpDir);
});

function makeTarget(overrides: Partial<ReflectTarget> = {}): ReflectTarget {
	return {
		...DEFAULT_TARGET,
		backupDir: path.join(tmpDir, "backups"),
		...overrides,
	};
}

function makeModelRegistry() {
	return {
		find: () => ({ provider: "test", id: "test-model" }),
		getApiKey: async () => "test-key",
	};
}

function makeToolCallResponse(analysis: any) {
	return {
		content: [{
			type: "toolCall",
			name: "submit_analysis",
			arguments: analysis,
		}],
	};
}

function makeTextResponse(text: string) {
	return {
		content: [{ type: "text", text }],
	};
}

// batchBudget = Math.max(maxSessionBytes - overhead, 100_000)
// overhead = targetContent.length + context.length + 20_000
// SAMPLE_AGENTS_MD is ~900 bytes, so overhead ≈ 20_900
// To force batching: totalBytes must exceed batchBudget
// With maxSessionBytes=120_000, batchBudget = max(120_000 - 20_900, 100_000) = 100_000
// So sessions totaling >100KB will trigger batching.
const LARGE_SESSION_SIZE = 40_000; // 40KB each — 3 sessions = 120KB > 100KB budget

function makeLargeSessions(count: number): SessionData[] {
	return Array.from({ length: count }, (_, i) =>
		makeSession(`s${i + 1}`, LARGE_SESSION_SIZE)
	);
}

function makeBatchDeps(
	responsePerCall: any[],
	sessions: SessionData[],
): RunReflectionDeps {
	let callIndex = 0;
	return {
		completeSimple: async () => {
			const resp = responsePerCall[Math.min(callIndex, responsePerCall.length - 1)];
			callIndex++;
			return resp;
		},
		getModel: () => ({ provider: "test", id: "test-model" }),
		collectTranscriptsFn: async () => ({
			transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
			sessionCount: sessions.length,
			includedCount: sessions.length,
			sessions,
		}),
	};
}

describe("analyzeTranscriptBatch — tool call parsing", () => {
	it("parses structured tool call response", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });

		const deps: RunReflectionDeps = {
			completeSimple: async () => makeToolCallResponse({
				corrections_found: 1,
				sessions_with_corrections: 1,
				edits: [{
					type: "strengthen",
					section: "Rules",
					old_text: "- **Keep code DRY**: NEVER duplicate logic.",
					new_text: "- **Keep code DRY**: NEVER duplicate logic. Always use shared helpers.",
					reason: "Agent duplicated code in 2 sessions",
				}],
				summary: "Added DRY emphasis.",
			}),
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: "### Session\n\n**USER:** test\n",
				sessionCount: 1,
				includedCount: 1,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 1);
		const updated = fs.readFileSync(fp, "utf-8");
		assert.ok(updated.includes("shared helpers"));
	});

	it("falls back to JSON text when no tool call in response", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });

		const jsonResponse = JSON.stringify({
			corrections_found: 1,
			sessions_with_corrections: 1,
			edits: [{
				type: "strengthen",
				section: "Rules",
				old_text: "- **Keep code DRY**: NEVER duplicate logic.",
				new_text: "- **Keep code DRY**: NEVER duplicate logic. Use parameterized functions.",
				reason: "test",
			}],
			summary: "Fallback test.",
		});

		const deps: RunReflectionDeps = {
			completeSimple: async () => makeTextResponse(jsonResponse),
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: "### Session\n\n**USER:** test\n",
				sessionCount: 1,
				includedCount: 1,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 1);
	});

	it("handles LLM error response gracefully", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });

		const deps: RunReflectionDeps = {
			completeSimple: async () => ({
				stopReason: "error",
				errorMessage: "Rate limit exceeded",
				content: [],
			}),
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: "### Session\n\n**USER:** test\n",
				sessionCount: 1,
				includedCount: 1,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("Rate limit")));
	});
});

describe("batched runReflection", () => {
	it("triggers batching when sessions exceed context budget", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);

		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000, // batchBudget ≈ 100KB, 3 × 40KB = 120KB > 100KB
		});

		const sessions = makeLargeSessions(3);

		// Each batch gets its own LLM call
		let callCount = 0;
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				callCount++;
				if (callCount === 1) {
					return makeToolCallResponse({
						corrections_found: 1,
						sessions_with_corrections: 1,
						edits: [{
							type: "add",
							after_text: "- **Keep code DRY**: NEVER duplicate logic.",
							new_text: "- **Batch 1 rule**: From first batch.",
							reason: "batch 1",
							section: "Rules",
						}],
						summary: "Batch 1 done.",
					});
				}
				// Later batches: add after batch 1's rule
				return makeToolCallResponse({
					corrections_found: 1,
					sessions_with_corrections: 1,
					edits: [{
						type: "add",
						after_text: "- **Batch 1 rule**: From first batch.",
						new_text: `- **Batch ${callCount} rule**: From batch ${callCount}.`,
						reason: `batch ${callCount}`,
						section: "Rules",
					}],
					summary: `Batch ${callCount} done.`,
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);

		assert.notEqual(result, null);
		assert.ok(callCount >= 2, `Expected multiple LLM calls, got ${callCount}`);
		assert.ok(notifications.some(n => n.msg.includes("splitting into")));
		assert.ok(notifications.some(n => n.msg.includes("Batch 1")));

		const updated = fs.readFileSync(fp, "utf-8");
		assert.ok(updated.includes("Batch 1 rule"));
	});

	it("creates backup only once for multi-batch edits", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const backupDir = path.join(tmpDir, "backups");
		const target = makeTarget({
			path: fp,
			backupDir,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);
		let callCount = 0;
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				callCount++;
				if (callCount === 1) {
					return makeToolCallResponse({
						corrections_found: 1,
						sessions_with_corrections: 1,
						edits: [{
							type: "add",
							after_text: "- **Keep code DRY**: NEVER duplicate logic.",
							new_text: "- **Rule from batch 1**: Added.",
							reason: "test",
							section: "Rules",
						}],
						summary: "Batch 1.",
					});
				}
				return makeToolCallResponse({
					corrections_found: 1,
					sessions_with_corrections: 1,
					edits: [{
						type: "add",
						after_text: "- **Rule from batch 1**: Added.",
						new_text: `- **Rule from batch ${callCount}**: Also added.`,
						reason: "test",
						section: "Rules",
					}],
					summary: `Batch ${callCount}.`,
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		await runReflection(target, makeModelRegistry(), notify, deps);

		// Only one backup file should exist
		const backups = fs.readdirSync(backupDir);
		assert.equal(backups.length, 1);

		// Backup should have original content (before any batch edits)
		const backupContent = fs.readFileSync(path.join(backupDir, backups[0]), "utf-8");
		assert.equal(backupContent, SAMPLE_AGENTS_MD);
	});

	it("later batches see edits from earlier batches", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);

		// Later batches should see edits from batch 1 on disk
		let callIndex = 0;
		let laterBatchSawEdit = false;
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				callIndex++;
				if (callIndex === 1) {
					return makeToolCallResponse({
						corrections_found: 1,
						sessions_with_corrections: 1,
						edits: [{
							type: "add",
							after_text: "- **Keep code DRY**: NEVER duplicate logic.",
							new_text: "- **Intermediate rule**: Inserted by batch 1.",
							reason: "test",
							section: "Rules",
						}],
						summary: "Batch 1.",
					});
				}
				// Later batch — verify it sees batch 1's edit by reading the file
				const currentContent = fs.readFileSync(fp, "utf-8");
				if (currentContent.includes("Intermediate rule")) {
					laterBatchSawEdit = true;
				}
				return makeToolCallResponse({
					corrections_found: 0,
					sessions_with_corrections: 0,
					edits: [],
					summary: `Batch ${callIndex} clean.`,
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		await runReflection(target, makeModelRegistry(), notify, deps);
		assert.ok(callIndex >= 2, "Should have multiple batch calls");
		assert.ok(laterBatchSawEdit, "Later batch should see batch 1's edits on disk");
	});

	it("combines summaries from multiple batches", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);
		let callCount = 0;
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				callCount++;
				return makeToolCallResponse({
					corrections_found: 0,
					sessions_with_corrections: 0,
					edits: [],
					summary: `Batch ${callCount} summary.`,
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);

		assert.notEqual(result, null);
		assert.ok(callCount >= 2, `Expected multiple LLM calls, got ${callCount}`);
		assert.ok(result!.summary.includes("Batch 1 summary."));
		assert.ok(result!.summary.includes("Batch 2 summary."));
	});

	it("continues processing when one batch fails", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);

		let callIndex = 0;
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				callIndex++;
				if (callIndex === 1) {
					// First batch fails
					return { stopReason: "error", errorMessage: "Timeout", content: [] };
				}
				// Later batches succeed
				return makeToolCallResponse({
					corrections_found: 1,
					sessions_with_corrections: 1,
					edits: [{
						type: "add",
						after_text: "- **Keep code DRY**: NEVER duplicate logic.",
						new_text: "- **Surviving rule**: From later batch.",
						reason: "test",
						section: "Rules",
					}],
					summary: "Later batch succeeded.",
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.ok(callIndex >= 2, "Should have made multiple LLM calls");
		// Later batch's edit should still apply even though batch 1 failed
		const updated = fs.readFileSync(fp, "utf-8");
		assert.ok(updated.includes("Surviving rule"));
		assert.ok(notifications.some(n => n.msg.includes("Timeout")));
	});

	it("does not batch when sessions fit within budget", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 500_000, // large budget
		});

		const sessions = [makeSession("s1", 100), makeSession("s2", 100)];
		const deps: RunReflectionDeps = {
			completeSimple: async () => makeToolCallResponse({
				corrections_found: 0,
				sessions_with_corrections: 0,
				edits: [],
				summary: "All clean.",
			}),
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: "### Session\n\n**USER:** test\n",
				sessionCount: 2,
				includedCount: 2,
				sessions,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.notEqual(result, null);
		// Should NOT see batching notification
		assert.ok(!notifications.some(n => n.msg.includes("splitting into")));
		assert.ok(notifications.some(n => n.msg.includes("Analyzing with")));
	});

	it("accumulates correctionsFound across batches", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);
		let callCount = 0;
		const correctionsPerBatch = [3, 5, 2]; // one per batch
		const deps: RunReflectionDeps = {
			completeSimple: async () => {
				const idx = callCount;
				callCount++;
				return makeToolCallResponse({
					corrections_found: correctionsPerBatch[idx] ?? 0,
					sessions_with_corrections: 1,
					edits: [],
					summary: `Batch ${idx + 1}.`,
				});
			},
			getModel: () => ({ provider: "test", id: "test-model" }),
			collectTranscriptsFn: async () => ({
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: sessions.length,
				includedCount: sessions.length,
				sessions,
			}),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps);

		assert.notEqual(result, null);
		// Sum all corrections across however many batches were created
		const expectedTotal = correctionsPerBatch.slice(0, callCount).reduce((a, b) => a + b, 0);
		assert.equal(result!.correctionsFound, expectedTotal);
	});

	it("uses transcriptsOverride sessions for batching", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			maxSessionBytes: 120_000,
		});

		const sessions = makeLargeSessions(3);

		const deps: RunReflectionDeps = {
			completeSimple: async () => makeToolCallResponse({
				corrections_found: 0,
				sessions_with_corrections: 0,
				edits: [],
				summary: "Clean.",
			}),
			getModel: () => ({ provider: "test", id: "test-model" }),
		};

		const result = await runReflection(target, makeModelRegistry(), notify, deps, {
			transcriptsOverride: {
				transcripts: sessions.map(s => s.transcript).join("\n---\n\n"),
				sessionCount: 2,
				includedCount: 2,
				sessions,
			},
		});

		assert.notEqual(result, null);
		// Should batch since totalBytes (800) > batchBudget with tiny maxSessionBytes
		assert.ok(notifications.some(n => n.msg.includes("splitting into")));
	});
});
