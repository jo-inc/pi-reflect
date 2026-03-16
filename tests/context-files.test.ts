import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectContext } from "../extensions/reflect.js";
import { cleanup, makeTempDir } from "./helpers.js";

describe("collectContext file sources", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("finds matching files in nested subdirectories for a filetype glob", async () => {
		fs.mkdirSync(path.join(tmpDir, "nested", "deeper"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "top.md"), "top-level note", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "nested", "deeper", "child.md"), "nested note", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "nested", "deeper", "ignore.txt"), "ignore me", "utf-8");

		const context = await collectContext([
			{ type: "files", label: "notes", paths: [path.join(tmpDir, "*.md")] },
		], 1);

		assert.match(context, /### top\.md\ntop-level note/);
		assert.match(context, /### nested\/deeper\/child\.md\nnested note/);
		assert.doesNotMatch(context, /ignore me/);
	});

	it("supports explicit recursive glob patterns", async () => {
		fs.mkdirSync(path.join(tmpDir, "a", "b"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "root.md"), "root file", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "a", "b", "deep.md"), "deep file", "utf-8");

		const context = await collectContext([
			{ type: "files", label: "notes", paths: [path.join(tmpDir, "**", "*.md")] },
		], 1);

		assert.match(context, /### root\.md\nroot file/);
		assert.match(context, /### a\/b\/deep\.md\ndeep file/);
	});

	it("prunes nested dated files outside the lookback window", async () => {
		fs.mkdirSync(path.join(tmpDir, "archive"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "archive", "2000-01-01-old.md"), "old note", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "archive", "2099-01-01-new.md"), "new note", "utf-8");

		const context = await collectContext([
			{ type: "files", label: "dated", paths: [path.join(tmpDir, "*.md")] },
		], 1);

		assert.match(context, /2099-01-01-new\.md\nnew note/);
		assert.doesNotMatch(context, /2000-01-01-old\.md\nold note/);
	});
});
