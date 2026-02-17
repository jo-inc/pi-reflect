<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png" width="300">
    <img src="logo.png" alt="pi-reflect" width="300">
  </picture>
</p>

# pi-reflect

Iterative self-improvement for [pi](https://github.com/badlogic/pi-mono) coding agents.

Define a target — how your agent should behave, what it should remember, who it should be — and reflect iterates toward it. Each run reads recent conversation transcripts, compares the agent's actual behavior against the target, and makes surgical edits to close the gap.

**define the target → reflect reads conversations → edits the file → the agent gets closer.**

Works on any markdown file: behavioral rules (`AGENTS.md`), long-term memory (`MEMORY.md`), personality (`SOUL.md`), or anything else.

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

## How it works

1. Reads recent conversation transcripts (default: last 24 hours)
2. Sends them + the target file + a prompt describing the desired end state to an LLM
3. The LLM identifies gaps between actual behavior and the target, proposes surgical edits
4. Edits are applied with safety checks: backs up the original, skips ambiguous matches, rejects suspiciously large deletions, auto-commits to git

Over time, the file converges: corrections get absorbed as rules, memory accumulates durable facts, personality sharpens from generic to specific. The agent stops needing the same corrections.

## Prompts define the target

Each target has an optional `prompt` field that tells reflect *what to optimize for*. The same engine drives very different behaviors depending on the prompt:

| Target | Prompt goal | What reflect does |
|--------|------------|-------------------|
| `AGENTS.md` | Behavioral correctness | Strengthens violated rules, adds rules for recurring patterns |
| `MEMORY.md` | Factual completeness | Extracts durable facts from conversations, removes stale entries |
| `SOUL.md` | Identity convergence | Sharpens personality from generic to specific based on interaction patterns |

Prompts use `{fileName}`, `{targetContent}`, and `{transcripts}` placeholders:

```json
{
  "targets": [{
    "path": "/data/me/SOUL.md",
    "model": "anthropic/claude-sonnet-4-5",
    "prompt": "You are evolving an AI identity file ({fileName}). Read the conversations and sharpen the personality — make it more specific, more opinionated, less generic. Remove platitudes. Add concrete preferences and patterns you observe.\n\n## Current identity\n{targetContent}\n\n## Recent conversations\n{transcripts}"
  }]
}
```

If no prompt is set, the default targets behavioral corrections (the original use case).

## Impact Metrics

`/reflect-stats` tracks whether reflection is working:

- **Correction Rate** — `corrections / sessions` per run, plotted over time. Trending down = the agent is converging.

- **Rule Recidivism** — which sections get edited repeatedly. A rule strengthened 3+ times isn't sticking. Sections edited once and never again are resolved.

`/reflect-backfill` bootstraps stats from historical sessions (dry-run, no file edits).

## Configuration

`~/.pi/agent/reflect.json`:

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

## Related

- **[pi-mem](https://github.com/skyfallsin/pi-mem)** — Memory system for pi agents. Manages MEMORY.md, daily logs, notes, and scratchpad with context injection and keyword search. Pairs naturally with pi-reflect.

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
