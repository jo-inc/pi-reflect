import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyEdits, findProtectedRanges, buildReflectionPrompt, type AnalysisEdit } from "../extensions/reflect.js";

const PROTECTED_RULE = "Use concise updates; distinguish facts, proposals, and unknowns; correct mistakes plainly.";
const PLAIN_RULE = "Write every reply in plain language: say what is true now and what it means for the user first.";
const EXAMPLES = "Examples from real sessions:\n- Bad: \"343 tests passed; HTTP 503.\" Good: \"It's still not fixed.\"";
const OPEN_RULE = "- Always read the file before editing it.";

const FILE = [
	"# Guide",
	"",
	"Intro paragraph.",
	"",
	"## BEHAVIORAL REQUIREMENTS [DO NOT EDIT AS PART OF REFLECTION]",
	"Act on the agreed scope without repeated confirmation.",
	"",
	PROTECTED_RULE,
	"",
	PLAIN_RULE,
	"",
	EXAMPLES,
	"",
	"## Open section",
	OPEN_RULE,
	"- Never use git add -A.",
	"",
	"### Sub",
	"- A nested open rule.",
	"",
].join("\n");

describe("findProtectedRanges", () => {
	it("finds a DO NOT EDIT heading section and stops at the next same-level heading", () => {
		const ranges = findProtectedRanges(FILE);
		assert.equal(ranges.length, 1);
		assert.ok(ranges[0].text.startsWith("## BEHAVIORAL REQUIREMENTS"));
		assert.ok(ranges[0].text.includes(EXAMPLES));
		assert.ok(!ranges[0].text.includes("## Open section"));
	});

	it("includes nested lower-level headings inside the protected section", () => {
		const content = "## Rules [DO NOT EDIT]\n- a\n### Detail\n- b\n## Next\n- c\n";
		const ranges = findProtectedRanges(content);
		assert.equal(ranges.length, 1);
		assert.ok(ranges[0].text.includes("### Detail\n- b"));
		assert.ok(!ranges[0].text.includes("## Next"));
	});

	it("finds comment-delimited protected blocks", () => {
		const content = "- open\n<!-- reflect:protected -->\n- locked\n<!-- /reflect:protected -->\n- open2\n";
		const ranges = findProtectedRanges(content);
		assert.equal(ranges.length, 1);
		assert.ok(ranges[0].text.includes("- locked"));
	});

	it("returns nothing when no markers exist", () => {
		assert.deepEqual(findProtectedRanges("## A\n- x\n## B\n- y\n"), []);
	});
});

describe("applyEdits protected sections", () => {
	it("refuses to strengthen a protected rule", () => {
		const edits: AnalysisEdit[] = [{ type: "strengthen", old_text: PLAIN_RULE, new_text: "Be plain.", reason: "shorter" }];
		const { result, applied, skipped } = applyEdits(FILE, edits);
		assert.equal(applied, 0);
		assert.equal(result, FILE);
		assert.ok(skipped[0].includes("protected section"));
	});

	it("refuses to remove protected examples", () => {
		const edits: AnalysisEdit[] = [{ type: "remove", old_text: EXAMPLES, new_text: "", reason: "verbose" }];
		const { result, applied } = applyEdits(FILE, edits);
		assert.equal(applied, 0);
		assert.equal(result, FILE);
	});

	it("refuses to merge a protected rule with an open one", () => {
		const edits: AnalysisEdit[] = [{
			type: "merge",
			merge_sources: [PROTECTED_RULE, OPEN_RULE],
			new_text: "Be concise and read files first.",
			reason: "overlap",
		}];
		const { result, applied } = applyEdits(FILE, edits);
		assert.equal(applied, 0);
		assert.equal(result, FILE);
	});

	it("refuses to add inside a protected section", () => {
		const edits: AnalysisEdit[] = [{ type: "add", after_text: PLAIN_RULE, new_text: "New rule.", reason: "new" }];
		const { result, applied } = applyEdits(FILE, edits);
		assert.equal(applied, 0);
		assert.equal(result, FILE);
	});

	it("refuses to replace the protected heading itself", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "## BEHAVIORAL REQUIREMENTS [DO NOT EDIT AS PART OF REFLECTION]",
			new_text: "## Behavioral requirements",
			reason: "tidy",
		}];
		const { applied, result } = applyEdits(FILE, edits);
		assert.equal(applied, 0);
		assert.equal(result, FILE);
	});

	it("still applies edits in open sections and keeps protected text byte-identical", () => {
		const edits: AnalysisEdit[] = [
			{ type: "strengthen", old_text: OPEN_RULE, new_text: "- Read the file first.", reason: "shorter" },
			{ type: "add", after_text: "- Never use git add -A.", new_text: "- Stage files by name.", reason: "new" },
			{ type: "remove", old_text: "- A nested open rule.", new_text: "", reason: "obsolete" },
		];
		const { result, applied, skipped } = applyEdits(FILE, edits);
		assert.equal(applied, 3);
		assert.equal(skipped.length, 0);
		const protectedBefore = findProtectedRanges(FILE)[0].text;
		assert.ok(result.includes(protectedBefore));
		assert.ok(result.includes("- Read the file first."));
		assert.ok(result.includes("- Stage files by name."));
		assert.ok(!result.includes("- A nested open rule."));
	});

	it("replays the 2026-10-11 run: condensing the plain-language rule and removing the examples is rejected", () => {
		const edits: AnalysisEdit[] = [
			{
				type: "merge",
				merge_sources: [PROTECTED_RULE, PLAIN_RULE],
				new_text: "State facts plainly; treat \"plainspeak\" as a correction.",
				reason: "Condensed overlapping concise/plain-language requirements",
			},
			{ type: "remove", old_text: EXAMPLES, new_text: "", reason: "Removed lengthy plainspeak examples" },
			{ type: "strengthen", old_text: OPEN_RULE, new_text: "- Read the file first.", reason: "unrelated open edit" },
		];
		const { result, applied, skipped } = applyEdits(FILE, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 2);
		assert.ok(result.includes(PLAIN_RULE));
		assert.ok(result.includes(EXAMPLES));
		assert.ok(result.includes(PROTECTED_RULE));
	});

	it("works with a comment-delimited block too", () => {
		const content = "- open\n<!-- reflect:protected -->\n- locked\n<!-- /reflect:protected -->\n- open2\n";
		const { result, applied } = applyEdits(content, [
			{ type: "remove", old_text: "- locked", new_text: "", reason: "x" },
			{ type: "strengthen", old_text: "- open2", new_text: "- open two", reason: "y" },
		]);
		assert.equal(applied, 1);
		assert.ok(result.includes("- locked"));
		assert.ok(result.includes("- open two"));
	});
});

describe("prompt", () => {
	it("tells the model that DO NOT EDIT sections are read-only", () => {
		const prompt = buildReflectionPrompt("/x/AGENTS.md", FILE, "transcripts");
		assert.ok(prompt.includes("DO NOT EDIT"));
		assert.ok(prompt.includes("READ-ONLY"));
	});
});
