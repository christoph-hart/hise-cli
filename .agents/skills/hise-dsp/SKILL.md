---
name: hise-dsp
description: Build and validate HISE ScriptNode DSP networks with hise-cli, including signal and parameter trace workflows.
allowed-tools: Read Grep Glob Bash
---

# hise-dsp

Use this skill for DSP authoring requests such as `/hise-dsp create an analogue
tape delay`, debugging ScriptNode networks, or validating runtime DSP behaviour.

## Required References

Read these when doing non-trivial DSP work:

- `docs/SCRIPTNODE_GUIDELINE.md` for the ScriptNode mental model.
- `docs/DSP_DEVELOPMENT_WORKFLOW.md` for hise-cli build and trace validation.

Use MCP-backed docs for node and parameter lookup:

```bash
hise-cli dsp docs <factory.node> --agent
hise-cli dsp docs <factory> --agent
```

Do not guess node parameters, properties, or connection modes.

## First Checks

```bash
hise-cli -status --agent
hise-cli builder tree --agent
hise-cli dsp tree --module "Script FX1" --agent
```

If no DSP host exists, create or select one intentionally:

```bash
hise-cli builder add --type ScriptFX --id FX --parent "Master Chain" --chain "FX Chain" --agent
hise-cli builder set --module FX --network my_network --agent
```

The root container ID is the assigned network name, so inspect `dsp tree` and
use that ID in `--container`, `create_parameter`, and root parameter paths.

## Build Loop

1. Identify host context, channel count, MIDI policy, mono/poly expectations,
   and public controls.
2. Inspect existing network with `dsp tree`, `dsp show`, and `dsp connections`.
3. Look up candidate nodes with `hise-cli dsp docs`.
4. Build a small graph incrementally with `dsp add`, `dsp set`, and
   `dsp connect`.
5. Expose root/container parameters as the network API.
6. Verify structure after each group.
7. Validate parameter flow with trace.
8. Validate signal flow with trace.
9. Fix issues, retest, then save.

## Common Commands

```bash
hise-cli dsp add --module FX --type core.gain --id gain --agent
hise-cli dsp show --module FX --node gain --agent
hise-cli dsp set --module FX --node gain --param Gain --value -6 --agent
hise-cli dsp create_parameter --module FX --container my_network --id Amount --range 0,1 --default 0.5 --agent
hise-cli dsp connect --module FX --source my_network --source-param Amount --target gain --param Gain --agent
hise-cli dsp connections --module FX --agent
```

## Trace Validation

Use trace after structural checks. Structure tells what is connected; trace tells
what happened after a stimulus.

Parameter discovery:

```bash
hise-cli dsp trace --module FX --container my_network --inject-param my_network.Amount=0.75 --probe-changed-parameters --agent
```

Use `--probe-changed-parameters` for discovery, then explicitly probe suspected
targets with repeated `--probe-param <node.Param>` flags. Changed-parameter
traces report changed runtime values, not all possible dependencies.

Signal path:

```bash
hise-cli dsp trace --module FX --container my_network --inject dirac --probe-recursive --agent
```

Mixed signal-to-parameter trace:

```bash
hise-cli dsp trace --module FX --container my_network --inject dirac --inject-before peak1 --probe-changed-parameters --agent
```

Time-domain timing:

```text
eventMs = requestedDelayMs - response.delayMs + peakIndex / sampleRate * 1000
```

Probe slightly before the expected event so the peak lands inside the captured
block.

## Heuristics

- Missing edge: wrong source, target, parameter name, context, or inactive node.
- `outOfRange`: inspect raw units and `connectionMode`.
- `unscaled`: safe only when the source already computes target units.
- Silence in audio-path tests: inspect gain, routing, filters, bypass, and
  container context.
- Silence in parameter-only tests can be expected; inspect `parameters.probed`.
- Unexpected timing: account for block quantisation and container / feedback-loop
  latency.
- Unexpected behaviour after moving nodes: inspect recursive `specs` because
  context may have changed.

## Final Response

Summarize:

- host module and network
- nodes and public parameters created
- important connections and connection modes
- parameter trace evidence
- signal trace evidence
- remaining assumptions or caveats
