# DSP Development Workflow

Agent workflow for building and validating HISE Scriptnode networks with
`hise-cli`. This document assumes the mental model in
[`SCRIPTNODE_GUIDELINE.md`](SCRIPTNODE_GUIDELINE.md): containers define signal
flow and processing context, parameter connections are range-aware, and root /
container parameters are the public API of reusable networks.

## Core Rule

- `dsp tree` and `dsp connections` answer: what is connected?
- `dsp trace` answers: what happened after a runtime stimulus?

Use both. A graph can be structurally valid and still behave incorrectly at
runtime.

## Build Loop

1. Identify the host and context: `Script FX`, synth voice, envelope, mono /
   stereo, MIDI policy, sidechain, block-size or polyphonic constraints.
2. Inspect existing state: builder tree, DSP host modules, assigned network,
   current `dsp tree`, and `dsp connections`.
   The root container ID is the assigned network name shown by `dsp tree`; use
   that ID for `--container`, `create_parameter`, and root parameter paths.
3. Use MCP-backed docs before choosing nodes or parameters:
   `hise-cli dsp docs <factory.node> --agent`.
4. Draft a small graph: audio path, control path, public root parameters, and
   expected runtime behaviour.
5. Build incrementally with `dsp add`, `dsp set`, and `dsp connect`.
6. Verify each structural group with `dsp tree`, `dsp show`, and
   `dsp connections`.
7. Validate parameter flow with trace.
8. Validate signal flow with trace.
9. Fix, retest, then save the network.

## Trace Model

A trace combines a stimulus with one or more probes.

Signal stimuli:

- `silence`: parameter-only or baseline checks.
- `dirac`: impulse response, delay timing, filters, peak detectors.
- `dc`: static level and transfer checks.
- `noise`: broad-band routing, filters, saturation, reverb tails.

Parameter stimuli:

- Temporary parameter injections keyed by `nodeId.parameterId`.
- Use root/container parameters when validating the public API.

Probe targets:

- Signal after a node, at a checkpoint, container output, or recursively through
  child containers.
- Explicit parameter paths or changed-parameter discovery.

## Parameter Trace

Use parameter trace to answer why a runtime value is what it is.

Common checks:

- Does a root parameter reach every intended target?
- Is a connection `matched`, `scaled`, or `unscaled`?
- Did a control node emit an unsafe raw value into a target range?
- Did a parameter become `outOfRange`?

Changed-parameter probing is a runtime change detector:

```bash
hise-cli dsp trace --module FX --container my_network --inject-param my_network.Amount=0.75 --probe-changed-parameters --agent
```

`--probe-changed-parameters` samples all parameters before the stimulus, runs
the probe, then reports changed parameters and runtime edges that were touched.
Do not treat it as a complete static dependency graph. A parameter may be
involved but not reported if its value does not change, changes back before
capture, or is not reached by the chosen stimulus. For suspected targets, use
explicit repeated `--probe-param <node.Param>` flags as well.

Useful interpretation patterns:

- Missing expected edge: connection missing, inactive, or not reached.
- `connectionMode: "scaled"`: source range maps through `0..1` into target
  range. If the target range is reversed, the scaled connection is intentionally
  inverted, e.g. source `0.1` into target range `1..0` becomes `0.9`.
- `connectionMode: "matched"`: source and target ranges match or preserve raw
  value intentionally.
- `connectionMode: "unscaled"`: raw source value is forwarded; inspect units and
  target range carefully.
- `outOfRange: true`: likely bad scaling, unsafe unscaled routing, or an
  intentionally invalid stress test.

## Signal Trace

Use signal trace to answer where audio changes, disappears, or becomes unsafe.

```bash
hise-cli dsp trace --module FX --container my_network --inject dirac --probe-recursive --agent
```

Common checks:

- First child where `silence` changes from `false` to `true`.
- Runaway `max` values in feedback or saturation paths.
- Unexpected channel count, block size, MIDI policy, or polyphonic context in
  recursive `containers.*.specs`.
- Signal present in the wrong branch because duplicated or parallel containers
  inherited audio.

`--probe-recursive` includes the recursive topology tree automatically.

Signal fields:

