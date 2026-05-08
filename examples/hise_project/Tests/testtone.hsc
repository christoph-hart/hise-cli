/hise launch

/builder
reset
add "Sine Wave Generator" as "Sine"
set DefaultEnvelope.Release 100

/exit

/sequence
create testtone
0ms set Sine.Gain 1.0
400ms set Sine.SaturationAmount 0.8
0ms play C4 for 100ms
400ms set Sine.Gain 0.25
400ms play C5 for 100ms
600ms set Sine.Gain 0.5
750ms play C6 for 100ms

flush

record testtone as test.wav


/exit

/analyse
use resolution 50x1
use mode human
wave test.wav

/exit

/hise shutdown