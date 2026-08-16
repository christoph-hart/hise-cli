# Scriptnode Agent Notes

Agent-facing compression of Scriptnode tribal knowledge. Optimised for editing docs, generating graphs, and reasoning about behaviour. Keep this mental model over any UI impression.

---

## Core Model

- Scriptnode is a visual DSP language, not a text language.
- The graph is a tree.
- Audio order comes from container hierarchy only.
- Parameter and modulation cables can cross the tree, but they do not define audio order.
- Root is usually `container.chain`.
- Every child is either another container or a leaf node.

Minimal rule:

- parent container = control flow / context
- leaf node = actual DSP, routing, modulation, analysis, or control transform

---

## Context First

Most Scriptnode mistakes are context mistakes, not node mistakes.

Each node receives context from its parent:

- sample rate
- max block size
- channel count
- MIDI policy
- mono/poly voice context

Before proposing or building a graph, identify the required host context:

- `Script FX`
- `Script Envelope`
- synth-voice context
- host-side modulation setup

A correct graph in the wrong host context is still a wrong solution.

Moving a node across container boundaries can change audible behaviour even if the node and parameter values stay the same.

Treat these as hard DSP boundaries:

- `container.oversample*`
- `container.frame*_block`
- `container.fix*_block`
- `container.modchain`
- `container.sidechain`
- `container.no_midi`
- `container.midichain`

`container.sidechain` duplicates the incoming channel set into a larger internal layout. For stereo input, think in terms of two stereo pairs inside the container, not a separate keyed branch living elsewhere. Downstream nodes may reinterpret the second pair as detector/control input.

Do not describe containers as folders. They are execution-context modifiers.

---

## Audio Flow Rules

- `container.chain`: serial, in-place
- `container.split`: same input to each child, outputs summed
- `container.multi`: channel slices, not duplicated signal paths
- `container.branch`: only selected child runs
- `container.clone`: repeated chain instances

Important distinctions:

- `split` means parallel copies of the same signal
- `multi` means different channel subsets per child
- `modchain` does not modify parent audio

Inherited-signal rule:

- parallel or duplicated branches keep inherited signal unless you explicitly clear or replace it
- if a branch should stop carrying its inherited audio, plan an explicit disposal step such as `math.clear` or full source replacement

Operational `modchain` rule:

- `container.modchain` creates a hidden control path
- nodes inside it do not process the audible parent audio path by default
- if modulation should affect audible audio, route it to a target outside the modchain or to a parameter target explicitly

Common agent error:

- using `multi` when the intent is dry/wet or band parallelism
- using `split` when the intent is per-channel processing

---

## MIDI Rules

- MIDI travels with the signal as hidden event data.
- MIDI is not implied everywhere.
- Polyphonic networks usually need MIDI enabled.
- Monophonic networks may not process MIDI unless a node/container requires it.

Key containers:

- `container.midichain`: force MIDI/event processing for children
- `container.no_midi`: block MIDI for children

Use frame or MIDI-aware contexts for sample-accurate event-driven changes. Otherwise assume block/control-rate timing.

---

## Parameters vs Properties

This distinction matters a lot.

For existing leaf nodes, the split is usually fixed by node design. Agents should not imply that a user can freely reclassify an exposed control as a parameter or property while patching.

Agents should describe parameter/property distinctions as node-defined constraints to discover, not as free patch-design choices for ordinary graph editing.

Parameters:

- numeric
- realtime-controllable
- modulation targets
- part of playback control

Properties:

- non-realtime config
- mode/code/file/algorithm/layout/static behaviour
- usually string/bool/menu-like
- often become fixed after compilation

Design rule, not everyday patching choice:

- custom-node or macro design: playback controls belong on parameters
- custom-node or macro design: structure/algorithm/source/mode belongs on properties
- ordinary graph editing: work with the split the node already exposes

---

## Public API of a Network

