/**
 * Reflect — Self-improving behavioral files for pi coding agents.
 *
 * Commands:
 *   /reflect [path]     — Run reflection on a file (or configured default)
 *   /reflect-config     — Show/edit reflection configuration
 *   /reflect-history    — Show recent reflection runs
 *
 * Headless execution for cron/launchd:
 *   pi -p --no-session "/reflect /path/to/AGENTS.md"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

import {
	type ReflectTarget,
	type NotifyFn,
	DEFAULT_TARGET,
	loadConfig,
	saveConfig,
	loadHistory,
	saveHistory,
	resolvePath,
	runReflection,
	CONFIG_FILE,
} from "./reflect.js";

export default function (pi: ExtensionAPI) {
	let modelRegistryRef: any = null;

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
	});

	pi.registerCommand("reflect", {
		description: "Reflect on recent sessions and improve a behavioral markdown file",
		handler: async (args, ctx) => {
			modelRegistryRef = ctx.modelRegistry;
			const targetPath = args?.trim();

			let target: ReflectTarget;

			if (targetPath) {
				const config = loadConfig();
				const existing = config.targets.find(
					(t) => resolvePath(t.path) === resolvePath(targetPath),
				);
				target = existing ?? { ...DEFAULT_TARGET, path: targetPath };
			} else {
				const config = loadConfig();
				if (config.targets.length === 0) {
					if (ctx.hasUI) {
						const filePath = await ctx.ui.input(
							"No targets configured. Enter path to a markdown file to reflect on:",
						);
						if (!filePath) return;
						target = { ...DEFAULT_TARGET, path: filePath };

						const save = await ctx.ui.confirm(
							"Save target?",
							`Save ${filePath} as a reflection target for next time?`,
						);
						if (save) {
							config.targets.push(target);
							saveConfig(config);
							ctx.ui.notify("Saved to reflect.json", "info");
						}
					} else {
						console.error("No targets configured. Use: /reflect <path>");
						return;
					}
				} else if (config.targets.length === 1) {
					target = config.targets[0];
				} else if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Which target?",
						config.targets.map((t) => path.basename(t.path)),
					);
					if (choice === undefined) return;
					target = config.targets[choice];
				} else {
					target = config.targets[0];
				}
			}

			const notify: NotifyFn = ctx.hasUI
				? (msg, level) => ctx.ui.notify(msg, level)
				: (msg, level) => console.log(`[reflect] [${level}] ${msg}`);

			const run = await runReflection(target, modelRegistryRef, notify);

			if (run) {
				const history = loadHistory();
				history.push(run);
				saveHistory(history);
			}
		},
	});

	pi.registerCommand("reflect-config", {
		description: "Show and manage reflection targets",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			if (!ctx.hasUI) {
				console.log(JSON.stringify(config, null, 2));
				return;
			}

			if (config.targets.length === 0) {
				ctx.ui.notify("No targets configured. Use /reflect <path> to add one.", "info");
				return;
			}

			const lines = config.targets.map((t, i) => {
				return `${i + 1}. **${path.basename(t.path)}** — ${t.schedule}, ${t.model}, ${t.lookbackDays}d lookback\n   ${t.path}`;
			});

			ctx.ui.notify(
				`Reflection targets:\n${lines.join("\n")}\n\nEdit: ${CONFIG_FILE}`,
				"info",
			);
		},
	});

	pi.registerCommand("reflect-history", {
		description: "Show recent reflection runs",
		handler: async (_args, ctx) => {
			const history = loadHistory();

			if (history.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("No reflection runs yet. Use /reflect to run one.", "info");
				}
				return;
			}

			const recent = history.slice(-10).reverse();
			const lines = recent.map((r) => {
				const date = r.timestamp.slice(0, 16).replace("T", " ");
				const file = path.basename(r.targetPath);
				return `- **${date}** ${file}: ${r.editsApplied} edits, ${r.correctionsFound} corrections (${r.sessionsAnalyzed} sessions)\n  ${r.summary}`;
			});

			if (ctx.hasUI) {
				ctx.ui.notify(`Recent reflections:\n${lines.join("\n")}`, "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});
}
