# Workflow Guide

Best practices for using hise-cli effectively. Written for both LLM agents
(Claude Code, Cursor, etc.) and human developers building HISE audio plugins.

For command syntax reference, see `hise-cli --help` or `hise-cli -<mode> --help`.

---

## 1. Launching and connecting to HISE

hise-cli is a client — it needs a running HISE instance to execute commands
against. The `-hise` mode handles the lifecycle.

### Checking connection status

```bash
hise-cli -hise "status"
```

**Always run this first before doing any work.** It checks whether HISE is
reachable on `localhost:1900`. If it returns an error, HISE needs to be
launched before any other commands will work.

### Starting HISE

```bash
hise-cli -hise "launch"          # find HISE on PATH, start it, wait for connection
hise-cli -hise "launch debug"    # start HISE Debug build instead
```

`launch` spawns HISE, then polls `localhost:1900` until the REST API
responds (10s timeout). Once connected, all other modes work.

### Shutting down HISE

```bash
hise-cli -hise "shutdown"
```

Sends a graceful quit signal. Use this to cleanly close HISE when you're
done — avoids orphaned processes.

### When to use launch/shutdown

**LLM agents:** Always start with `hise-cli -hise "status"`. If it fails,
issue `launch` before proceeding with any other commands.

**Automated scripts:** Bracket your `.hsc` script with launch and shutdown
for fully self-contained test runs:

```hsc
/hise
status
launch
/exit

/builder
add SineSynth as Test
show tree
/exit

/hise
shutdown
```

**Interactive sessions:** Humans typically start HISE manually through the
GUI. `launch` is most useful for headless/CI workflows and for LLM agents
that need to ensure HISE is available.

---

## 2. Choosing the right invocation style

hise-cli offers three ways to send commands. Picking the right one avoids
wasted round-trips and keeps undo history clean.

### Single one-shot command

```bash
hise-cli -builder "add SimpleGain to Master Chain"
```

Use when you need **one operation and want to inspect the result** before
deciding what to do next. Each call returns JSON with the outcome.

### Comma chaining

```bash
hise-cli -builder "add SimpleGain as MyGain, set MyGain.Gain to -6, set MyGain.Balance to 15"
```

Use when you have **multiple related mutations in the same mode**. All
commands execute in a single call. Comma chaining supports target inheritance
— repeated `set` calls reuse the last target:

```bash
hise-cli -builder "set MyGain.Gain -6, Balance 15, Bypass 0"
```

Verb inheritance also works for `add`:

```bash
hise-cli -ui "add ScriptButton \"Play\", ScriptSlider \"Volume\", ScriptPanel \"Header\""
```

**When NOT to use:** when you need to inspect intermediate results, or when
commands span different modes.

### .hsc script (multi-line, multi-mode)

```bash
hise-cli --run test.hsc
```

Use when the workflow **spans multiple modes**, needs **assertions**, or
should be **repeatable**. Scripts support mode switches, `/expect`
assertions, `/wait` pauses, `/callback` + `/compile` for HiseScript, and
the `/sequence` composer.

```hsc
# Build a module tree
/builder
add SineSynth as Lead
set Lead.Gain 0.5
/expect get Lead.Gain is 0.5
/exit

# Test script evaluation
/script
/expect Engine.getSampleRate() is 44100 within 1
/exit

# Play a test note (see §6 for why this is important)
/sequence
create "test_note"
0ms play C3 127 for 500ms
flush
play "test_note"
/exit
```

**Conventions:**

- Start `.hsc` files with `#!/usr/bin/env hise-cli run` to make them
  directly executable on Unix (`chmod +x test.hsc && ./test.hsc`).
- Use `/exit` after finishing work in each mode. This returns to the root
  prompt and keeps syntax highlighting clean in the TUI script editor.

For LLM tool use, the `--inline` flag avoids file I/O:

```bash
hise-cli --run --inline "/builder\nadd SineSynth\nshow tree"
```

### Decision tree

```
Need one thing done?
  └─ yes → single one-shot command
  └─ no
      Same mode, no intermediate inspection needed?
        └─ yes → comma chaining
        └─ no  → .hsc script
```

