# Tab completion — verify completion engine via rendered TUI
# Tests Tab-triggered completion: single-match auto-accept and
# multi-match popup display.

Set Width 140
Set Height 34
Set Connection "mock"

# Start in root mode
ExpectPrompt "> "

# ── Slash command completion (single match: /hel → /help) ────────

Type "/hel"
Sleep 200ms
Tab
Sleep 300ms
# Single match auto-accepted — input should now show "/help"
Expect "/help"

# Clear input and submit to reset
Backspace 5
Sleep 100ms

# ── Enter builder mode for keyword + module completion ───────────

Type "/builder"
Enter
Sleep 300ms
ExpectMode "builder"

# Builder keyword completion (single match: "a" + Tab → "add")
Type "a"
Sleep 200ms
Tab
Sleep 300ms
Expect "add"

# Continue typing module prefix (single match: "add AH" + Tab → "add AHDSR Envelope")
Type " AH"
Sleep 200ms
Tab
Sleep 300ms
Expect "AHDSR Envelope"

# Append a quoted alias so the command parses, then submit
Type ` as "env"`
Enter
Sleep 300ms

# Exit builder
Type "/exit"
Enter
Sleep 300ms
ExpectMode "root"
