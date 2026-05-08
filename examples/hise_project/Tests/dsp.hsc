/hise launch
/builder
reset
add ScriptFX as "fx1"
set fx1.network "myfx"
/exit

/dsp fx1
add control.xfader as "fader"
add container.multi as "channel_splitter"
cd channel_splitter
add core.gain as "L"
add core.gain as "R"
cd ..
create_parameter myfx.Value [0, 1]
connect myfx.Value to fader.Value
connect fader.0 to L.Gain
connect fader.1 to R.Gain
#/expect get L.Gain.source is fader.0
/exit

/sequence
create test
500ms play sine at 220Hz for 1000ms

flush

play test

#/hise shutdown