---

## 3. Undo and plan groups

Every mutation (add, remove, set, clone, rename, bypass) creates an undo
entry. Without plan groups, five `add` commands create five separate undo
steps — the user must undo five times to revert.

### When to use plan groups

**Use a plan group when making 2+ related mutations.** This batches them
into a single undo/redo step. The pattern:

```bash
hise-cli -undo 'plan "Add synth layer"'
hise-cli -builder "add SineSynth as Lead"
hise-cli -builder "add SimpleGain to Lead"
hise-cli -builder "add AHDSR to Lead.gain"
hise-cli -builder "set Lead.Gain 0.5"
hise-cli -builder "show tree"           # verify before committing
hise-cli -undo "apply"                  # finalize the group
```

To roll back everything: `hise-cli -undo "discard"` instead of `apply`.

### When unsure about the outcome

**If you are uncertain whether a command sequence will produce the right
result, always use a plan group.** Execute the commands, inspect the result
with `show tree` or `show <target>`, and then decide:

- Looks correct → `hise-cli -undo "apply"`
- Something wrong → `hise-cli -undo "discard"` (reverts everything)

This is especially important for LLM agents: plan groups give you a safe
rollback mechanism when you cannot visually verify the result.

### When NOT to use plan groups

- Single operations that are trivially correct (e.g. `set Volume -6`)
- Read-only commands (`show tree`, `show types`)

### Checking plan state

```bash
hise-cli -undo "diff"      # see what the current plan group changed
hise-cli -undo "history"   # see full undo history
```

---

## 4. Using the MCP server for research

The HISE MCP server provides structured access to documentation, API
signatures, module types, and community knowledge. Use it to research
before writing commands — the data is authoritative and saves failed
round-trips.

### Discovery: start with `explore_hise`

When you don't know which API classes or module types are involved, start
with `explore_hise`. It searches across API classes, documentation pages,
and video tutorials, returning class briefs, domain/role tags, factory
chains, and "when to use A vs B" distinctions.

```
explore_hise({ query: "how to play MIDI notes" })
explore_hise({ className: "Synth" })
explore_hise({ domain: "ui" })
explore_hise({ query: "modulation routing" })
```

This replaces guesswork — instead of assuming which class handles a task,
ask `explore_hise` and follow the graph to the right API.

### Reference lookup

Once you know which class or method you need:

| Tool | Use case |
|---|---|
| `query_scripting_api` | Method signatures, parameters, thread safety, pitfalls |
| `query_module_parameter` | Parameter ranges, defaults, and valid values |
| `query_ui_property` | UI component property details |
| `query_laf_function` | Look-and-feel paint function signatures |
| `list_module_types` | Browse all available module types by category |
| `list_ui_components` | Browse all UI component types |
| `list_scripting_namespaces` | Browse all HiseScript API namespaces |
| `list_laf_functions` | List LAF overrides for a component type |
| `hise_verify_parameters` | Validate method signatures before calling |

### Documentation and community

| Tool | Use case |
|---|---|
| `search_hise` | Keyword search across docs (API, UI, modules, scriptnode) |
| `get_doc_content` | Read full documentation page content |
| `get_tutorial` | Read video tutorial transcripts |
| `search_forum` | Search the HISE forum (quality-filtered) |
| `fetch_forum_topics` | Read specific forum topic threads |
| `search_examples` / `get_example` | Browse and read code examples |

### Always check parameter names and ranges

Parameter names and value ranges vary per module and are often not what
you'd guess:

- `SineSynth` has `Gain` (0-1 linear), not `Volume`
- `SimpleGain` has `Gain` (0-1) and `Balance` (-1 to 1)
- `LFO` has `Frequency` (0.01-40 Hz), not `Speed` or `Rate`

**Setting a wrong value can be destructive** — writing `50` when the range
is 0-1 means +34dB, which will clip and potentially damage speakers.

Before writing any `set` command, check the parameter:

```bash
# In builder mode: see all parameters with ranges
hise-cli -builder "show SineSynth"

# Via MCP: get full parameter details
query_module_parameter("SineSynth")
query_module_parameter("SineSynth.Gain")
```

