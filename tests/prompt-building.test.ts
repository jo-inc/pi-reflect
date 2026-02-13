import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildReflectionPrompt } from "../extensions/reflect.js";
import { SAMPLE_AGENTS_MD } from "./helpers.js";

describe("buildReflectionPrompt", () => {
	it("includes the target file name", () => {
		const prompt = buildReflectionPrompt("/path/to/AGENTS.md", SAMPLE_AGENTS_MD, "transcripts here");
		assert.ok(prompt.includes("AGENTS.md"));
	});

	it("includes the target file content in <target_file> tags", () => {
		const prompt = buildReflectionPrompt("/path/to/AGENTS.md", SAMPLE_AGENTS_MD, "transcripts");
		assert.ok(prompt.includes("<target_file>"));
		assert.ok(prompt.includes("</target_file>"));
		assert.ok(prompt.includes("ANTI-OVER-ENGINEERING"));
	});

	it("includes transcripts in <transcripts> tags", () => {
		const transcriptContent = "### Session: project [2026-02-12]\n\n**USER:** fix the bug\n";
		const prompt = buildReflectionPrompt("/AGENTS.md", SAMPLE_AGENTS_MD, transcriptContent);
		assert.ok(prompt.includes("<transcripts>"));
		assert.ok(prompt.includes("</transcripts>"));
		assert.ok(prompt.includes("fix the bug"));
	});

	it("instructs JSON-only output", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("single JSON object"));
		assert.ok(prompt.includes("No markdown, no explanation, no preamble"));
	});

	it("describes the strengthen edit type", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes('"strengthen"'));
		assert.ok(prompt.includes("old_text"));
		assert.ok(prompt.includes("character-for-character"));
	});

	it("describes the add edit type", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes('"add"'));
		assert.ok(prompt.includes("after_text"));
	});

	it("mentions duplication prevention", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("Never duplicate content"));
	});

	it("requires 2+ occurrences for new rules", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("2+ occurrences"));
	});

	it("lists correction signals to look for", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("bro"));
		assert.ok(prompt.includes("wtf"));
		assert.ok(prompt.includes("actually"));
	});

	it("warns about false positives", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("no worries"));
		assert.ok(prompt.includes("NOT corrections"));
	});

	it("uses basename, not full path in prompt", () => {
		const prompt = buildReflectionPrompt("/very/long/path/to/RULES.md", "content", "transcripts");
		assert.ok(prompt.includes("RULES.md"));
		// Should not leak full filesystem path into the prompt
		assert.ok(!prompt.includes("/very/long/path/to/RULES.md") || prompt.includes("Target file: RULES.md"));
	});

	it("includes expected JSON structure with all fields", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes('"corrections_found"'));
		assert.ok(prompt.includes('"sessions_with_corrections"'));
		assert.ok(prompt.includes('"edits"'));
		assert.ok(prompt.includes('"patterns_not_added"'));
		assert.ok(prompt.includes('"summary"'));
		assert.ok(prompt.includes('"reason"'));
	});
});
