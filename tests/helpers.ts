/**
 * Test helpers — temp directories, fixture builders, mock sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-reflect-test-"));
}

export function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a JSONL session file from a simple exchange list.
 * Each exchange is { role, text?, thinking? }.
 */
export function buildSessionJsonl(exchanges: Array<{ role: string; text?: string; thinking?: string }>): string {
	const lines: string[] = [];
	for (const ex of exchanges) {
		const content: any[] = [];
		if (ex.text) content.push({ type: "text", text: ex.text });
		if (ex.thinking) content.push({ type: "thinking", thinking: ex.thinking });
		lines.push(JSON.stringify({
			type: "message",
			message: { role: ex.role, content },
		}));
	}
	return lines.join("\n") + "\n";
}

/**
 * Create a fake sessions directory structure for collectTranscripts testing.
 * Returns the sessions dir path.
 *
 *   sessionsDir/
 *     --Users-<user>-project-name/
 *       2026-02-12T03:00:00.000Z.jsonl
 */
export function createSessionFixture(
	baseDir: string,
	opts: {
		projectDirName: string;
		fileName: string;
		exchanges: Array<{ role: string; text?: string; thinking?: string }>;
	}[],
): string {
	const sessionsDir = path.join(baseDir, "sessions");
	for (const opt of opts) {
		const projectDir = path.join(sessionsDir, opt.projectDirName);
		fs.mkdirSync(projectDir, { recursive: true });
		const content = buildSessionJsonl(opt.exchanges);
		fs.writeFileSync(path.join(projectDir, opt.fileName), content, "utf-8");
	}
	return sessionsDir;
}

/**
 * A realistic AGENTS.md fixture for edit testing.
 */
export const SAMPLE_AGENTS_MD = `# Agent Guide

## Communication Style
- Maintain a professional demeanor
- Avoid excessive enthusiasm or positivity

## Read Before Acting
- **ALWAYS read existing code before writing any code**. The #1 source of rework is acting before understanding.
- **Check if functionality already exists**: Before implementing, search docs/code/examples first.
- **Verify assumptions**: Before implementing, verify that variable names, function signatures, file paths actually exist.

## Rules
- **Execute first, explain minimally**: Do the work, then say what you did in 1-2 sentences.
- **Don't ask clarifying questions when the directive is clear**: If the user gives a specific command, execute it.
- **ANTI-OVER-ENGINEERING**: Implement EXACTLY what was asked for. Do NOT add "helpful" additional complexity.
- **Keep code DRY**: NEVER duplicate logic.

## Deployment
- **NEVER push to main/master**: Pushing to main triggers production deployment.
- **Deploy by pushing to main/master**: All deployments happen automatically via CI/CD.
`;
