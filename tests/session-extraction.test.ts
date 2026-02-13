import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractTranscript,
	formatSessionTranscript,
	collectTranscripts,
	type SessionExchange,
} from "../extensions/reflect.js";
import { makeTempDir, cleanup, buildSessionJsonl, createSessionFixture } from "./helpers.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = makeTempDir();
});

afterEach(() => {
	cleanup(tmpDir);
});

describe("extractTranscript", () => {
	it("extracts user and assistant text from JSONL", async () => {
		const jsonl = buildSessionJsonl([
			{ role: "user", text: "Hello" },
			{ role: "assistant", text: "Hi there" },
		]);
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, jsonl);

		const result = await extractTranscript(fp);
		assert.equal(result.length, 2);
		assert.equal(result[0].role, "user");
		assert.equal(result[0].text, "Hello");
		assert.equal(result[1].role, "assistant");
		assert.equal(result[1].text, "Hi there");
	});

	it("extracts thinking tokens from assistant messages", async () => {
		const jsonl = buildSessionJsonl([
			{ role: "user", text: "Explain X" },
			{ role: "assistant", text: "Here is the answer", thinking: "Let me think about this..." },
		]);
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, jsonl);

		const result = await extractTranscript(fp);
		assert.equal(result.length, 2);
		assert.equal(result[1].thinking, "Let me think about this...");
		assert.equal(result[1].text, "Here is the answer");
	});

	it("skips non-message entries", async () => {
		const lines = [
			JSON.stringify({ type: "system", data: "ignored" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
			JSON.stringify({ type: "tool_call", tool: "bash" }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 2);
	});

	it("skips system and tool roles", async () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "system", content: [{ type: "text", text: "System prompt" }] } }),
			JSON.stringify({ type: "message", message: { role: "tool", content: [{ type: "text", text: "Tool result" }] } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "User msg" }] } }),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].role, "user");
	});

	it("skips messages with empty/whitespace-only text", async () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "   " }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "" }] } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Real message" }] } }),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, "Real message");
	});

	it("handles malformed JSON lines gracefully", async () => {
		const lines = [
			"not json at all",
			"{invalid: json}",
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Valid" }] } }),
			"",
			"{{{{",
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, "Valid");
	});

	it("handles messages with non-array content", async () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "just a string" } }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Array content" }] } }),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, "Array content");
	});

	it("handles missing message field", async () => {
		const lines = [
			JSON.stringify({ type: "message" }), // no message field
			JSON.stringify({ type: "message", message: null }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "OK" }] } }),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
	});

	it("returns empty array for nonexistent file", async () => {
		const result = await extractTranscript("/nonexistent/path/file.jsonl");
		assert.deepEqual(result, []);
	});

	it("joins multiple text parts in same message", async () => {
		const lines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Part one" },
						{ type: "text", text: "Part two" },
					],
				},
			}),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, "Part one\nPart two");
	});

	it("handles thinking-only assistant messages (no text)", async () => {
		const jsonl = buildSessionJsonl([
			{ role: "assistant", thinking: "Just thinking, no text output" },
		]);
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, jsonl);

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, null);
		assert.equal(result[0].thinking, "Just thinking, no text output");
	});

	it("skips content parts that are null or non-objects", async () => {
		const lines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [
						null,
						42,
						"string",
						{ type: "text", text: "Valid part" },
					],
				},
			}),
		];
		const fp = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(fp, lines.join("\n") + "\n");

		const result = await extractTranscript(fp);
		assert.equal(result.length, 1);
		assert.equal(result[0].text, "Valid part");
	});
});

