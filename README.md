# pi-reflect

Self-improving behavioral files for [pi](https://github.com/badlogic/pi-mono) coding agents.

Most coding agents support an `AGENTS.md` file (or similar) — a markdown file in your repo that tells the agent how to behave: what to read before acting, how to handle git, when to ask vs just do, etc. Over time you add rules when the agent screws up. But it keeps screwing up in the same ways because the rules aren't strong enough, or the pattern isn't covered yet.

**pi-reflect** closes the loop. It reads your recent session transcripts, finds the places where you had to redirect, correct, or express frustration with the agent, and makes surgical edits to your behavioral file to prevent recurrence.

**you correct the agent → reflect strengthens the rules → the agent stops making that mistake.**

## Prerequisites

- [pi](https://github.com/badlogic/pi-mono) installed and configured
- An API key for at least one LLM provider (Anthropic, Google, OpenAI, etc.) configured in pi — reflect uses it to analyze your transcripts. Each run makes one LLM call (~600KB of context). Expect ~$0.05–0.15 per run with Sonnet.

## Install

```bash
pi install git:github.com/skyfallsin/pi-reflect
```

## Quick Start

```
/reflect ./AGENTS.md
```

That's it. Reflect will:

1. Extract your recent pi session transcripts (last 24 hours by default)
2. Send them + your target file to an LLM
3. Identify correction patterns — real friction, not false positives
4. Apply surgical edits: strengthen existing rules that were violated, add new rules for recurring patterns
5. Back up the original file before any changes

The path is resolved relative to your current working directory. Absolute paths work too.

The first time you run it, it'll ask if you want to save the target for next time. After that, just `/reflect`.

## Commands

| Command | Description |
|---------|-------------|
| `/reflect [path]` | Run reflection on a file (or your configured default) |
| `/reflect-config` | Show configured targets |
| `/reflect-history` | Show recent reflection runs |

## Configuration

Saved in `~/.pi/agent/reflect.json`. Created automatically when you save a target, or edit manually:

```json
{
  "targets": [
    {
      "path": "/path/to/AGENTS.md",
      "model": "anthropic/claude-sonnet-4-5",
      "lookbackDays": 1,
      "maxSessionBytes": 614400,
      "backupDir": "~/.pi/agent/reflect-backups"
    }
  ]
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `path` | *(required)* | Path to the markdown file to improve (absolute, or `~` for home) |
| `schedule` | `"daily"` | `"daily"` or `"manual"` — metadata only, actual scheduling is external |
| `model` | `"anthropic/claude-sonnet-4-5"` | `provider/model-id` for the analysis LLM. Must match a model you have an API key for in pi |
| `lookbackDays` | `1` | How many days of session history to analyze |
| `maxSessionBytes` | `614400` | Context budget for transcripts (~600KB). Sessions are prioritized by interaction density and trimmed to fit |
| `backupDir` | `~/.pi/agent/reflect-backups` | Where pre-edit backups are stored |
| `transcriptSource` | `{ "type": "pi-sessions" }` | Where to get transcripts from (see below) |

## Transcript Sources

### Built-in: pi sessions

The default. Scans `~/.pi/agent/sessions/` for JSONL session files from the lookback period. Extracts user messages, assistant responses, and thinking tokens. Sessions are sorted by interaction density — more back-and-forth exchanges rank higher because they're more likely to contain corrections.

### Custom command

For non-pi transcripts (chat logs, other agent tools, custom databases), use the `command` source:

```json
{
  "path": "/path/to/RULES.md",
  "transcriptSource": {
    "type": "command",
    "command": "python extract_conversations.py {lookbackDays}"
  }
}
```

The command should output plain text transcripts to stdout. `{lookbackDays}` is interpolated with the configured value. The output is trimmed to `maxSessionBytes`.

## How the Analysis Works

The LLM receives your target file and the extracted transcripts, then:

1. **Identifies correction patterns** — Looks for genuine friction: user redirections ("no", "not that", "wrong"), frustration signals ("bro", "wtf", "seriously"), repeated explanations, undo requests, and over-engineering complaints. Ignores false positives like "no worries" or "actually, that looks good".

2. **Maps to existing rules** — For each correction, checks if an existing rule already covers it. If yes, it strengthens the wording (adds emphasis, examples, makes it more prominent). If no matching rule exists, it proposes a new bullet point in the most appropriate section.

3. **Applies conservative edits** — Only addresses patterns with 2+ occurrences across different sessions. No reorganizing, no removing rules, no one-off additions. Edits match the existing tone and style.

## Safety

- **Backup before every edit** — The original file is copied to `backupDir` with a timestamp before any changes are written
- **Exact text matching** — Edits use exact string matching, not regex or fuzzy matching. If the target text can't be found character-for-character, the edit is skipped
- **Ambiguity detection** — If the target text appears multiple times in the file, the edit is skipped rather than risk modifying the wrong occurrence
- **Duplication prevention** — New text is checked against the existing file to avoid adding content that's already present
- **Size sanity check** — If the result would be less than 50% of the original file size, the entire run is aborted
- **Edit-by-edit reporting** — Each skipped edit is reported with the reason, so you can see exactly what was applied and what wasn't

## Headless / Scheduled Execution

Reflect works in pi's print mode for cron jobs and automation:

```bash
pi -p --no-session "/reflect /path/to/AGENTS.md"
```

### launchd (macOS)

Create `~/Library/LaunchAgents/com.pi.reflect.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pi.reflect</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/pi</string>
        <string>-p</string>
        <string>--no-session</string>
        <string>/reflect</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>8</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/pi-reflect.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/pi-reflect.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.pi.reflect.plist
```

### cron (Linux)

```bash
# Run daily at 8am
0 8 * * * /path/to/pi -p --no-session "/reflect" >> /tmp/pi-reflect.log 2>&1
```

## Multiple Targets

You can configure multiple files, each with their own model, lookback period, and transcript source:

```json
{
  "targets": [
    {
      "path": "/workspace/AGENTS.md",
      "lookbackDays": 1
    },
    {
      "path": "/project/CODING-RULES.md",
      "model": "google/gemini-2.5-pro",
      "lookbackDays": 7,
      "transcriptSource": {
        "type": "command",
        "command": "my-transcript-extractor --days {lookbackDays}"
      }
    }
  ]
}
```

When you run `/reflect` without a path and have multiple targets, you'll be prompted to choose. In headless mode, the first target is used.

## Run History

Every run is logged to `~/.pi/agent/reflect-history.json` (last 100 runs). View with `/reflect-history`:

```
- 2026-02-13 08:00  AGENTS.md: 12 edits, 47 corrections (58 sessions)
  Strengthened "read before acting" rule, added "verify async completion" pattern...
- 2026-02-12 08:00  AGENTS.md: 8 edits, 31 corrections (42 sessions)
  Added "don't ask permission for debugging" and "corrections are permanent" rules...
```

## Development

```bash
git clone https://github.com/skyfallsin/pi-reflect
cd pi-reflect
npm install
npm test   # 137 tests
```

To test the extension locally without installing:

```bash
pi -e ./extensions/index.ts
```

## License

MIT
