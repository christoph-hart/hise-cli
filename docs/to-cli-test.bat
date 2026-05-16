hise-cli builder add --type ScriptFX --id CabMicSelector --agent
hise-cli builder set --module CabMicSelector --network cab_mic_selector --agent
hise-cli builder set --module "Master Chain" --routing "[0,1,0,1]" --agent
hise-cli builder set --module CabMicSelector --routing "[0,1,2,3]" --agent
hise-cli dsp add --module CabMicSelector --type routing.selector --id MicPairSelector --agent
hise-cli dsp set --module CabMicSelector --node MicPairSelector --param NumChannels --value 2 --agent
hise-cli dsp set --module CabMicSelector --node MicPairSelector --param ChannelIndex --range "0,2" --stepSize 2 --agent
hise-cli dsp add --module CabMicSelector --type container.multi --id PairSplit --agent
hise-cli dsp add --module CabMicSelector --type container.chain --id SelectedPair --parent PairSplit --agent
hise-cli dsp add --module CabMicSelector --type container.chain --id UnusedPair --parent PairSplit --agent
hise-cli dsp add --module CabMicSelector --type filters.svf_eq --id CabToneEQ --parent SelectedPair --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param Mode --value 4 --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param Frequency --value 3500 --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param Q --value 1.2 --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param Gain --value -3 --agent
hise-cli dsp add --module CabMicSelector --type jdsp.jcompressor --id CabGlueComp --parent SelectedPair --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param Treshold --value -18 --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param Ratio --value 3 --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param Attack --value 12 --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param Release --value 120 --agent
hise-cli dsp add --module CabMicSelector --type core.gain --id CabMakeupGain --parent SelectedPair --agent
hise-cli dsp set --module CabMicSelector --node CabMakeupGain --param Gain --range "-24,6" --stepSize 0.1 --agent
hise-cli dsp set --module CabMicSelector --node CabMakeupGain --param Gain --value 3 --agent
hise-cli dsp create_parameter --module CabMicSelector --container cab_mic_selector --id MicPosition --range "0,2" --default 2 --stepSize 2 --agent
hise-cli dsp connect --module CabMicSelector --source cab_mic_selector --source-param MicPosition --target MicPairSelector --param ChannelIndex --matched --agent
If create_parameter --stepSize 2 still creates step size 1, keep this corrective command. Otherwise omit it:
hise-cli dsp set --module CabMicSelector --node cab_mic_selector --param MicPosition --range "0,2" --stepSize 2 --agent
hise-cli dsp set --module CabMicSelector --node MicPairSelector --param NodeColour --value 0xFF2F80ED --agent
hise-cli dsp set --module CabMicSelector --node MicPairSelector --param Comment --value "**Mic pair selector** - Dynamically routes one of two input stereo pairs into a subsequent FX chain." --agent
hise-cli dsp set --module CabMicSelector --node PairSplit --param Comment --value "**Channel isolation** - Splits the 4-channel buffer into stereo slices so the FX chain only processes the selected pair on channels 0-1." --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param NodeColour --value 0xFF6F8FAF --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param NodeColour --value 0xFF6F8FAF --agent
hise-cli dsp set --module CabMicSelector --node UnusedPair --param Folded --value true --agent
hise-cli dsp set --module CabMicSelector --node CabMakeupGain --param Folded --value true --agent
hise-cli dsp set --module CabMicSelector --node CabToneEQ --param Folded --value true --agent
hise-cli dsp set --module CabMicSelector --node CabGlueComp --param Folded --value true --agent

hise-cli dsp screenshot --module CabMicSelector --scale 200% --output cab_mic_selector@2x.png --agent