# Builder validation — enter builder mode, add a module, exit
# Tests builder mode entry, valid module command, and exit.
# Multi-command sequences (invalid modules, suggestions) are
# deferred until the disabled-state timing bug is resolved.

Set Width 140
Set Height 34

# Enter builder mode
Type "/builder"
Enter
Sleep 1000ms
ExpectMode "builder"

# Valid module type
Type `add AHDSR as "env"`
Enter
Sleep 500ms
Expect "AHDSR"

# Exit
Type "/exit"
Enter
Sleep 500ms
ExpectMode "root"
