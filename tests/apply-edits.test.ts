import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyEdits, type AnalysisEdit } from "../extensions/reflect.js";
import { SAMPLE_AGENTS_MD } from "./helpers.js";

describe("applyEdits", () => {
	// --- strengthen ---

	it("applies a basic strengthen edit", () => {
		const content = "- **Rule one**: Do the thing.\n- **Rule two**: Do another thing.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule one**: Do the thing.",
			new_text: "- **Rule one** (CRITICAL): Do the thing immediately and without hesitation.",
		}];
		const { result, applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 0);
		assert.ok(result.includes("(CRITICAL): Do the thing immediately"));
		assert.ok(!result.includes("Do the thing."));
		assert.ok(result.includes("- **Rule two**: Do another thing."));
	});

	it("skips strengthen when old_text not found", () => {
		const content = "- **Rule one**: Do the thing.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule one**: Do something completely different.",
			new_text: "- **Rule one**: Replacement.",
		}];
		const { result, applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Could not find"));
		assert.equal(result, content);
	});

	it("skips strengthen when old_text appears multiple times (ambiguous)", () => {
		const content = "- Do the thing.\n- Do the thing.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- Do the thing.",
			new_text: "- Do the thing better.",
		}];
		const { result, applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Ambiguous"));
		assert.equal(result, content);
	});

	it("detects duplication in replacement text", () => {
		// old_text is >50 chars, and new_text contains the first 50 chars twice
		const oldText = "- **ALWAYS read existing code before writing any code**. The #1 source of rework is acting before understanding.";
		const newText = oldText + " " + oldText; // obvious duplication
		const content = `# Rules\n${oldText}\n- Other rule.`;
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: oldText,
			new_text: newText,
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Duplication"));
	});

	it("allows strengthen when old_text < 50 chars (skips duplication check)", () => {
		const content = "- Short rule here.\n- Another rule.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- Short rule here.",
			new_text: "- Short rule here, but stronger.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 0);
	});

	it("applies strengthen on the realistic AGENTS.md fixture", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: '- **Execute first, explain minimally**: Do the work, then say what you did in 1-2 sentences.',
			new_text: '- **Execute first, explain minimally**: Do the work, then say what you did in 1-2 sentences. Skip "Let me explain..." and "Here\'s what I\'ll do..." intros — just do it.',
		}];
		const { result, applied } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes('Skip "Let me explain..."'));
		// Original rule is replaced, not duplicated
		const count = (result.match(/Execute first, explain minimally/g) || []).length;
		assert.equal(count, 1);
	});

	// --- add ---

	it("applies a basic add edit", () => {
		const content = "- Rule A.\n- Rule B.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule A.",
			new_text: "- Rule A-prime: A new rule inserted after A.",
		}];
		const { result, applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 0);
		const lines = result.split("\n");
		assert.equal(lines[0], "- Rule A.");
		assert.equal(lines[1], "- Rule A-prime: A new rule inserted after A.");
		assert.equal(lines[2], "- Rule B.");
	});

	it("skips add when after_text not found", () => {
		const content = "- Rule A.\n- Rule B.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Nonexistent rule.",
			new_text: "- New rule.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Could not find insertion point"));
	});

	it("skips add when after_text is ambiguous", () => {
		const content = "- Same rule.\n- Other stuff.\n- Same rule.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Same rule.",
			new_text: "- New rule.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Ambiguous"));
	});

	it("skips add when new_text already exists in file (dedup)", () => {
		const content = "- Rule A.\n- Rule B.\n- Already here.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule A.",
			new_text: "- Already here.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("already exists"));
	});

	it("dedup check trims whitespace before comparing", () => {
		const content = "- Rule A.\n- Rule B.\n- Already here.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule A.",
			new_text: "  - Already here.  ",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("already exists"));
	});

	it("adds to realistic AGENTS.md fixture", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- **Keep code DRY**: NEVER duplicate logic.",
			new_text: '- **Check recent git commits when debugging**: ALWAYS run `git log --oneline -10` before diagnosing issues.',
		}];
		const { result, applied } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("Check recent git commits"));
		// Verify it's after the DRY rule
		const dryIdx = result.indexOf("Keep code DRY");
		const newIdx = result.indexOf("Check recent git commits");
		assert.ok(newIdx > dryIdx);
	});

	// --- multiple edits ---

	it("applies multiple edits in sequence", () => {
		const edits: AnalysisEdit[] = [
			{
				type: "strengthen",
				old_text: "- **Keep code DRY**: NEVER duplicate logic.",
				new_text: "- **Keep code DRY (CRITICAL)**: NEVER duplicate logic. If two call sites need different behavior, add parameters.",
			},
			{
				type: "add",
				after_text: "- **NEVER push to main/master**: Pushing to main triggers production deployment.",
				new_text: "- **Never deploy without explicit instruction**: Commit changes and report ready — user decides when to push.",
			},
		];
		const { result, applied, skipped } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 2);
		assert.equal(skipped.length, 0);
		assert.ok(result.includes("Keep code DRY (CRITICAL)"));
		assert.ok(result.includes("Never deploy without explicit instruction"));
	});

	it("later edits see results of earlier edits (sequential application)", () => {
		const content = "- Rule A: original.\n- Rule B: original.";
		const edits: AnalysisEdit[] = [
			{
				type: "strengthen",
				old_text: "- Rule A: original.",
				new_text: "- Rule A: modified.",
			},
			{
				type: "add",
				after_text: "- Rule A: modified.",
				new_text: "- Rule A-bis: added after modified A.",
			},
		];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 2);
		assert.ok(result.includes("Rule A: modified."));
		assert.ok(result.includes("Rule A-bis: added after modified A."));
	});

	it("partial success: some edits apply, some skip", () => {
		const content = "- Real rule.\n- Other rule.";
		const edits: AnalysisEdit[] = [
			{
				type: "strengthen",
				old_text: "- Real rule.",
				new_text: "- Real rule, now stronger.",
			},
			{
				type: "strengthen",
				old_text: "- Ghost rule that does not exist.",
				new_text: "- This should not apply.",
			},
		];
		const { result, applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 1);
		assert.ok(result.includes("now stronger"));
		assert.ok(!result.includes("should not apply"));
	});

	// --- invalid edits ---

	it("skips edit with missing type", () => {
		const content = "- Rule.";
		const edits = [{ new_text: "- Replacement." }] as any;
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Invalid edit"));
	});

	it("skips strengthen with null old_text", () => {
		const content = "- Rule.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: null,
			new_text: "- Replacement.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
	});

	it("skips add with null after_text", () => {
		const content = "- Rule.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: null,
			new_text: "- New rule.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
	});

	it("skips add with empty new_text", () => {
		const content = "- Rule.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule.",
			new_text: "",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
	});

	// --- edge cases ---

	it("handles empty edits array", () => {
		const content = "- Rule.";
		const { result, applied, skipped } = applyEdits(content, []);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 0);
		assert.equal(result, content);
	});

	it("handles empty content", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- Rule.",
			new_text: "- Better rule.",
		}];
		const { applied, skipped } = applyEdits("", edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
	});

	it("preserves content before and after the edit region exactly", () => {
		const before = "# Header\n\nSome preamble text.\n\n";
		const target = "- **Target rule**: Original wording.";
		const after = "\n\n## Footer\n\nClosing text.";
		const content = before + target + after;
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: target,
			new_text: "- **Target rule**: Improved wording.",
		}];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.ok(result.startsWith(before));
		assert.ok(result.endsWith(after));
		assert.ok(result.includes("Improved wording."));
	});

	it("handles regex special characters in old_text for duplication check", () => {
		// old_text contains chars that are regex-special: ( ) . * + ?
		const oldText = "- **Rule (important)**: Use regex.* patterns? Yes, absolutely. Use $HOME and [brackets].";
		const content = `# Rules\n${oldText}\n- Other.`;
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: oldText,
			new_text: "- **Rule (important, CRITICAL)**: Use regex.* patterns? Yes, absolutely. Use $HOME and [brackets]. Always.",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 0);
	});

	it("handles multiline old_text in strengthen", () => {
		const content = "- **Rule**: Line one.\n  Continuation line.\n- Next rule.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule**: Line one.\n  Continuation line.",
			new_text: "- **Rule**: Line one, improved.\n  Continuation line, also improved.",
		}];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("Line one, improved."));
		assert.ok(result.includes("Continuation line, also improved."));
	});
});