describe("formatSessionTranscript", () => {
	it("formats user and assistant exchanges", () => {
		const exchanges: SessionExchange[] = [
			{ role: "user", text: "Hello", thinking: null },
			{ role: "assistant", text: "Hi there", thinking: null },
		];
		const result = formatSessionTranscript(exchanges, "2026-02-12 03:00", "myproject");
		assert.ok(result.includes("### Session: myproject [2026-02-12 03:00]"));
		assert.ok(result.includes("**USER:** Hello"));
		assert.ok(result.includes("**AGENT:** Hi there"));
	});

	it("includes thinking tokens", () => {
		const exchanges: SessionExchange[] = [
			{ role: "assistant", text: "Answer", thinking: "Deep thought" },
		];
		const result = formatSessionTranscript(exchanges, "test", "proj");
		assert.ok(result.includes("**THINKING:** Deep thought"));
		assert.ok(result.includes("**AGENT:** Answer"));
	});

	it("truncates long assistant text", () => {
		const longText = "x".repeat(3000);
		const exchanges: SessionExchange[] = [
			{ role: "assistant", text: longText, thinking: null },
		];
		const result = formatSessionTranscript(exchanges, "test", "proj");
		assert.ok(result.includes("[...truncated"));
		assert.ok(result.length < longText.length);
	});

	it("truncates long thinking text", () => {
		const longThinking = "t".repeat(2000);
		const exchanges: SessionExchange[] = [
			{ role: "assistant", text: "Short answer", thinking: longThinking },
		];
		const result = formatSessionTranscript(exchanges, "test", "proj");
		assert.ok(result.includes("[...truncated"));
	});

	it("handles empty exchanges array", () => {
		const result = formatSessionTranscript([], "test", "proj");
		assert.ok(result.includes("### Session: proj [test]"));
	});
});

