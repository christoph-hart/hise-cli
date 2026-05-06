# Test: AI must add a reverb effect to the master chain's fx slot.

/builder
?add a reverb to master
/expect builder "show Master Chain.fx" contains "Reverb"
remove SimpleReverb