### LLM best practice

**Research before guessing.** When uncertain about available types,
parameter names, API methods, or how to approach a task:

1. `explore_hise({ query: "your task description" })` — find the right classes
2. `query_module_parameter("ModuleType")` — check parameter names and ranges
3. `query_scripting_api("ClassName.method")` — get exact signature and pitfalls
4. Then write your hise-cli commands with confidence

This sequence avoids the common failure mode of guessing a parameter name,
getting it wrong, and wasting a round-trip to HISE.

---

## 5. Verifying state with `/expect`

The `/expect` command asserts that a command's result matches an expected
value. Use it in `.hsc` scripts to verify mutations, test assumptions, and
build repeatable test suites.

### Syntax

```
/expect <command> is <expected_value>
/expect <command> is <expected_value> within <tolerance>
/expect <command> is <expected_value> or abort
```

### How matching works

`/expect` compares the command's result against the expected value using:

1. **Truthy/falsy coercion:** `true` == `1` == `"true"`, `false` == `0`
2. **Numeric with tolerance:** `0.25` matches `"25%"`, respects `within`
3. **Case-insensitive exact string equality** (no substring matching)

This means `show tree` will **not** match a module name — it returns the
full multi-line tree dump. Use `get Module.Param` for single-value
assertions.

### `get` vs `show` in builder mode

| Command | Returns | Good for `/expect`? |
|---|---|---|
| `get Module.Param` | Single parameter value | Yes — exact value |
| `show Module` | All parameters, multi-line | No — too much text |
| `show tree` | Full tree dump | No — multi-line |
| `show types` | All module types | No — multi-line |

### Immediate state queries

Use `/expect` directly for state that is available immediately (not
dependent on audio timing):

```hsc
/script
# Sample rate (float — use within)
/expect Engine.getSampleRate() is 44100 within 1

# UI component values
/expect Content.getComponent("VolumeKnob").getValue() is 0.5 within 0.01

# Button state (0 or 1)
/expect Content.getComponent("BypassButton").getValue() is 0

# Combobox selection (1-based index)
/expect Content.getComponent("ModeSelector").getValue() is 1
```

```hsc
/builder
# Use get (not show) for single-value assertions
set MyGain.Gain 0.5
/expect get MyGain.Gain is 0.5
```

### Timing-sensitive queries: use sequence `eval`

**Do not use `/wait` + `/expect` for audio-timing-dependent state** (voice
counts, peak levels, playback position). The `/wait` approach is racy —
timing depends on system load and buffer size.

Instead, embed `eval` events inside a sequence at the exact time you need
the measurement. Results are stored by ID and retrieved after playback
with `get`:

```hsc
/sequence
create "voice_test"
0ms play C3 127 for 500ms
# Measure during the note (at 250ms the note is still playing)
250ms eval Synth.getNumPressedKeys() as DURING_NOTE
# Measure after the note has ended
600ms eval Engine.getNumVoices() as AFTER_NOTE
flush
play "voice_test"

# Retrieve stored results (must be in sequence mode)
/expect get DURING_NOTE is 1
/expect get AFTER_NOTE is 0
/exit
```

This is sample-accurate — the eval runs at exactly the specified time in
the audio timeline, not subject to system scheduling jitter.

More examples:

```hsc
/sequence
create "param_test"
0ms set MyFilter.Frequency 1000
0ms play C3 100 for 1s
# Check CPU after processing has settled
500ms eval Engine.getCpuUsage() as CPU
# Read a component value while audio is playing
500ms eval Content.getComponent("Meter").getValue() as METER
flush
play "param_test"

/expect get CPU is 0 within 15
/expect get METER is 0 within 1
/exit
```

### Float tolerance

Audio parameters are often floating-point. Always use `within` for float
comparisons:

```hsc
/expect Engine.getSampleRate() is 44100 within 1
/expect Content.getComponent("Knob").getValue() is 0.5 within 0.01
```

The default tolerance is 0.01. Specify a wider tolerance for values that
vary by system (CPU usage, peak levels) or a tighter one for precise
parameters.

