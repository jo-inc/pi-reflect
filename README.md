<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png" width="300">
    <img src="logo.png" alt="pi-reflect" width="300">
  </picture>
</p>

# pi-reflect

Self-improving behavioral files for [pi](https://github.com/badlogic/pi-mono) coding agents.

You correct your agent. Reflect reads those corrections from your session transcripts and surgically edits your `AGENTS.md` (or any markdown file) so the agent stops repeating the same mistakes.

**you correct the agent → reflect strengthens the rules → the agent stops making that mistake.**

## Install

```bash
pi install git:github.com/skyfallsin/pi-reflect
```

Requires pi with an LLM API key configured. Each run makes one LLM call (~$0.05–0.15 with Sonnet).

## Usage

```
/reflect ./AGENTS.md        # run reflection on a file
/reflect                    # use saved default target
/reflect-config             # show configured targets
/reflect-history            # show recent runs
/reflect-stats              # correction rate trend + rule recidivism
/reflect-backfill           # bootstrap stats for all historical sessions
```

First run asks if you want to save the target. After that, just `/reflect`.

## What it does

1. Extracts recent pi session transcripts (default: last 24 hours)
2. Sends them + your target file to an LLM to find correction patterns — redirections, frustration, repeated explanations
3. Applies surgical edits: strengthens violated rules, adds new rules for recurring patterns (2+ occurrences only)
4. Backs up the original before any changes. Skips ambiguous matches, duplicates, and suspiciously large deletions. Auto-commits if the target is symlinked into a git repo.

## Impact Metrics

`/reflect-stats` tracks two signals to measure whether reflection is working:

- **Correction Rate** — `corrections / sessions` per run, plotted over time. Trending down = the agent is making fewer mistakes. Each data point uses the **source date** (when the sessions happened), not when reflect ran.

- **Rule Recidivism** — which sections get edited repeatedly. A rule strengthened 3+ times means it isn't sticking. Sections edited once and never again are "resolved."

Both metrics are grouped by target file.

`/reflect-backfill` bootstraps stats by analyzing all historical session dates in dry-run mode (no file edits). Shows estimated cost and asks for confirmation before running.

## Configuration

`~/.pi/agent/reflect.json` — created automatically or edit manually:

```json
{
  "targets": [{
    "path": "/path/to/AGENTS.md",
    "model": "anthropic/claude-sonnet-4-5",
    "lookbackDays": 1,
    "maxSessionBytes": 614400,
    "backupDir": "~/.pi/agent/reflect-backups",
    "transcriptSource": { "type": "pi-sessions" }
  }]
}
```

Set `transcriptSource` to `{ "type": "command", "command": "your-script {lookbackDays}" }` for non-pi transcripts.

## Scheduling

```bash
pi -p --no-session "/reflect /path/to/AGENTS.md"
```

Works with cron, launchd, or any scheduler. Ask your pi to set it up for you — there's a [setup guide for agents](SETUP.md).

## Development

```bash
git clone https://github.com/skyfallsin/pi-reflect && cd pi-reflect
npm install && npm test   # 137 tests
pi -e ./extensions/index.ts   # test locally without installing
```

## License

MIT
