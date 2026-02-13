# pi-reflect Setup Guide

This guide is for you, the coding agent. When a user asks you to "set up reflect", "schedule reflect daily", or "configure pi-reflect", follow these instructions.

## Step 1: Install

Run this command:

```bash
pi install git:github.com/skyfallsin/pi-reflect
```

Then reload extensions:

```
/reload
```

## Step 2: Find the target file

The user wants to reflect on a behavioral markdown file — usually `AGENTS.md`, `CLAUDE.md`, `RULES.md`, or similar. Check the current project root and `~/.pi/agent/` for candidates:

```bash
ls AGENTS.md CLAUDE.md RULES.md .cursorrules .github/copilot-instructions.md 2>/dev/null
ls ~/.pi/agent/AGENTS.md 2>/dev/null
```

If nothing exists, ask the user which file they want to improve. If they don't have one yet, suggest creating an `AGENTS.md` in their project root with a few starter rules.

## Step 3: Test it

Run reflect once to verify it works:

```
/reflect /absolute/path/to/AGENTS.md
```

It will ask if the user wants to save the target. Say yes. This creates `~/.pi/agent/reflect.json`.

## Step 4: Schedule daily runs (optional)

If the user wants automatic daily reflection, set up a scheduler. Reflect runs headless via:

```bash
pi -p --no-session "/reflect"
```

This uses the saved target from step 3.

### macOS (launchd)

Find the pi binary path:

```bash
which pi
```

Write the plist — replace `/path/to/pi` with the actual path:

```bash
cat > ~/Library/LaunchAgents/com.pi.reflect.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pi.reflect</string>
    <key>ProgramArguments</key>
    <array>
        <string>PI_PATH</string>
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>HOME_DIR</string>
    </dict>
</dict>
</plist>
EOF
```

Replace `PI_PATH` and `HOME_DIR` with the actual values using sed:

```bash
PI_BINARY=$(which pi)
sed -i '' "s|PI_PATH|$PI_BINARY|g" ~/Library/LaunchAgents/com.pi.reflect.plist
sed -i '' "s|HOME_DIR|$HOME|g" ~/Library/LaunchAgents/com.pi.reflect.plist
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.pi.reflect.plist
```

### Linux (cron)

```bash
PI_BINARY=$(which pi)
(crontab -l 2>/dev/null; echo "0 8 * * * $PI_BINARY -p --no-session \"/reflect\" >> /tmp/pi-reflect.log 2>&1") | crontab -
```

## Step 5: Verify scheduling

For macOS:

```bash
launchctl list | grep pi.reflect
```

For Linux:

```bash
crontab -l | grep reflect
```

Tell the user: reflect is configured. It will run daily at 8am, analyze yesterday's sessions, and update their file. Backups are in `~/.pi/agent/reflect-backups/`. They can check results with `/reflect-history` or `cat /tmp/pi-reflect.log`.

## Configuration reference

`~/.pi/agent/reflect.json`:

```json
{
  "targets": [{
    "path": "/absolute/path/to/AGENTS.md",
    "model": "anthropic/claude-sonnet-4-5",
    "lookbackDays": 1,
    "maxSessionBytes": 614400,
    "backupDir": "~/.pi/agent/reflect-backups",
    "transcriptSource": { "type": "pi-sessions" }
  }]
}
```

- **path**: Absolute path to the target file.
- **model**: Any `provider/model-id` the user has an API key for in pi. Default: `anthropic/claude-sonnet-4-5`.
- **lookbackDays**: How many days of sessions to analyze. Default: `1`.
- **maxSessionBytes**: Context budget for transcripts. Default: `614400` (~600KB).
- **backupDir**: Where backups go before edits. Default: `~/.pi/agent/reflect-backups`.
- **transcriptSource**: `{ "type": "pi-sessions" }` reads pi's session JSONL files. `{ "type": "command", "command": "script {lookbackDays}" }` runs a custom command instead.

Multiple targets are supported — add more objects to the `targets` array.

## Troubleshooting

- **"No API key for model"**: The user needs to configure an API key for the model in pi. Run `/model` to check available models.
- **"No substantive sessions found"**: No sessions with 3+ exchanges found in the lookback period. Try increasing `lookbackDays`.
- **"Target file too small"**: The file must be at least 100 bytes. It needs some existing rules for reflect to work with.
- **Edits skipped**: Reflect logs the reason for each skip (ambiguous match, text not found, already exists). This is a safety feature, not a bug.
- **launchd not running**: Check `launchctl list | grep pi.reflect`. If missing, `launchctl load` the plist. Check `/tmp/pi-reflect.log` for errors. Common issue: PATH doesn't include the directory where `pi` and `node` are installed.
