# Builder execution — add module, cd, ls, pwd with mock connection
#
# Tests builder execution wiring against the mock HISE runtime.

Set Width 140
Set Height 34
Set Connection "mock"

Type "/builder"
Enter
Sleep 500ms
ExpectMode "builder"

# Add a module — should show result in output
Type `add "AHDSR Envelope" as "env"`
Enter
Sleep 500ms
Expect "AHDSR" output

# cd into the FX Chain, verify prompt updates
Type "cd FX Chain"
Enter
Sleep 300ms
Expect "FX Chain"

# ls shows children
Type "ls"
Enter
Sleep 300ms
Expect "Output" output

# pwd
Type "pwd"
Enter
Sleep 300ms
Expect "FX Chain" output

# Exit
Type "/exit"
Enter
Sleep 300ms
ExpectMode "root"
