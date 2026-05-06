# Test: AI must translate "add a velocity modulator to the sine generator"
# into a builder command that places a Velocity modulator on Sine1's gain chain.

/builder
add SineSynth as "Sine1" to Master Chain
?add a velocity modulator to the sine generator
/expect builder "show Sine1.gain" contains "Velocity"
remove Sine1