Reusable network API = root/container parameters.

Do not expose many deep internal node parameters unless the internals are intentionally public.

Best practice:

- create a small set of container parameters
- connect them to internal targets
- treat internal node params as implementation detail

This matters more after compilation because internals become fixed structure.

---

## Range Model

Scriptnode connections are range-aware by default.

Scaled vs unscaled is a connection-mode property, not a reclassification of a parameter.

Default behaviour:

- source value interpreted in source range
- converted to `0..1`
- remapped into target range

Modes:

- scaled: normal source-range -> target-range mapping
- unscaled: raw source value forwarded
- same-range: raw forwarding when ranges match

Heuristic when choosing connection mode or node variant:

- scaled = default wiring behaviour
- unscaled = use only when the source already computes exact target units
- same range = ideal when source and target represent the same unit

Non-obvious point:

- modulation depth is often best controlled by editing the target range, not the source
- swapping the target range endpoints intentionally inverts scaled connections; a `0..1` source into target range `1..0` maps `0.1` to `0.9`
- this target-range inversion is valid before or after creating the connection

Visual-verification defaults for educational or diagnostic graphs:

- choose startup values that make behaviour visible on first load
- prefer slow LFO-style rates for display-driven examples
- start from a canonical baseline state where possible
- narrow ranges when that makes the transformation easier to inspect

---

## Modulation Rules

Two directions exist:

- Scriptnode source -> Scriptnode target parameter
- HISE modulation chain -> Scriptnode via bridge nodes like `core.global_mod`, `core.extra_mod`, `core.pitch_mod`, `core.matrix_mod`

`core.extra_mod` reads HISE extra modulation slots by index. The selected `Index`
must point at a used root dynamic parameter slot, so create or update a root
parameter with `ExternalModulation` before relying on the bridge:

```text
create_parameter root.ModDepth [0, 1] default 0.5 ExternalModulation Combined
# or after creation:
set root.ModDepth.ExternalModulation Combined
```

Update rate depends on context, not just node type:

- frame container: sample-accurate
- normal audio block: usually block-rate
- modchain/control contexts: reduced rate
- MIDI sources: event-driven

If a modulated parameter zippers, inspect source context first.

Important composition rule:

- many targets can share one source
- if several values must feed one target, combine them first with control nodes or a macro scheme

---

## Routing Rules

Separate audio routing from control routing.

Audio routing:

- `routing.send` / `routing.receive`: local to one network
- `routing.global_send` / `routing.global_receive`: cross-network audio

Control routing:

- `routing.local_cable` / `routing.local_cable_unscaled`: local control organisation
- `routing.global_cable`: global control values across HISE/scriptnode boundaries

Do not collapse these concepts in docs or generated explanations.

Important non-obvious rule:

- audio send/receive requires matching processing specs assumptions
- global audio routing should be exceptional, not default
- local cables are often cleaner than many direct parameter lines

---

## Polyphony

- Polyphony is built into the network context.
- Poly-capable stateful nodes get per-voice state.
- Mono-only nodes can still be shared inside polyphonic graphs.

`[poly]` in the UI means per-voice state for that node.

Do not assume every node in a poly graph is per-voice.

Polyphony also changes MIDI handling because note lifecycle is routed per voice.

---

## Voice Management

For sound-generating poly networks, voice reset/end logic matters.

If a polyphonic network has a tail and no voice-management path, voices can stay alive too long.

Typical helpers:

- `envelope.voice_manager`
- `envelope.silent_killer`

Agents should mention voice management whenever describing custom synth voices or long-tailed poly DSP.

---

## Bypass

Two practical modes:

- hard bypass: immediate skip
- soft bypass: crossfaded bypass via `container.soft_bypass`

Important rule:

- dynamic click-free bypass control targets `container.soft_bypass`, not generic containers

Do not recommend ordinary container bypass for automated or modulation-driven switching if clicks matter.

