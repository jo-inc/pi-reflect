<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.png" width="300">
    <img src="logo.png" alt="pi-reflect" width="300">
  </picture>
</p>

# pi-reflect

Iterative self-improvement for [pi](https://github.com/badlogic/pi-mono) coding agents.

Define a target — how your agent should behave, what it should remember, who it should be — and reflect iterates toward it. Each run reads recent conversations and reference material, compares the agent's actual behavior against the target, and makes surgical edits to close the gap.

**define the target → reflect reads evidence → edits the file → the agent gets closer.**

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

1. Collects evidence: conversation transcripts, daily logs, reference files — from any combination of sources
2. Sends the evidence + the target file + a prompt describing the desired end state to an LLM
3. The LLM identifies gaps between actual behavior and the target, proposes surgical edits
4. Edits are applied with safety checks: backs up the original, skips ambiguous matches, rejects suspiciously large deletions, auto-commits to git if the target is in a repo

Every edit is versioned — reflect auto-commits to git after applying changes, so you get a full history of how each file evolved. `git log AGENTS.md` shows every correction the agent absorbed. `git diff HEAD~5 SOUL.md` shows how the personality sharpened over the last 5 runs.

Over time, the file converges: corrections get absorbed as rules, memory accumulates durable facts, personality sharpens from generic to specific. The agent stops needing the same corrections.

## Data sources

Each target has two input channels — `transcripts` (what happened) and `context` (reference material). Both accept an array of sources:

| Type | Description | Example |
|------|-------------|---------|
| `files` | Glob patterns or file paths, pruned by date and size | Daily logs, notes, other markdown files |
| `command` | Shell command, stdout captured | API calls, database queries, custom scripts |
| `url` | HTTP GET, response body captured | REST endpoints, health checks |

All sources support `{lookbackDays}` interpolation and per-source `maxBytes` caps. File sources are automatically pruned to only include files within the `lookbackDays` window (matched by date in filename).

```json
{
  "targets": [{
    "path": "/data/me/MEMORY.md",
    "model": "anthropic/claude-sonnet-4-5",
    "lookbackDays": 1,
    "transcripts": [
      { "type": "command", "label": "conversations", "command": "curl -s http://localhost:3001/conversation/recent?days={lookbackDays}", "maxBytes": 400000 }
    ],
    "context": [
      { "type": "files", "label": "daily logs", "paths": ["/data/me/daily/*.md"], "maxBytes": 50000 },
      { "type": "files", "label": "notes", "paths": ["/data/me/notes/*.md"], "maxBytes": 50000 }
    ],
    "prompt": "..."
  }]
}
```

For the common case of local pi sessions, just use `transcriptSource`:

```json
{ "transcriptSource": { "type": "pi-sessions" } }
```

## Prompts define the target

Each target has an optional `prompt` field that tells reflect *what to optimize for*. The same engine drives very different behaviors depending on the prompt:

| Target | Prompt goal | What reflect does |
|--------|------------|-------------------|
| `AGENTS.md` | Behavioral correctness | Strengthens violated rules, adds rules for recurring patterns |
| `MEMORY.md` | Factual completeness | Extracts durable facts from conversations, removes stale entries |
| `SOUL.md` | Identity convergence | Sharpens personality from generic to specific based on interaction patterns |

Prompts use `{fileName}`, `{targetContent}`, `{transcripts}`, and `{context}` as placeholders:

```json
{
  "prompt": "You are evolving an AI identity file ({fileName})...\n\n## Current\n{targetContent}\n\n## Conversations\n{transcripts}\n\n## Reference\n{context}"
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

| Field | Default | Description |
|-------|---------|-------------|
| `path` | *(required)* | Target markdown file to iterate on |
| `model` | *(required)* | LLM to use (e.g. `anthropic/claude-sonnet-4-5`) |
| `lookbackDays` | `1` | How far back to look for evidence |
| `maxSessionBytes` | `614400` | Max transcript bytes per run |
| `transcripts` | — | Array of `ContextSource` for transcript data |
| `transcriptSource` | `pi-sessions` | Legacy single source (use `transcripts` for multiple) |
| `context` | — | Array of `ContextSource` for reference material |
| `prompt` | *(default)* | Custom prompt with `{fileName}`, `{targetContent}`, `{transcripts}`, `{context}` |
| `backupDir` | `~/.pi/agent/reflect-backups` | Where to store pre-edit backups |

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
