import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { collectTranscriptsFromCommand } from "../extensions/reflect.js";

describe("collectTranscriptsFromCommand", () => {
	it("executes a command and returns its output", async () => {
		const result = await collectTranscriptsFromCommand("echo 'hello world'", 1, 1024 * 1024);
		assert.ok(result.transcripts.includes("hello world"));
		assert.equal(result.sessionCount, 1); // no ### Session: headers, defaults to 1
		assert.equal(result.includedCount, 1);
	});

	it("interpolates {lookbackDays} in command", async () => {
		const result = await collectTranscriptsFromCommand("echo 'days={lookbackDays}'", 7, 1024 * 1024);
		assert.ok(result.transcripts.includes("days=7"));
	});

	it("interpolates multiple {lookbackDays} occurrences", async () => {
		const result = await collectTranscriptsFromCommand("echo '{lookbackDays} and {lookbackDays}'", 3, 1024 * 1024);
		assert.ok(result.transcripts.includes("3 and 3"));
	});

	it("counts ### Session: headers for session count", async () => {
		const multiSession = "echo '### Session: one\\n### Session: two\\n### Session: three'";
		const result = await collectTranscriptsFromCommand(multiSession, 1, 1024 * 1024);
		assert.equal(result.sessionCount, 3);
	});

	it("truncates output exceeding maxBytes", async () => {
		// maxBytes=500, maxBuffer=1000. Command outputs 800 bytes (> maxBytes but < maxBuffer).
		// Output should succeed but get truncated to 500 + truncation message.
		const result = await collectTranscriptsFromCommand(
			"printf '%0800d' 0",
			1,
			500,
		);
		assert.ok(result.transcripts.length > 500, `Expected > 500 bytes, got ${result.transcripts.length}`);
		assert.ok(result.transcripts.length < 800, `Expected < 800 bytes (trimmed), got ${result.transcripts.length}`);
		assert.ok(result.transcripts.includes("[...truncated"));
	});

	it("returns empty on command failure", async () => {
		const result = await collectTranscriptsFromCommand("false", 1, 1024);
		assert.equal(result.transcripts, "");
		assert.equal(result.sessionCount, 0);
		assert.equal(result.includedCount, 0);
	});

	it("returns empty on nonexistent command", async () => {
		const result = await collectTranscriptsFromCommand("nonexistent_command_xyz_123", 1, 1024);
		assert.equal(result.transcripts, "");
		assert.equal(result.sessionCount, 0);
	});
});