- `max`, `min`, `avg`: block-level sample summaries.
- `peakIndex`: sample index of the positive peak inside the captured block.
- `silence`: whether the captured block was silent.
- `specs.sampleRate` and `specs.blockSize`: required for timing and context.

Agent JSON trace output contains a compact computed summary and the preserved
HISE trace payload:

- `summary`: module/container, stimulus, recursive flag, signal peak/silence,
  and parameter/touched-edge counts.
- `trace`: the full trace response with signal, recursive containers, probed
  parameters, and touched edges.

Human output is a short report derived from the same payload. Use `--agent` or
`--json` when the trace is evidence for an automated validation step.

## Time-Domain Validation

Use `delayMs` to probe later processing blocks. For event timing, combine the
requested delay, returned delay remainder, and `peakIndex`:

```text
eventMs = requestedDelayMs - response.delayMs + peakIndex / sampleRate * 1000
```

Delay / echo checks:

- Probe slightly before the expected event so the event lands in the captured
  block.
- First echo should appear at `DelayTime`.
- Feedback repeats should appear at `DelayTime * n + loopLatency * (n - 1)`.
- Peaks should decay according to feedback gain.
- No non-finite or runaway signal values.

Example feedback-delay interpretation:

```text
DelayTime = 50 ms, feedback = 0.5, loop block = 32 samples at 44.1 kHz
1st echo ~= 50.0 ms, peak 1.0
2nd echo ~= 100.7256 ms, peak 0.5
3rd echo ~= 151.4512 ms, peak 0.25
```

The extra `0.7256 ms` is `32 / 44100 * 1000`, the feedback-loop block latency.

## Effect Recipes

Delay / tape delay:

- Parameter trace root controls: `DelayTime`, `Feedback`, tone, saturation,
  `DryWet`, output.
- Signal trace with `dirac`: verify echo timing and feedback decay.
- Signal trace with `noise`: verify tone / tape-age stages affect the signal.

Reverb / diffusion:

- Stimulus: `dirac` or short noise burst.
- Probe at pre-delay, early-reflection, tail, and late-tail times.
- Expect persistent but decaying energy, no sudden silence, no runaway.

Envelope followers and peak detectors:

- Stimulus: `dirac`, `dc`, or noise burst.
- Use `--probe-changed-parameters` to discover changed runtime parameters, then
  confirm suspected targets with explicit `--probe-param <node.Param>` flags.
- Sweep `delayMs` to inspect attack / release behaviour.

LFOs, ramps, and modulation generators:

- Often use no audio stimulus; validate elapsed-time parameter changes.
- Probe at `0`, `period/4`, `period/2`, `3*period/4`, and `period`.
- Confirm phase, wrap, reset, and target edges.

Smoothers and slew limiters:

- Stimulus: parameter step.
- Probe at fractions of the smoothing time.
- Expect monotonic movement toward the target unless overshoot is intended.

Dynamics:

- Stimulus: `dc`, noise burst, or future rendered tone.
- Probe before / after detector and gain stages.
- Confirm attack, release, makeup gain, and no unsafe output peaks.

Saturation / waveshaping:

- Stimulus: `dc`, noise, or future rendered tone.
- Compare low and high input levels.
- Confirm bounded output and no non-finite values.

Filters:

- Stimulus: `dirac` or `noise`.
- Confirm signal passes, cutoff / Q controls reach targets, and resonance does
  not explode.

Gates, triggers, resetters:

- Stimulus: parameter edge, `dirac`, or MIDI/event stimulus when available.
- Confirm output only changes on the intended edge or threshold.

## Diagnostic Heuristics

- Structure wrong: fix `dsp tree` / `dsp connections` first.
- Parameter edge missing: wrong source, target, parameter name, or inactive
  control context.
- Signal silent: inspect gain, routing, filter state, bypass, and container
  context. Silence is expected in parameter-only tests.
- `outOfRange`: inspect `connectionMode`, target range, and raw units.
- Unexpected timing: account for block quantisation and loop/container latency.
- Unexpected sound after moving nodes: inspect `containers.*.specs`; context may
  have changed even when parameters did not.

## Reporting

When finishing a DSP task, report:

- Host module and network.
- Nodes and public parameters created.
- Important connections and connection modes.
- Signal trace evidence.
- Parameter trace evidence.
- Remaining assumptions or caveats.
