# CLI Grammar

Grammar for hise-cli across all modes (builder, ui, dsp).

## Notation

| Symbol | Meaning |
|--------|---------|
| `<x>` | required token |
| `[x]` | optional clause |
| `[a, b, c]` | array literal (commas required, whitespace flexible) |
| `\|` | alternative |

Optional brackets in syntax tables are EBNF; array brackets in examples and values are literal.

## Errors

Operations that reference non-existent identifiers fail loudly. `set X.field V` errors if `X` doesn't exist or `field` is unknown for `X`'s type. No silent creation of missing intermediate paths.

Exception: `create_parameter <container>.<name> ...` — the container path must exist; the final segment (`<name>`) must NOT exist (creates fresh). Errors if the parameter name already exists.

Reparenting (`set X.parent Y`) errors if it would create a cycle.

## Case sensitivity

Identifier matching (paths, fields, type names) is **case-insensitive**. Storage and output preserve the original casing as supplied at creation or as stored in HISE.

- `set master.volume -6` finds `Master.Volume`
- `add Synth as "Lead"` stores `Lead`; `get lead.bypassed` retrieves it; output reads `Lead`
- Ambiguous case-fold (two entities differing only by case) is rare in HISE; parser errors with both candidates listed.

Static documentation lookup uses `docs` and is backed by MCP. Live inspection uses `show` and is backed by HISE.

## CLI invocation layer

The shell CLI uses direct flag-style namespaces for builder, UI, and DSP automation:

```
hise-cli builder tree --agent
hise-cli builder add --type SimpleGain --id Drive --agent
hise-cli ui set --component Cutoff --bounds 0,0,128,32 --text Cutoff --agent
hise-cli dsp connect --module "Script FX1" --source LFO1 --target F1 --param Frequency --matched --agent
```

The mode grammar in the sections below is the internal command grammar used by the shared execution layer. The shell parser renders direct flag-style commands to that grammar before dispatching. Workflow files are executed with `hise-cli run <file>` or `hise-cli --run <file>`.

For builder, UI, and DSP direct commands, structural flags use the documented spelling. Dynamic property and parameter flags use exact HISE names and are case-sensitive:

```
hise-cli builder set --module Drive --Gain -6 --Balance 50 --agent
hise-cli ui set --component Knob --itemColour 0xFFFFFFFF --fontSize 14 --agent
hise-cli dsp set --module "Script FX1" --node F1 --skewFactor 0.3 --middlePosition 1000 --agent
```

Some direct flags represent nested control concepts and intentionally use hyphenated names:

```
--routing-send
--source-param
--source-output
```

The retired shell mode routes are not part of the public CLI grammar. Use direct namespaces instead:

```
hise-cli builder tree --agent
hise-cli ui tree --agent
hise-cli dsp tree --module "Script FX1" --agent
```

Direct script subcommands avoid quoting callback bodies on the command line:

```
hise-cli script repl --module-id Interface --stdin --agent
hise-cli script get --module-id Interface --callback onInit --agent
hise-cli script add-file UI/MyFile.js --module-id Interface --agent
hise-cli script set --module-id Interface --callback onInit --file ./onInit.js --agent
hise-cli script compile --module-id Interface --agent
```

`script set` compiles and snapshots touched HISE callback slots by default. If compile fails, the CLI restores those callback slots and returns the original error with a `rollback` object. This protects callback source stored in HISE, not external script files referenced by `include(...)`. Use `--no-rollback` only when intentionally staging invalid callback source, and run `hise-cli script diagnose --file-path <file> --agent` before compiling larger external-file edits.

`script add-file <relativePath.js>` creates a new namespaced script file under the active project's Scripts folder, appends `include("<relativePath.js>");` to `onInit`, compiles, and returns the absolute path for follow-up edits. The file basename must be a valid namespace identifier, so `UI/MyFile.js` creates `namespace MyFile {}`. The command is idempotent: existing files are not overwritten, existing include lines are not duplicated, and a file that already exists and is already included returns success without recompiling.

