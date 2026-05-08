#!/usr/bin/env hise-cli run
# Hello World — launch HISE, build a sine synth, play a chord, verify voices.

# 1. Ensure HISE is running
/hise
launch # noop if HISE is open

# check the HISE has the current project open
/expect status project is hise_project or abort

/exit

# 2. Start fresh, then create a simple sine synth
/builder
reset
add SineSynth as "HelloSynth"
set HelloSynth.Gain 0.5
/expect get HelloSynth.Gain is 0.5
/exit

# 3. Play a C major chord and check that all 3 keys are pressed
/sequence
create "hello_chord"
0ms play C3 100 for 1s
0ms play E3 100 for 1s
0ms play G3 100 for 1s
500ms eval Synth.getNumPressedKeys() as PRESSED
flush
play "hello_chord"
/expect get PRESSED is 3
/exit

# close HISE
/hise shutdown