---

## Authoring Surfaces

- Scriptnode UI: best for human design/debug/listening/layout
- `hise-cli /dsp`: best for repeatable scripted construction, automation, tests
- scripting API: best for runtime create/load/control

For hise-cli-based graph construction and runtime validation workflows, see
[`DSP_DEVELOPMENT_WORKFLOW.md`](DSP_DEVELOPMENT_WORKFLOW.md). This document
defines the Scriptnode mental model; the workflow document explains how agents
apply it with `dsp tree`, `dsp connections`, and trace-based signal / parameter
validation.

When agents generate reproducible build procedures, separate three kinds of information:

- host/setup prerequisites
- locked static build values
- explanatory comments

Do not blur setup facts into prose comments when they are required for a successful build.

When agents generate procedures:

- prefer UI for conceptual explanation
- prefer `hise-cli /dsp` for reproducible graph edits
- prefer scripting API only when runtime logic genuinely needs it

---

## Compilation

Compilation turns the editable graph into fixed DSP structure.

Usually preserved:

- topology
- parameter ranges/defaults
- connections
- channel count
- polyphony
- supported embedded data

Usually fixed after compile:

- container structure
- ranges
- oversampling factor
- fixed block sizes
- many property-based mode choices

Docs or agent output should frame compilation as freezing structure, not just improving performance.

---

## XML / Persistence

- XML is storage, not authoring syntax.
- It records tree, IDs, params, ranges, properties, connections, layout, data refs.
- Avoid telling users to hand-edit XML except when discussing persistence format conceptually.

Direct XML edits can create duplicate IDs, invalid links, stale ranges, or missing refs.

---

## Scripting API Notes

Main entry point:

- `Engine.createDspNetwork()`

Useful object model:

- `DspNetwork` = network handle
- `Node` = node/container handle
- `Parameter` = parameter handle
- `Connection` = wiring handle

Non-obvious scripting rule:

- container nodes can create macro parameters dynamically
- leaf nodes have fixed parameter sets
- `getOrCreateParameter()` on a leaf is for obtaining an existing param reference, not inventing a new public macro

---

## Diagnostic Heuristics

When behaviour is wrong, inspect in this order:

1. container context
2. channel count
3. MIDI enabled/blocked
4. mono vs poly state
5. scaled vs unscaled connection
6. source vs target parameter ranges
7. whether a node is actually in the audio path or only control path

Useful debug node:

- `analyse.specs` for local signal spec inspection

---

## High-Value Gotchas

- `modchain` processes a separate mono control signal and does not modify parent audio.
- `split` sums outputs, so gain can rise unexpectedly.
- `multi` needs sufficient channels; it is not a generic parallel container.
- moving nodes into oversampled/frame/fix/modchain contexts can audibly change behaviour without changing parameters.
- target ranges are part of modulation semantics.
- local/global cables are control-value organisation, not audio send/receive.
- compiled root channel count is not generic later. Stereo compile means stereo assumption.
- poly tails need explicit reset strategy.
- `container.soft_bypass` is the right place for smooth automated bypass.
- duplicated or inherited branches are not silent unless explicitly cleared.
- sidechain containers change internal channel topology, not just routing labels.
- hidden control contexts like `modchain` can make a graph look connected while leaving the audible path unchanged.
- exact code, mode, and startup values should be locked early when reproducibility matters.

---

## Compression Rules For Agents

When explaining Scriptnode briefly, preserve these points if anything is omitted:

1. Scriptnode is a tree.
2. Containers define both signal flow and processing context.
3. Parameter connections are range-aware by default.
4. `modchain` is control-rate and separate from parent audio.
5. Container/root parameters are the intended public API.
6. Routing has separate audio and control systems.
7. Polyphonic networks need voice-lifetime handling.
8. Compilation freezes structure and many configuration choices.

If an answer omits any of those, it is likely to mislead advanced users.