`--module-id <id>` already uses the safe separated flag form. Do not use colon-style module-id flags.

## Output formats

Default one-shot CLI output is pretty text. Use output flags for machine consumers:

- `--json` emits structured JSON.
- `--compact` removes empty wrapper noise from the final payload only; it does not alter mode semantics.
- `--select <path>` extracts a field from the final payload while preserving `{ ok, value }`; it implies JSON output.
- `--agent` implies `--json --compact` and guarantees failure payloads include a stable `code` field.

Agent-safe tree queries must return structured JSON, not terminal-only tree art:

```
hise-cli builder tree --agent
hise-cli ui tree --agent
hise-cli dsp tree --module "Script FX1" --agent
```

Error payload shape under `--agent`:

```
{ "ok": false, "code": "hise_api_error", "error": "..." }
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | generic execution error |
| 2 | usage error or `--select` path not found |
| 3 | HISE unavailable / transport error |
| 4 | HISE API error |
| 5 | validation error |
| 6 | expectation failure |

`show <noun>` returns matching entries in CLI output and table-style displays in the TUI.

## Paths and identifier resolution

Instance IDs are unique within a project. Type names (`SineSynth`, `Compressor`) are class names from the type catalog, not instance IDs. Default instance IDs match the type name when only one of that type exists, but disambiguation is by parent path, not type. Shared chain ids (`Gain`, `Pitch`, `Velocity`) become unique once anchored to their parent (`SineSynth.Pitch` ≠ `SquareSynth.Pitch`).

Two path forms only — no slash absolute syntax:

- **Bare ID** (`Compressor`) — unique-instance project lookup. Errors if missing or ambiguous.
- **Dotted path** (`SineSynth.Pitch.VelMod`) — anchored path used to disambiguate shared chain ids or to be explicit about location. Resolves left-to-right from project root.

### Navigation (`cd`/`ls`/`pwd`)

`cd` is the **only** command where bare paths are cwd-relative before falling back to unique-project lookup. All other verbs always use unique-project lookup.

- `cd <name>` — descend into a child of cwd if one exists; otherwise unique-project lookup
- `cd ..` — up one level
- `cd <dotted.path>` — walk dotted path (relative or anchored at any prefix)
- `pwd` / `ls` — current path / children

Per-mode hierarchy and landing on mode entry:

| Mode | Top entities | Path shape | `/<mode>` lands at | `/<mode> <X>` lands at | Navigation |
|------|--------------|------------|--------------------|------------------------|------------|
| Builder | `Master` (sole project root) | `Master.<chain>.<module>` | `Master` | n/a | `cd`/`ls`/`pwd` |
| UI | scripts | `<Script>.<components>` | `Interface` | `<X>` | `cd`/`ls`/`pwd` |
| DSP | host modules with networks | `<ScriptFX>.<NetworkName>.<nodes>` (root container named after the assigned network) | host-module selection (no entity selected yet) | n/a | `cd <ScriptFX>` selects the host module; after selection, `cd`/`ls`/`pwd` navigate nodes |

## Core rules

1. **Prepositions have one global role.** `to` = destination (parent slot or wire target). `as` = name. `file`, `scale` = labeled roles for multi-slot verbs.

2. **`add` creates an entity in the current container, or at an explicit parent via `to <parent>`.** Signature: `add <type> as "<name>" [to <parent>]`. Without `to`, the cwd is the parent. Explicit add aliases are exact: hise-cli never silently accepts HISE auto-renaming for `add ... as "Name"`. If the requested ID already exists, the command fails before mutation with `duplicate_id` and candidate paths. In builder mode, use `clone <target> <count>` to create auto-renamed copies. **The `to` clause is forbidden in comma-chained `add` statements** — chained adds use cwd only. To add multiple entities at a non-cwd parent, `cd` to that parent first.

Builder-specific `add` note: HISE automatically adds a `SimpleEnvelope` named `DefaultEnvelope`, `DefaultEnvelope2`, etc. to every new sound-producing `SoundGenerator`; container-only generators are exempt. For nested modulation chains, quote the chain segment, e.g. `add LFO as "LeadGainLFO" to Lead."Gain Modulation"`.

3. **Coordinates and bounds are JS arrays.** `[a, b, c, d]`. Commas required.

4. **Strings are quoted when multi-word.** Single-word identifiers may be bare. Quoted strings escape keyword recognition.

5. **`set`/`get` are symmetric across all paths.** `set X.field V` ↔ `get X.field`. No optional `to` on set. Reparent, bypass, position, resize, reorder all express as `set` writes.

6. **`show` is the universal query verb — progressive disclosure for exploration.** Three forms:
   - `show <noun>` — catalog (`tree`, `types`, `networks`, `modules`, `connections`; mode-restricted set).
   - `show <id>` — instance summary (parameter IDs, child mod chains, routing matrix, bypass state). No values.
   - `show <id>.<param>` — parameter detail (id, range, defaultValue, value, valueAsString, items? for enums).
   `get` is reserved for single-scalar lookups consumed by `/expect` (`get <id>.<field>` returns one value).

7. **Comma chaining inherits the verb only.** Every clause provides full arguments and full identifier paths. No prefix or target inheritance. The current working directory (`cwd`) applies to every clause in the statement (e.g. `add Filter as "LP", Filter as "HP"` adds both at cwd).

8. **Naming uses `as "<name>"`.** Quoted, with the `as` keyword. One form across all modes. Names after `as` are always quoted strings, even for single-word names — this overrides the general "single-word identifier may be bare" rule.

## Keyword inventory

| Keyword | Meaning | Form |
|---------|---------|------|
| `as` | naming | `as "<name>"` |
| `to` | destination | `to <id>` |
| `file` | path | `file "<path>"` |
| `scale` | render multiplier (1.0 = full size) | `scale <N>` |
| `matched` | DSP normalize flag | trailing |

Range/curve clauses for `create_parameter`: `default`, `stepSize`, `middlePosition`, `skewFactor`.

## Numeric arrays

Array literals are whitelisted by arity. Only fixed-shape forms are valid; arbitrary lists like `[100, 200, 300]` are parse errors.

| Arity | Form | Used by fields |
|-------|------|----------------|
| 2 | `[a, b]` | `position` (int), `size` (int), `range` (number), `create_parameter` min/max (number) |
| 4 | `[a, b, c, d]` | `bounds` (int) |
| N | `[a, b, …, n]` | `routing` (int), `routing.send` (int) — length 1..NUM_MAX_CHANNELS |

Elements are numbers (integer or float). Percent literals are **not** allowed inside arrays — `position`, `size`, `bounds` are integer pixel values; `range` is a numeric pair. The `N`-arity form is restricted to routing fields and carries destination-channel indices (or `-1` for unconnected). Adding a new array-typed field requires extending the grammar with a new array production.

## Percent literal

`<N>%` is a value token that the parser normalizes to `<N> / 100` (float). Accepted in any value position globally.

```
set Sine1.Gain 50%             # equivalent to: set Sine1.Gain 0.5
screenshot scale 50%           # equivalent to: scale 0.5
```

## Boolean values

`true` and `false` are accepted aliases for the integers `1` and `0` in value positions. The receiving field's type determines whether the value is interpreted as boolean, integer, or float — `set g1.Gain 1` writes numeric 1, `set Button.visible 1` writes boolean true.

```
set Button.visible true        # equivalent to: set Button.visible 1
set g1.bypassed false          # equivalent to: set g1.bypassed 0
```

## Hex literal

`0xAARRGGBB` — exactly 8 hexadecimal digits. The byte order is alpha, red, green, blue. Used for colour-typed fields (`NodeColour`, theme colours, etc.). Parser stores the literal as a 32-bit unsigned integer.

Shorter forms are parse errors so callers cannot silently omit the alpha channel. To get a fully-opaque colour, prefix `FF`: `0xFF<RGB>` (e.g. `0xFFFFAA00` for opaque orange). The lowercase `0x` prefix is required; `0X...` does not lex.

```
set core1.NodeColour 0xFF8800AA    # opaque RGB 88 00 AA
set core1.NodeColour 0x8000FF00    # 50% transparent green
set core1.NodeColour 0xFFAA00      # ERROR: 6 digits, alpha missing
```

## Builder mode

Lands at `Master`. Type names are HISE module classes (`SineSynth`, `Filter`, `ScriptFX`, …). Discover with `docs`. Builder edits persist live to the project — no `save` verb. (`save` is DSP-only, for network persistence.)

| Verb | Syntax |
|------|--------|
| `add` | `add <type> as "<name>" [to <parent>]` |
| `clone` | `clone <target> <count>` (count required; clones placed as siblings; ids derived by bumping trailing integer of source name, or appending `1` if none. Auto-skips already-taken ids: `clone Lead 3` when `Lead1` exists → `Lead2`, `Lead3`, `Lead4`) |
| `remove` | `remove <target>` (containers remove children recursively; removing cwd jumps to root; removing root is an error) |
| `rename` | `rename <target> as "<name>"` |
| `set` | `set <target>.<field>[.<subfield>] <value>` |
| `get` | `get <target>.<field>[.<subfield>]` (single scalar; for structural exploration use `show`) |
| `show` | `show tree` \| `show <target>` \| `show <target>.<param>` (live HISE state only) |
| `docs` | `docs` \| `docs <moduleType>` \| `docs <moduleType>.<param>` (static MCP documentation) |
| `cd` / `ls` / `pwd` | navigation |
| `reset` | `reset` (clears project to empty Master) |

Asset reference fields (write only quoted names; no path resolution):
- `samplemap` — looks up named samplemap in project assets (`set Sampler1.samplemap "My Piano"`).
- `effect` — looks up compiled hardcoded effect by name (`set MasterFX.effect "my_cpp_fx"`).
- `network` — DSP network reference. Dispatches to `POST /api/dsp/init` with body `{ name, mode }`:

  | Surface | `name` body | `mode` body | Failure |
  |---------|-------------|-------------|---------|
  | `set X.network "my_dsp"` (bare) | `"my_dsp"` | `"create"` | errors if `my_dsp.xml` already exists; message suggests the `.xml` form |
  | `set X.network "my_dsp.xml"` | `"my_dsp"` (extension stripped) | `"load"` | errors if `my_dsp.xml` is missing |

Routing matrix fields (instances implementing `RoutableProcessor` — synth chains, samplers, effects, hardcoded modules):
- `routing` — channel routing matrix. Two write forms:
  - Array: `set <proc>.routing [d0, d1, …]` — index = source channel, value = destination channel index (or `-1` for unconnected). Array length implicitly calls `setNumChannels(arr.length)`; errors if length differs from current and `routing.resizable` is `false`.
  - Preset: `set <proc>.routing "<preset>"` where `<preset>` ∈ {`stereo`, `stereo_2`, `stereo_3`, `all`, `all_to_stereo`}.
  - Clear via `set <proc>.routing [-1, -1, …]`.
  - `get <proc>.routing` returns the array form.
- `routing.send` — parallel send bus. Same array shape as `routing`. Length must equal current source-channel count (no implicit resize through this field).
- Read-only subfields (read via `get`; appear in `show <proc>` output):
  - `routing.resizable` — boolean; whether `setNumChannels` is permitted.
  - `routing.routable` — boolean; if `false`, only diagonal writes (`src N → dst N`) are accepted. Cross-channel writes error.
  - `routing.numDestinationChannels` — integer; pinned by parent context, not writable.

Examples:

```
add Synth as "Lead"                                # adds at cwd (Master on entry)
cd Lead
add Filter as "LP"
add VelocityModulator as "VelMod" to SineSynth.Pitch     # one-shot create-at-parent
clone Lead 3
set Lead.parent Compressor
set Lead.bypassed 1
set Lead.bypassed 0
rename Lead as "MainSynth"
set Master.Volume -6
set Master.Volume -6, Master.Pan 0
set Sampler1.samplemap "My Piano"
set ScriptFX1.network "my_dsp"
set ScriptFX1.network "my_dsp.xml"
set MasterFX.effect "my_cpp_fx"
set Synth1.routing [0, 1, -1, -1]
set Synth1.routing.send [-1, -1, 2, 3]
set Synth1.routing "stereo"
set Synth1.routing [-1, -1]                        # clear all connections
get Synth1.routing
get Synth1.routing.routable
docs
docs AHDSR.Attack
show tree
show Master.Lead                                   # module summary
show Master.Lead.Volume                            # parameter detail
```

## UI mode

Auto-lands inside `Interface` (the default UI script). Power user: `/ui OtherScript` to enter another script. Component types are HISE component classes (`Button`, `Slider`, `Panel`, …).

`add ... to <parent>` accepts container-capable components only (`Panel`, `FloatingTile`, etc.). Adding to a non-container component is an error.

| Verb | Syntax |
|------|--------|
| `add` | `add <type> as "<name>" [to <parent>]` |
| `remove` | `remove <target>` (containers remove children recursively; removing cwd jumps to root; removing root is an error) |
| `set` | `set <target>.<field> <value>` |
| `get` | `get <target>.<field>` (field required) |
| `connect` | `connect <component> to <processor>.<parameter> [matched]` |
| `rename` | `rename <target> as "<name>"` |
| `show` | `show tree [<filter>]` \| `show <target>` \| `show <target>.<prop>` (live HISE state only) |
| `docs` | `docs` \| `docs <componentType>` \| `docs <componentType>.<prop>` (static MCP documentation) |
| `cd` / `ls` / `pwd` | navigation |
| `reset` | `reset` (returns cwd to `Interface`; component tree is unaffected — use `remove` to delete components) |

Component fields: `bounds [x, y, w, h]`, `position [x, y]`, `size [w, h]`, `x`, `y`, `width`, `height`, `parent`, `index`, `text`, `value`, plus type-specific properties.

`set X.value V` writes the runtime control value via `/api/set_component_value` (separate from the `set_attributes` apply path used for static properties). `set X.parent Y` and `set X.index N` reparent / reorder; both translate to a `move` op on `/api/ui/apply`.

`connect X to Processor.Parameter` links UI controls to module parameters by setting `processorId` and `parameterId`. Compatible pairs are validated against `/api/builder/tree?verbose=true`: `ScriptSlider` ↔ `Slider`, `ScriptComboBox` ↔ `ComboBox`, and `ScriptButton` ↔ `Button`. With `matched`, slider range metadata copies `min`, `max`, `defaultValue`, `mode`, `stepSize`, `middlePosition`, and `unit` as `suffix`; comboboxes copy `items` and `defaultValue`; buttons copy the parameter name to `text` and copy `defaultValue`.

Examples:

```
add Button as "Play"
set Play.bounds [100, 200, 80, 32]
add Slider as "Volume"
set Volume.bounds [200, 100, 24, 200]
set Play.position [120, 200]
set Play.size [100, 40]
set Play.parent Panel, Play.index 0
set Play.text "Play Now"
set Play.x 120, Play.y 220
connect Cutoff to MainFilter.Frequency matched
connect Waveform to LFO.WaveformType matched
connect EnableFilter to MainFilter.Enabled matched
rename Play as "PlayBtn"
docs
docs ScriptSlider.mode
show Play.text
```

## DSP mode

Operates on a scriptnode network. Enter DSP mode with `/dsp`, then select the host module with `cd <ScriptFX>` (the host module's network must already be assigned in builder via `set <ScriptFX>.network "..."`). The network's root container is named after the network itself (`set MyFX.network "my_dsp"` → root container is `my_dsp`). Direct `/dsp <ScriptFX>` and `/dsp.<ScriptFX>` context entry syntax is not valid; use `/dsp` followed by `cd <ScriptFX>`.

`add` uses `<factory>.<node>` syntax — factory is a node library namespace (`core`, `math`, `filters`, …); node is the type within that library.

`matched` (on `connect`) — without `matched`, source values map from the source's range to the target's range. With `matched`, the source range copies the target range so values pass through unmodified.

`disconnect <nodeId>.<paramName>` — removes the single connection on that parameter. The path always ends in the actual parameter name (`Gain`, `Frequency`, `Cutoff`, …). Each target has at most one source, so source is never specified. Node-level `disconnect <nodeId>` (no param) is invalid.

| Verb | Syntax |
|------|--------|
| `add` | `add <factory>.<node> as "<alias>" [to <network-path>]` |
| `remove` | `remove <nodeId>` (containers remove children recursively; removing cwd jumps to root; removing root is an error) |
| `connect` | `connect <src>[.<output>] to <targetNode>[.<paramName>] [matched]` (for modulation/parameter targets, path ends in the parameter name (`gain.Gain`); for routing targets (`routing.send` → `routing.receive`), `.<paramName>` may be omitted. Source `.<output>` may be omitted only when source has a single output) |
| `disconnect` | `disconnect <nodeId>.<paramName>` (path ends in the parameter name; each param target has at most one source, so source never specified) |
| `set` | `set <id>.<field> <value>` \| `set <id>.<param> <value>` \| `set <id>.<param>.<field> <value>` (node fields include `parent`, `index`, `bypassed`, `name`, `NodeColour`, `Comment`, `Folded`; param fields ∈ {`range`, `min`, `max`, `stepSize`, `middlePosition`, `skewFactor`}) |
| `get` | same path shapes as `set` plus read-only `<id>.<param>.<source>`, `<id>.<param>.<parent>` |
| `rename` | `rename <nodeId> as "<newId>"` |
| `save` | `save` (writes current network to disk if file-backed; embeds in project if in-memory) |
| `reset` | `reset` (clears network to empty `root`) |
| `screenshot` | `screenshot scale <N> file "<path>"` |
| `show` | `show tree` \| `show networks [<filter>]` \| `show modules [<filter>]` \| `show connections [<filter>]` \| `show <nodeId>` \| `show <nodeId>.<param>` (live HISE state only) |
| `docs` | `docs` \| `docs <factory>` \| `docs <factory.node>` \| `docs <factory.node>.<param>` (static MCP documentation) |
| `create_parameter` | `create_parameter <container>.<paramName> [<min>, <max>] [default <d>] [stepSize <s>] [middlePosition <m>] [skewFactor <k>]` (`<paramName>` is the new parameter's id, e.g. `Cutoff`, `Drive`) |
| `cd` / `ls` / `pwd` | navigation |

Examples:

```
/dsp
cd MyScriptFX                                                         # selects host module; cwd is MyScriptFX.my_dsp
add core.gain as "g1"
add core.osc as "osc1"
set osc1.index 0
connect osc1 to g1.Gain matched
disconnect g1.Gain
set g1.Gain 1.5
set g1.Gain.range [0, 2]
set g1.Gain.skewFactor 0.3
set g1.Gain.range [0, 2], g1.Gain.skewFactor 0.3, g1.Gain.stepSize 0.01
set MicPairSelector.NodeColour 0xFF2F80ED
set MicPairSelector.Comment "**Mic pair selector** - Routes one stereo pair into the FX chain."
set CabGlueComp.Folded true
set g1.parent root2
set g1.index 0
set g1.bypassed 1
set g1.bypassed 0
get g1.Gain.source
get g1.Gain.parent
get g1.Gain.max
show networks
docs filters
docs filters.svf.Frequency
show connections
show g1                                           # node summary
show g1.Gain                                      # parameter detail
screenshot scale 50% file "patch.png"
create_parameter root.Cutoff [20, 20000] default 1000 stepSize 1 skewFactor 0.3
```

## Quoting

- Single-word identifier (no spaces, no special chars): bare or quoted, equivalent.
- Multi-word string: quotes required.
- Reserved word in path position (after `.`): bare. `add math.add as "x"`, `set X.range [...]`, `set X.min 0` — all fine.
- Reserved word in identifier-start position (where it could be parsed as a verb or role keyword): quotes required. Both verb-keywords and role-keywords work quoted: `add Synth as "to"`, `add Synth as "as"`, `add Filter as "set"` — all create nodes named literally `to`, `as`, `set`.
- Quoted identifier always wins over keyword recognition. `show "tree"` queries a node named `tree`, not the tree listing.
- Quoted segments inside dotted paths bypass keyword recognition for that segment. After `add Synth as "to"`, the node is referenced via `set "to".bypassed 1` or `cd "to"` — the quoted segment is one identifier in the path.

## Comma chaining

Only the verb inherits across commas. Every clause provides full arguments and full identifier paths. Each verb defines what its clause shape is (see BNF).

Verbs that support chaining: `set`, `get`, `add`, `remove`, `connect`, `disconnect`. Other verbs are single-statement only.

```
set Master.Volume -6, Master.Pan 0
set Play.x 120, Play.y 220
set g1.Gain.range [0, 2], g1.Gain.skewFactor 0.3, g1.Gain.stepSize 0.01
connect lfo to g1.Gain, lfo to g2.Pan
add Synth as "A", Synth as "B"
set A.bypassed 1, B.bypassed 1
remove A, B, C
```

## Reserved words

Verbs and role keywords are reserved across all modes. Using any of them as an identifier requires quoting.

Verbs: `add`, `remove`, `rename`, `clone`, `set`, `get`, `save`, `show`, `cd`, `ls`, `pwd`, `reset`, `connect`, `disconnect`, `screenshot`, `create_parameter`.

Catalog nouns following `show` (mode-restricted): `tree`, `types`, `networks`, `modules`, `connections`. These are reserved as direct arguments to `show` only — they may still appear inside dotted paths after a quoted segment escape.

Role keywords: `as`, `to`, `file`, `scale`, `matched`, `default`, `stepSize`, `middlePosition`, `skewFactor`.

Field names (after dot in `set`/`get` paths), grouped by scope:

- **Universal** (any entity): `parent`, `index` (zero-based sibling order; `-1` = append at end), `bypassed`, `name` (display label only — to change identity use `rename`; `id` is the path itself, not a field)
- **Builder** (HISE modules): `samplemap`, `network`, `effect`, `routing` (with subfield `routing.send` and read-only `routing.resizable`, `routing.routable`, `routing.numDestinationChannels`), plus module-type-specific properties (e.g. `Volume`, `Pan`)
- **UI** (components): `bounds`, `position`, `size`, `x`, `y`, `width`, `height`, `text`, plus type-specific properties
- **DSP** (node attributes): `NodeColour`, `Comment`, `Folded`, plus supported node-specific direct attributes such as `IsVertical` and `ShowParameters` where present. These are written with `set <node>.<field> <value>` and are primarily used for graph layout, comments, and screenshot styling.
- **DSP** (parameter subfields): `range`, `min`, `max`, `stepSize`, `middlePosition`, `skewFactor`, `source` (read-only)

## Grammar (BNF)

Each verb has its own production with verb-specific comma continuation. Verbs that don't list `(',' ...)*` accept one statement only (no comma chaining).

```
Statement            := AddStmt | RemoveStmt | RenameStmt | CloneStmt
                     |  SetStmt | GetStmt | ShowStmt
                     |  CdStmt | LsStmt | PwdStmt
                     |  ResetStmt | SaveStmt
                     |  ConnectStmt | DisconnectStmt
                     |  ScreenshotStmt | CreateParameterStmt

