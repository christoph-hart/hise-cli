# Test: AI must set the master chain's Volume parameter.

/builder
?set master volume to -6
/expect builder "show Master Chain" contains "Volume"