### Abort on failure

By default, `/expect` collects results and continues. Add `or abort` to
stop the script immediately on failure — useful when later commands depend
on the assertion:

```hsc
/expect Engine.getSampleRate() is 44100 within 1 or abort
# ... commands that depend on this sample rate
```

---

## 6. Playing MIDI — always use sequence mode

**Never call `Synth.addNoteOn()` or `Synth.playNote()` via `-script`.**
These create notes that require explicit note-off handling. Without proper
event ID tracking and `noteOffByEventId()`, notes will hang indefinitely.

The sequence mode handles note-on, note-off, and timing automatically:

```bash
# Define a sequence
hise-cli -sequence "create \"test\""
hise-cli -sequence "0ms play C3 127 for 500ms"
hise-cli -sequence "flush"

# Play it
hise-cli -sequence "play \"test\""
```

Or in a .hsc script:

```hsc
/sequence
create "chord_test"
0ms play C3 80 for 1s
0ms play E3 80 for 1s
0ms play G3 80 for 1s
# Verify all 3 voices are active mid-playback
500ms eval Synth.getNumPressedKeys() as VOICES
# Verify voices have released after note-off
1.1s eval Engine.getNumVoices() as RELEASED
flush
play "chord_test"

# Retrieve stored results (must be in sequence mode)
/expect get VOICES is 3
/expect get RELEASED is 0
/exit
```

### Sequence capabilities

| Event type | Syntax |
|---|---|
| MIDI note | `0ms play C3 127 for 500ms` |
| Test signal | `0ms play sine at 440Hz for 1s` |
| Frequency sweep | `0ms play sweep from 20Hz to 20kHz for 2s` |
| CC message | `0ms send CC 1 64` |
| Pitchbend | `0ms send pitchbend 8192` |
| Module parameter | `0ms set Delay.Time 200` |
| UI component value | `0ms set Interface.VolumeKnob 0.5` |
| Script eval | `0ms eval Engine.getSampleRate() as sr` (retrieve with `get sr`) |

### Simulating UI interactions

Use `set Interface.<ComponentName> <value>` events to simulate user
interactions with UI components. This triggers the control callback and
any linked behavior (e.g. radio group mutual exclusion) — exactly as if
the user clicked the component.

```hsc
/sequence
create "ui_test"
0ms set Interface.Page2Btn 1
50ms eval page2.get("visible") as PAGE2_VIS
flush
play "ui_test"
/expect get PAGE2_VIS is true
/exit
```

### Reusing onInit variables in eval

`const var` references declared in `onInit` persist in the REPL scope.
Sequence `eval` events can use them directly — no need to repeat
`Content.getComponent()`:

```hsc
# In onInit:
#   const var myKnob = Content.getComponent("VolumeKnob");

# In sequence eval — use the variable directly:
0ms eval myKnob.getValue() as KNOB_VAL
```

### Recording output

```bash
hise-cli -sequence "record \"test\" as output.wav"
```

Captures the audio output of the sequence to a WAV file for offline
analysis or automated testing.

---

## 7. Writing and compiling HiseScript callbacks

To set up script callbacks (onInit, onNoteOn, etc.), use the `/callback`
collector — do not try to send full script files through `-script` eval.

```hsc
/script
/callback onInit
Content.makeFrontInterface(600, 500);

const var knob = Content.addKnob("Volume", 10, 10);

inline function onKnobControl(component, value)
{
    Synth.getEffect("SimpleGain").setAttribute(0, value);
}

knob.setControlCallback(onKnobControl);

/callback onNoteOn
Console.print("Note: " + Message.getNoteNumber());

/compile
/exit
```

The `/callback` command starts collecting raw lines for the named callback.
`/compile` wraps all collected callbacks, sends them to HISE via the script
API, and triggers recompilation. This is the correct way to set up
HiseScript logic from the CLI.

**Note:** Use `setControlCallback()` on individual components in `onInit`
rather than the legacy `onControl` callback. Each component gets its own
inline function — cleaner, faster, and easier to reason about.