AddStmt              := SingleAdd | ChainedAdd
SingleAdd            := 'add' TypeRef 'as' QuotedString ['to' PathExpr]
ChainedAdd           := 'add' AddClause (',' AddClause){1,}     ; ≥2 clauses, no 'to' permitted
AddClause            := TypeRef 'as' QuotedString               ; cwd-only in chained form

RemoveStmt           := 'remove' PathExpr (',' PathExpr)*
RenameStmt           := 'rename' PathExpr 'as' QuotedString
CloneStmt            := 'clone' PathExpr Number

SetStmt              := 'set' SetClause (',' SetClause)*
SetClause            := DottedPath Value                     ; ≥2 segments — bare node assignment is invalid

GetStmt              := 'get' DottedPath (',' DottedPath)*

ShowStmt             := 'show' (ShowNoun [Filter] | PathExpr)    ; PathExpr ≥2 segs = parameter detail
ShowNoun             := BuilderShowNoun | UiShowNoun | DspShowNoun  ; mode-restricted

CdStmt               := 'cd' PathExpr
LsStmt               := 'ls'
PwdStmt              := 'pwd'

ResetStmt            := 'reset'
SaveStmt             := 'save'

ConnectStmt          := 'connect' ConnectClause (',' ConnectClause)*
ConnectClause        := PathExpr 'to' PathExpr ['matched']  ; validator: target must include .paramName unless target is a routing node
DisconnectStmt       := 'disconnect' DottedPath (',' DottedPath)*

