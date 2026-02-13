import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyEdits, type AnalysisEdit } from "../extensions/reflect.js";
import { SAMPLE_AGENTS_MD } from "./helpers.js";

/**
 * Tests that simulate realistic LLM-generated edit payloads against AGENTS.md.
 * These are the exact patterns the extension encounters in production.
 */

describe("realistic LLM edit patterns", () => {
	it("strengthens a rule with added emphasis and examples", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			section: "Read Before Acting",
			old_text: "- **ALWAYS read existing code before writing any code**. The #1 source of rework is acting before understanding.",
			new_text: '- **ALWAYS read existing code before writing any code**. The #1 source of rework is acting before understanding. If a file, doc, or plan is referenced — read it completely first. If a bug is reported — read the logs first.',
			reason: "Agent repeatedly started implementing before reading existing code in 5 sessions",
		}];
		const { result, applied } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("read the logs first"));
		// Ensure no duplication of the original rule
		const matches = result.match(/ALWAYS read existing code/g);
		assert.equal(matches?.length, 1);
	});

	it("adds a new rule after an existing one", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			section: "Rules",
			after_text: '- **ANTI-OVER-ENGINEERING**: Implement EXACTLY what was asked for. Do NOT add "helpful" additional complexity.',
			new_text: '- **3-Attempt Rule**: If a fix fails 3 times, STOP. Try a fundamentally different approach or ask the user.',
			reason: "Agent spiraled into 5+ attempts on the same approach in multiple sessions",
		}];
		const { result, applied } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("3-Attempt Rule"));
		// Verify ordering
		const overEngIdx = result.indexOf("ANTI-OVER-ENGINEERING");
		const newIdx = result.indexOf("3-Attempt Rule");
		assert.ok(newIdx > overEngIdx);
	});

	it("handles a batch of mixed edits like a real LLM response", () => {
		const edits: AnalysisEdit[] = [
			{
				type: "strengthen",
				section: "Communication Style",
				old_text: "- Avoid excessive enthusiasm or positivity",
				new_text: '- Avoid excessive enthusiasm or positivity. When the user says "continue", that means get on with the work.',
			},
			{
				type: "add",
				section: "Read Before Acting",
				after_text: "- **Verify assumptions**: Before implementing, verify that variable names, function signatures, file paths actually exist.",
				new_text: "- **Read recent commits when debugging**: ALWAYS run `git log --oneline -10` before diagnosing issues. The user expects you to know what changed recently.",
			},
			{
				type: "strengthen",
				section: "Rules",
				old_text: '- **Don\'t ask clarifying questions when the directive is clear**: If the user gives a specific command, execute it.',
				new_text: '- **Don\'t ask clarifying questions when the directive is clear**: If the user gives a specific command, execute it. Don\'t present multiple-choice options when a single obvious action exists.',
			},
		];
		const { result, applied, skipped } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 3);
		assert.equal(skipped.length, 0);
		assert.ok(result.includes("get on with the work"));
		assert.ok(result.includes("git log --oneline -10"));
		assert.ok(result.includes("multiple-choice options"));
	});

	it("rejects an edit that would create duplication (old_text > 50 chars)", () => {
		// Simulates an LLM that accidentally repeats the old content in the replacement
		// The duplication check only triggers when old_text > 50 chars
		const longRule = "- **ALWAYS read existing code before writing any code**. The #1 source of rework is acting before understanding.";
		const content = `## Rules\n\n${longRule}\n- **Other rule**: Do Y.\n`;
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: longRule,
			new_text: longRule + " " + longRule, // obvious duplication
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Duplication"));
	});

	it("does not catch duplication when old_text < 50 chars (by design)", () => {
		// Short old_text bypasses the duplication check — this is expected behavior
		// because short snippets appearing twice is less likely to be a real problem
		const content = "## Rules\n\n- **Rule A**: Do X.\n- **Rule B**: Do Y.\n";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule A**: Do X.",
			new_text: "- **Rule A**: Do X. - **Rule A**: Do X.", // duplicated but short
		}];
		const { applied } = applyEdits(content, edits);
		assert.equal(applied, 1); // passes because < 50 chars
	});

	it("handles real-world multiline bullet points", () => {
		const content = [
			"## Rules",
			"- **NEVER push to main/master**: Pushing to main triggers production deployment.",
			"  Only the user pushes. Agents may commit on branches, build artifacts.",
			"- **Keep code DRY**: NEVER duplicate logic.",
		].join("\n");

		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **NEVER push to main/master**: Pushing to main triggers production deployment.\n  Only the user pushes. Agents may commit on branches, build artifacts.",
			new_text: "- **NEVER push to main/master**: Pushing to main triggers production deployment.\n  Only the user pushes. Agents may commit on branches, build artifacts.\n  Even if the user's instructions seem to imply pushing, stop and confirm first.",
		}];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("stop and confirm first"));
	});

	it("preserves file structure when adding at the end of a section", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- **Deploy by pushing to main/master**: All deployments happen automatically via CI/CD.",
			new_text: "- **Verify deployment completion**: After pushing, check logs to confirm the deploy succeeded.",
		}];
		const { result, applied } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied, 1);
		// The new rule should be the last line (after Deployment section's last rule)
		assert.ok(result.includes("Verify deployment completion"));
	});

	it("idempotent: running the same add edit twice fails on second run (dedup)", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- **Keep code DRY**: NEVER duplicate logic.",
			new_text: "- **New rule**: Something new.",
		}];

		// First application
		const { result: result1, applied: applied1 } = applyEdits(SAMPLE_AGENTS_MD, edits);
		assert.equal(applied1, 1);

		// Second application on the modified content
		const { applied: applied2, skipped: skipped2 } = applyEdits(result1, edits);
		assert.equal(applied2, 0);
		assert.ok(skipped2[0].includes("already exists"));
	});

	it("handles edits with special markdown characters", () => {
		const content = '- **Use `backticks` for code**: Always wrap code in backticks.\n- Other rule.';
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: '- **Use `backticks` for code**: Always wrap code in backticks.',
			new_text: '- **Use `backticks` for code**: Always wrap code in backticks. Use triple backticks for multi-line blocks.',
		}];
		const { applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
	});

	it("handles edits near markdown headers", () => {
		const content = "## Section A\n\n- Rule under A.\n\n## Section B\n\n- Rule under B.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule under A.",
			new_text: "- New rule under A.",
		}];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
		// Verify the new rule is between Section A and Section B
		const ruleIdx = result.indexOf("New rule under A.");
		const sectionBIdx = result.indexOf("## Section B");
		assert.ok(ruleIdx < sectionBIdx);
	});
});