**Do not call `changed()` during `onInit`** — it is silently skipped.
To set initial state, call `setValue()` and `showControl()` directly
instead of relying on a callback triggered by `changed()`.

### Verifying compilation

After `/compile`, verify the interface was created:

```hsc
/compile
/script
/expect Content.getComponent("Volume").getValue() is 0.5 within 0.01
```

---

## 8. Recommended workflow patterns

### Pattern: Build and verify a module tree

```hsc
# Wrap in a plan group for atomic undo
/undo
plan "Create synth layer"
/exit

/builder
add SineSynth as Lead
add SimpleGain to Lead.fx
add AHDSR to Lead.gain
set Lead.Gain 0.5
/expect get Lead.Gain is 0.5
/exit

/undo
apply
/exit
```

**Tip:** For test scripts that run repeatedly, start with `/builder reset`
to clear any leftover state from previous runs. Without this, repeated runs
accumulate duplicate modules (e.g. Lead, Lead2, Lead3).

### Pattern: Set up UI and connect to modules

Set component properties (layout, behavior) via `/ui` mode so they remain
editable in the HISE interface designer. Reserve the script for runtime
logic (callbacks, control flow).

```hsc
/ui
add ScriptSlider "VolumeKnob" at 10 10 128 48
add ScriptButton "BypassBtn" at 150 10 80 32
set BypassBtn.radioGroup 1
/exit

/script
/callback onInit
Content.makeFrontInterface(600, 500);

const var knob = Content.getComponent("VolumeKnob");
const var fx = Synth.getEffect("SimpleGain");

inline function onVolumeChange(component, value)
{
    fx.setAttribute(0, value);
}

knob.setControlCallback(onVolumeChange);
/compile
/expect Content.getComponent("VolumeKnob").getValue() is 0.5 within 0.01
/exit
```

### Pattern: Test audio output

```hsc
/sequence
create "smoke_test"
0ms play C3 100 for 500ms
500ms play E3 100 for 500ms
# Verify voices during playback
250ms eval Synth.getNumPressedKeys() as FIRST_NOTE
750ms eval Synth.getNumPressedKeys() as SECOND_NOTE
# Verify silence after both notes end
1.1s eval Engine.getNumVoices() as DONE
flush
play "smoke_test"

/expect get FIRST_NOTE is 1
/expect get SECOND_NOTE is 1
/expect get DONE is 0
/exit
```

---

## 9. Common mistakes to avoid

| Mistake | Correct approach |
|---|---|
| Calling `Synth.addNoteOn()` via `-script` | Use `/sequence` mode — handles note-off automatically |
| Making many mutations without a plan group | Wrap in `/undo plan` + `apply` for clean undo |
| Guessing module type names | Query with `show types` or the MCP `list_module_types` tool |
| Guessing parameter names | Use `show <module>` or MCP `query_module_parameter` |
| Setting values without checking ranges | Check range first — `50` on a 0-1 param means +34dB |
| Using `show` for `/expect` assertions | Use `get Module.Param` — `show` returns multi-line text |
| Putting `/expect get <ID>` at root level | Keep it inside the mode block (before `/exit`) |
| Using exact float comparison in `/expect` | Add `within <tolerance>` for floating-point values |
| Sending full scripts via `-script` eval | Use `/callback` + `/compile` for callback setup |
| Using the `onControl` callback | Use `setControlCallback()` per component in `onInit` instead |
| Using `/wait` + `/expect` for audio-timed state | Embed `eval` events in the sequence, retrieve with `get` after playback |
| Running commands without checking HISE connection | Run `hise-cli -hise "status"` first, then `launch` if needed |
| Not verifying after mutations | Add `/expect` assertions or use `show tree` / `show <target>` |
| Calling `changed()` during `onInit` | Silently skipped — use `setValue()` / `showControl()` directly |
| Using `setValue()` + `changed()` in sequence eval | Use `set Interface.ComponentName value` — triggers callbacks and radio groups |
| Setting component properties in script instead of `/ui` | Use `/ui set` for properties — keeps them editable in the interface designer |
| Adding a ScriptProcessor before scripting | Not needed — the default Interface script processor is always present |