describe("collectTranscripts", () => {
	it("finds sessions from yesterday in a sessions directory", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);
		const fileName = `${dateStr}T03:00:00.000Z.jsonl`;

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName,
			exchanges: [
				{ role: "user", text: "Fix the bug" },
				{ role: "assistant", text: "Looking at it now" },
				{ role: "user", text: "No, wrong file" },
				{ role: "assistant", text: "Let me check again" },
			],
		}]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result.sessionCount, 1);
		assert.equal(result.includedCount, 1);
		assert.ok(result.transcripts.includes("Fix the bug"));
		assert.ok(result.transcripts.includes("wrong file"));
	});

	it("ignores sessions from wrong dates", async () => {
		// Create a session from 10 days ago — should be ignored with lookbackDays=1
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 10);
		const dateStr = oldDate.toISOString().slice(0, 10);
		const fileName = `${dateStr}T03:00:00.000Z.jsonl`;

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName,
			exchanges: [
				{ role: "user", text: "Old message" },
				{ role: "assistant", text: "Old reply" },
				{ role: "user", text: "Old followup" },
				{ role: "assistant", text: "Old reply 2" },
			],
		}]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result.includedCount, 0);
	});

	it("skips sessions with fewer than 3 exchanges", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName: `${dateStr}T03:00:00.000Z.jsonl`,
			exchanges: [
				{ role: "user", text: "Hi" },
				{ role: "assistant", text: "Hello" },
			],
		}]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		// Scanned but not included
		assert.equal(result.sessionCount, 1);
		assert.equal(result.includedCount, 0);
	});

	it("skips sessions with 0 user messages", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName: `${dateStr}T03:00:00.000Z.jsonl`,
			exchanges: [
				{ role: "assistant", text: "I am talking to myself" },
				{ role: "assistant", text: "Still talking" },
				{ role: "assistant", text: "Echo echo" },
				{ role: "assistant", text: "Four messages, no user" },
			],
		}]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result.includedCount, 0);
	});

	it("respects maxBytes budget", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		// Create two sessions
		const sessionsDir = createSessionFixture(tmpDir, [
			{
				projectDirName: "project-a",
				fileName: `${dateStr}T03:00:00.000Z.jsonl`,
				exchanges: [
					{ role: "user", text: "A".repeat(500) },
					{ role: "assistant", text: "B".repeat(500) },
					{ role: "user", text: "C".repeat(500) },
					{ role: "assistant", text: "D".repeat(500) },
				],
			},
			{
				projectDirName: "project-b",
				fileName: `${dateStr}T04:00:00.000Z.jsonl`,
				exchanges: [
					{ role: "user", text: "E".repeat(500) },
					{ role: "assistant", text: "F".repeat(500) },
					{ role: "user", text: "G".repeat(500) },
					{ role: "assistant", text: "H".repeat(500) },
				],
			},
		]);

		// Very small budget — should only include one session
		const result = await collectTranscripts(1, 500, sessionsDir);
		assert.ok(result.includedCount <= 1, `Expected at most 1 included, got ${result.includedCount}`);
	});

	it("skips var-folders directories", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		const sessionsDir = path.join(tmpDir, "sessions");
		const varDir = path.join(sessionsDir, "var-folders-something");
		fs.mkdirSync(varDir, { recursive: true });
		fs.writeFileSync(
			path.join(varDir, `${dateStr}T03:00:00.000Z.jsonl`),
			buildSessionJsonl([
				{ role: "user", text: "Should be skipped" },
				{ role: "assistant", text: "Yep" },
				{ role: "user", text: "Definitely" },
				{ role: "assistant", text: "Agreed" },
			]),
		);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result.includedCount, 0);
	});

	it("returns empty for nonexistent sessions directory", async () => {
		const result = await collectTranscripts(1, 1024 * 1024, "/nonexistent/sessions");
		assert.equal(result.transcripts, "");
		assert.equal(result.sessionCount, 0);
		assert.equal(result.includedCount, 0);
	});

	it("prioritizes sessions by interaction density", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		const sessionsDir = createSessionFixture(tmpDir, [
			{
				// Low density: 1 user message, 5 total exchanges
				projectDirName: "low-density",
				fileName: `${dateStr}T01:00:00.000Z.jsonl`,
				exchanges: [
					{ role: "user", text: "LOW_DENSITY_MARKER" },
					{ role: "assistant", text: "Response 1" },
					{ role: "assistant", text: "Response 2" },
					{ role: "assistant", text: "Response 3" },
					{ role: "assistant", text: "Response 4" },
				],
			},
			{
				// High density: 3 user messages, 6 total exchanges (50% user)
				projectDirName: "high-density",
				fileName: `${dateStr}T02:00:00.000Z.jsonl`,
				exchanges: [
					{ role: "user", text: "HIGH_DENSITY_MARKER" },
					{ role: "assistant", text: "Reply 1" },
					{ role: "user", text: "No, wrong" },
					{ role: "assistant", text: "Reply 2" },
					{ role: "user", text: "Still wrong" },
					{ role: "assistant", text: "Reply 3" },
				],
			},
		]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result.includedCount, 2);
		// High density should come first in the output
		const highIdx = result.transcripts.indexOf("HIGH_DENSITY_MARKER");
		const lowIdx = result.transcripts.indexOf("LOW_DENSITY_MARKER");
		assert.ok(highIdx < lowIdx, "High-density session should appear before low-density");
	});

	it("includes header with stats", async () => {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		const dateStr = yesterday.toISOString().slice(0, 10);

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName: `${dateStr}T03:00:00.000Z.jsonl`,
			exchanges: [
				{ role: "user", text: "Q1" },
				{ role: "assistant", text: "A1" },
				{ role: "user", text: "Q2" },
				{ role: "assistant", text: "A2" },
			],
		}]);

		const result = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.ok(result.transcripts.startsWith("# Session Transcripts\n"));
		assert.ok(result.transcripts.includes("Sessions scanned: 1"));
		assert.ok(result.transcripts.includes("1 included"));
	});

	it("handles lookbackDays > 1", async () => {
		const twoDaysAgo = new Date();
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const dateStr = twoDaysAgo.toISOString().slice(0, 10);

		const sessionsDir = createSessionFixture(tmpDir, [{
			projectDirName: "test-project",
			fileName: `${dateStr}T03:00:00.000Z.jsonl`,
			exchanges: [
				{ role: "user", text: "Two days ago" },
				{ role: "assistant", text: "Reply" },
				{ role: "user", text: "Follow up" },
				{ role: "assistant", text: "Reply 2" },
			],
		}]);

		// lookbackDays=1 should miss it
		const result1 = await collectTranscripts(1, 1024 * 1024, sessionsDir);
		assert.equal(result1.includedCount, 0);

		// lookbackDays=3 should find it
		const result3 = await collectTranscripts(3, 1024 * 1024, sessionsDir);
		assert.equal(result3.includedCount, 1);
	});
});