describe("edge cases in edit content", () => {
	it("handles old_text that is a substring of another rule", () => {
		// Two rules where one is a prefix of the other
		const content = "- **Rule**: Short.\n- **Rule**: Short. But also long with extra text.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule**: Short.",
			new_text: "- **Rule**: Short, improved.",
		}];
		// "- **Rule**: Short." appears in both lines, so this should be ambiguous
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Ambiguous"));
	});

	it("handles new_text with trailing newlines", () => {
		const content = "- Rule A.\n- Rule B.";
		const edits: AnalysisEdit[] = [{
			type: "add",
			after_text: "- Rule A.",
			new_text: "- New rule.\n",
		}];
		const { result, applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
		// Should not create triple newlines
		assert.ok(!result.includes("\n\n\n"));
	});

	it("handles unicode in edit text", () => {
		const content = "- **Rule**: Use → arrows and • bullets.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Rule**: Use → arrows and • bullets.",
			new_text: "- **Rule**: Use → arrows, • bullets, and — dashes.",
		}];
		const { applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
	});

	it("handles very long edit text (>1000 chars)", () => {
		const longRule = "- **Long rule**: " + "word ".repeat(200);
		const content = longRule + "\n- Short rule.";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: longRule,
			new_text: longRule + " Plus more words at the end.",
		}];
		const { applied } = applyEdits(content, edits);
		assert.equal(applied, 1);
	});
});