ScreenshotStmt       := 'screenshot' 'scale' ScalarValue 'file' QuotedString

CreateParameterStmt  := 'create_parameter' DottedPath Array2
                        ['default' Number] ['stepSize' Number]
                        ['middlePosition' Number] ['skewFactor' Number]

TypeRef              := Identifier ['.' Identifier]          ; 2-segment for DSP factory.node
BuilderShowNoun      := 'types' | 'tree'
UiShowNoun           := 'tree'
DspShowNoun          := 'networks' | 'modules' | 'connections' | 'tree'
Filter               := QuotedString | BareWord

PathExpr             := DottedPath | BarePath | '..'
DottedPath           := Identifier ('.' Identifier)+         ; ≥2 segments, dot-separated
BarePath             := Identifier                            ; single segment

Value                := QuotedString | Number | Percent | Boolean | HexLiteral | ArrayValue | PathExpr
ArrayValue           := Array2 | Array4 | ArrayN              ; whitelist; new arities added explicitly
Array2               := '[' Number ',' Number ']'             ; for fields: position, size (int), range (number)
Array4               := '[' Number ',' Number ',' Number ',' Number ']' ; for fields: bounds (int)
ArrayN               := '[' Number (',' Number)* ']'          ; for fields: routing, routing.send (1..NUM_MAX_CHANNELS integers, dst-channel indices or -1)
ScalarValue          := Number | Percent                      ; used outside arrays (e.g. screenshot scale)
Number               := IntLit | FloatLit
Percent              := Number '%'
Boolean              := 'true' | 'false'                     ; aliases for 1/0; field type decides interpretation
HexLiteral           := /0x[0-9a-fA-F]{8}/                    ; exactly 8 digits — AARRGGBB; shorter forms are parse errors
IntLit               := /[+-]?[0-9]+/
FloatLit             := /[+-]?([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+\.?[0-9]*[eE][+-]?[0-9]+)/   ; permissive: .5, 1., 1.5, 1e-3, 2.5E+10, +1.0

QuotedString         := '"' (EscapedChar | NonQuote)* '"'
EscapedChar          := '\' ('"' | '\' | 'n' | 't' | 'r')   ; standard JSON escapes
NonQuote             := /[^"\\]/

Identifier           := BareWord | QuotedString
BareWord             := /[A-Za-z_][A-Za-z0-9_]*/

Comment              := ('#' | '//') /[^\n]*/                 ; line comment, ignored by parser
```
