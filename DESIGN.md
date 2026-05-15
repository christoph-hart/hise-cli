# DESIGN.md - hise-cli REPL Architecture v2

> Comprehensive design document for the hise-cli modal REPL system.
> Covers architecture, mode grammars, protocol specification, and design rationale.
>
> Implementation tracked in [Milestone: 1.0.0](https://github.com/christoph-hart/hise-cli/milestone/2)

---

## Vision

hise-cli is a modal REPL and command-line interface for
[HISE](https://hise.dev), an open-source framework for building audio
plugins. It serves two audiences through two frontends sharing one engine:

- **Humans** use the TUI (terminal UI) - an interactive Ink/React app with
  colored output, progress bars, tab completion, and keyboard navigation.
- **LLMs and automation tools** use the CLI - non-interactive, argument-based
  invocation with structured JSON output.

The app is a **smart client**: it parses commands, renders output, provides
tab completion, and performs type-level validation locally using shipped JSON
datasets (`moduleList.json`, `scripting_api.json`). HISE handles execution,
instance-level validation, and runtime state. The CLI never replicates
HISE's execution logic, but it can catch type errors, invalid parameter
names, out-of-range values, and wrong chain/module combinations instantly
without a round-trip to HISE.

---

## Architecture

### Three-Layer Design

```
src/
  engine/          Shared core - zero UI dependencies
    commands/      Command registry, dispatcher, parsers
    modes/         Mode definitions
    completion/    Tab completion engine
    highlight/     Per-mode syntax highlighting tokenizers, span splitting
    plan/          Plan mode state + script generation (planned)
    validation/    Local type-level validation (planned)
    wizard/        Wizard framework (planned — Phase 5)
    result.ts      CommandResult + TreeNode types
    session.ts     Mode stack, history, session state
    hise.ts        HiseConnection interface + HTTP implementation
    data.ts        DataLoader interface
  tui/             TUI frontend - Ink/React
    app.tsx        Main TUI app (central key dispatch)
    components/    Output, Input, CompletionPopup, TreeSidebar, LandingLogo,
                   TopBar, StatusBar, Overlay, scrollbar
    nodeDataLoader.ts  Node.js DataLoader implementation
  cli/             CLI helpers for one-shot JSON output
```

The engine has **no dependency** on Ink, React, or any terminal UI library.

### Isomorphic Engine

The engine layer must be **isomorphic** — it runs in both Node.js and
browser environments. This enables a web frontend (see below) alongside
the terminal TUI and CLI, all sharing the same command engine.

**Constraints on `src/engine/`:**

1. **No `node:` imports** — no `node:fs`, `node:path`, `node:child_process`,
   `node:os`, or any other Node.js builtins. This extends the existing rule
   of no Ink/React imports.

2. **`DataLoader` interface** for static dataset access:
   ```ts
   interface DataLoader {
     loadModuleList(): Promise<ModuleList>;
     loadScriptingApi(): Promise<ScriptingApi>;
     loadScriptnodeList(): Promise<ScriptnodeList>;
   }
   ```
   - Node.js implementation: reads from `data/*.json` via `fs.readFileSync()`
     (lives in `src/tui/` or `src/cli/`, not in engine)
   - Browser implementation: `import` from bundled JSON or `fetch()` from URL

3. **`PhaseExecutor` interface** for shell command execution:
   ```ts
   interface PhaseExecutor {
     spawn(command: string, args: string[], options: {
       cwd?: string;
       env?: Record<string, string>;
       onLog?: (line: string) => void;
       signal?: AbortSignal;
     }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
   }
   ```
   This is the low-level process spawner. Wizard `PipelinePhase.execute()`
   functions use `PhaseExecutor` internally to run shell commands (git,
   compilers, etc.). The relationship: `PipelinePhase` is the high-level
   wizard abstraction, `PhaseExecutor` is the platform-specific shell
   access it delegates to.
   - Node.js implementation: `child_process.spawn()` (lives in `src/tui/`
     or `src/cli/`)
   - Browser: pipeline steps are disabled (shell scripts can't run in a
     browser). The web frontend skips pipeline wizards or delegates
     execution to a backend.

4. **`HiseConnection` uses `fetch()`** — works identically in Node.js 18+
   and browsers. No change needed.

5. **Theme as data** — color values are hex strings in the engine. Terminal
   escape codes are TUI-specific. CSS custom properties are web-specific.
   Both derive from the same hex values defined in the engine. In the TUI,
   a `ThemeContext` provides all colors to the component tree via
   `useTheme()`. This enables the overlay dimming system: wrapping
   components in a `ThemeProvider` with `darkenScheme()` values makes
   every component render dimmed without any code changes. See
   TUI_STYLE.md §1.7–1.8 for details.

### Data Flow

```
                    +-------------------------------+
  TUI (human)       |         Command Engine        |       HISE
  -------------     |                               |     ---------
  Ink/React    ---> |  parse --> validate --> send   | --> HTTP REST API
  keyboard input    |  (local)   (local+HISE)       |     localhost:1900
  colored output <--|  format <-- result <-- recv    | <-- JSON responses
                    |                               |
  CLI (LLM)         |  Modes, completion, plan,     |     SSE endpoint
  -------------     |  module tree tracking         |     (push events)
  args + flags ---> |                               |
  JSON output  <--  |                               |
                    |                               |
  Web (future)      |                               |
  -------------     |                               |
  React DOM    ---> |                               |
  browser input     |                               |
  HTML/CSS     <--  +-------------------------------+
```

### Web Frontend (Future)

A browser-based frontend consuming the same engine layer. Three use cases,
in order of priority:

**Demo / playground** (no HISE needed): A hosted website that demonstrates
the hise-cli interface with `MockHiseConnection` and bundled static datasets.
Interactive command entry, tab completion, wizard walkthrough, module type
browsing — all with fake data. Deployable to GitHub Pages or Vercel. Serves
as documentation, training tool, and marketing asset.

**Local companion** (same machine as HISE): A browser UI at
`localhost:3000` connecting to HISE at `localhost:1900`. Same data flow as
the TUI, richer rendering: proper tables, resizable panes, syntax-highlighted
code editor, drag-and-drop module tree. No CORS issues (same origin or
simple header).

**Remote access** (different machine): Access HISE over the network from a
tablet or laptop. Requires HISE to bind to `0.0.0.0` (currently hardcoded to
`127.0.0.1`), authentication (the REST API has no auth — `/api/repl` can
execute arbitrary code), and WebSocket/SSE for efficient push over WAN. The
`HiseConnection` already accepts arbitrary `host:port`.

**Terminal aesthetic in the browser**: The TUI's monospace grid, Monokai
colors, box-drawing characters, and mode prompts are replicated via CSS:
monospace font, hex colors as CSS custom properties, Unicode box-drawing
characters rendered natively. The result looks like a terminal but has web
superpowers: hover tooltips, clickable elements, smooth scrolling, resizable
panels, responsive layout.

```
src/
  engine/      ← shared, isomorphic (zero platform deps)
  tui/         ← Ink/React terminal (Node.js only)
  cli/         ← JSON output (Node.js only)
  web/         ← React DOM (browser only, future)
```

### Smart Client Responsibility Split

| Concern                           | Owner     | How                                              |
|-----------------------------------|-----------|--------------------------------------------------|
| Parsing commands                  | CLI       | Mode-specific grammar parsers                    |
| Tab completion                    | CLI       | Static JSON datasets shipped with the app        |
| Type-level validation             | CLI       | `moduleList.json` - type exists, chain accepts type, parameter name valid, value in range |
| Instance-level validation         | CLI+HISE  | CLI tracks module tree after initial fetch from `GET /api/builder/tree`; HISE confirms on execution |
| Module tree tracking              | CLI+HISE  | Fetched once on builder mode entry, updated locally as commands execute |
| Plan step reference tracking      | CLI       | Simple string bookkeeping (not tree logic)        |
| Generating HiseScript             | CLI       | Template-based, using `builderPath` from JSON     |
| Executing operations              | HISE      | Builder, DspNetwork, Sampler APIs                |
| Dynamic module parameters         | HISE      | Modules with `metadataType: "dynamic"` have runtime-defined params (ScriptProcessor, HardcodedSynth, etc.) |
| Live monitoring                   | HISE      | SSE push events for progress, console, metrics   |

---

## Communication with HISE

### Transport: HTTP REST API + Server-Sent Events

The CLI communicates with HISE via its existing **HTTP REST API** on
`localhost:1900`, powered by cpp-httplib (vendored header-only library).
This API is already used by the HISE MCP server and provides a
self-documenting discovery endpoint at `GET /`.

**Request/response** uses standard HTTP: `GET` for reads, `POST` for
mutations, JSON bodies, `{success, result, logs, errors}` response format.

**Push events** use a **Server-Sent Events** (SSE) endpoint at
`GET /api/events`. This provides streaming data for long-running operations
(monolith compression progress, compile status, render progress) and live
monitoring (CPU, MIDI activity). The SSE connection is **modal** - while
streaming, other requests are blocked, which is correct behavior since these
operations are inherently exclusive.

cpp-httplib already supports SSE natively via
`Response::set_chunked_content_provider()` with `text/event-stream` content
type. The HISE `RestServer` wrapper needs a streaming route handler path
alongside its existing one-shot response path.

**Multiple simultaneous clients** (e.g., MCP server + CLI) are supported
naturally by HTTP. Each request is independent. The SSE endpoint serves one
client at a time (modal).

### Named Pipe: Scheduled for Removal

The original REPL used JUCE `NamedPipe` for communication. The pipe
transport was replaced by HTTP in the v2 architecture. The C++ REPL server
code will be removed by reverting commit `28267c18a877`. The Node.js pipe
client (`pipe.ts`, `usePipe.ts`) has been deleted.

Rationale: The REST API already exists and is battle-tested, HTTP gives free
request-response correlation and standard tooling, SSE covers push use cases,
and HTTP naturally supports multiple simultaneous clients.

### Transport Abstraction

The engine layer talks to HISE through a `HiseConnection` interface
(see `src/engine/hise.ts` for the canonical definition). Methods: `get()`,
`post()`, `probe()` (readiness check via `GET /api/status`), `destroy()`.

`HttpHiseConnection` is the production implementation using `fetch()`.
`MockHiseConnection` provides configurable per-endpoint responses for tests.

### Existing Endpoints Used by TUI

| CLI mode      | Existing endpoint               | Use case                   |
|---------------|---------------------------------|----------------------------|
| Script mode   | `POST /api/repl`                | Evaluate HiseScript expression |
| Script mode   | `POST /api/recompile`           | Recompile after file edits |
| Inspect mode  | `GET /api/status`               | Project + processor info   |
| Inspect mode  | `GET /api/list_components`      | Component tree             |
| Inspect mode  | `GET /api/screenshot`           | Visual verification        |
| Inspect mode  | `POST /api/profile`             | Performance profiling      |
| Project mode  | `GET /api/status`               | Project info               |
| Project mode  | `POST /api/parse_css`           | CSS diagnostics            |
| Any mode      | `POST /api/shutdown`            | Quit HISE                  |

Note: The TUI does **not** use `POST /api/set_script` or
`GET /api/get_script`. Script mode evaluates expressions via `/api/repl`.
External file edits are handled by the user's editor, then `/api/recompile`
is called to apply changes. The `set_script`/`get_script` endpoints are for
the MCP server / AI agent workflow (programmatic script editing).

### New Endpoints

New endpoints follow the same conventions as the existing API.
Categories: `builder`, `sampler`, `dsp`, `workspace`, `inspect`, `compile`,
`project`, `settings`, `assets`, `presets`, `tools`, `meta`.

The `validate` flag on builder and dsp endpoints enables dry-run validation
through the same code path (same pattern as `compile: false` on `set_script`).

Full endpoint specification: [REST_API_ENHANCEMENT.md](REST_API_ENHANCEMENT.md)
and [Issue #12](https://github.com/christoph-hart/hise-cli/issues/12)

### REST API Spec Drift

The original API spec (previously at `guidelines/api/rest-api.md` in the
HISE repo) has drifted from the implementation. Key discrepancies (the
C++ implementation is the source of truth):

| Endpoint | Spec says | Code actually does |
|----------|-----------|--------------------|
| `GET /api/get_script` | Returns `{script, callback}` strings | Returns `{callbacks: {name: code}}` object |
| `POST /api/set_script` | Accepts `{script, callback}` | Accepts `{callbacks: {name: code}}` |
| `POST /api/recompile` | No `profile` param | Has `profile` + `durationMs` params |
| `GET /api/list_components` | No `laf` field | Includes `laf` info per component |

Five undocumented endpoints exist in code: `/api/repl`, `/api/profile`,
`/api/simulate_interactions`, `/api/parse_css`, `/api/shutdown`. Two
additional endpoints exist but were not in the original spec:
`/api/diagnose_script` (shadow parse), `/api/get_included_files` (list
external scripts).

The CLI is coded against the **actual implementation**, not the spec doc.

### Response Format Details

Verified against `RestServer.cpp` and `RestHelpers.cpp` in the HISE source.

**Success responses** use a handler-specific JSON body, with `logs` and
`errors` arrays merged in by `AsyncRequest::mergeLogsIntoResponse()`:

```json
{
  "success": true,
  "result": "...",
  "logs": [],
  "errors": [{ "errorMessage": "...", "callstack": ["..."] }]
}
```

**Error responses** (400, 404, 500) use a different shape:

```json
{
  "error": true,
  "message": "Error description"
}
```

**`/api/repl` has a non-standard response** — the expression result is in
`value`, not `result`:

```json
{
  "success": true,
  "moduleId": "Interface",
  "result": "REPL Evaluation OK",
  "value": 44100.0,
  "logs": [],
  "errors": []
}
```

**`/api/status` serves as readiness probe** — it polls `isInitialised()`
for up to 10 seconds, returning 503 if HISE is still loading. Use this
endpoint (not `GET /`) for connection probing.

### SSE Status

SSE (Server-Sent Events) is **not yet implemented** in the HISE REST
server. The `httplib.h` library bundled with HISE contains SSE *client*
classes, but the `RestServer` only handles synchronous request/response.
SSE server support must be added as part of
[#12](https://github.com/christoph-hart/hise-cli/issues/12).

**Polling fallback for 1.0**: Until SSE is available, live monitoring
(inspect mode CPU/voices/MIDI) uses polling at 500ms intervals against
`GET /api/inspect/cpu`. This matches the HISE IDE's default refresh rate.
The polling implementation is transparent — when SSE becomes available,
the connection upgrades without user-facing changes.

---

## Modal REPL

### Why Modes

A flat subcommand tree (`hise builder add ...`, `hise sampler select ...`)
works for single CLI invocations but is verbose for interactive use. Modes
let the user enter a domain context where the grammar simplifies:

```
> /builder
[builder] > add AHDSR to Sampler1.gain    # no "builder" prefix needed
[builder] > show tree
[builder] > /exit
>
```

Each mode defines its own parser, so the input language adapts to the domain.
The builder uses natural-language verbs (`add X to Y`). The script mode passes
everything as HiseScript. The sampler mode has selection-based workflows.

The `Mode` interface (see `src/engine/modes/mode.ts`) also provides optional
methods for syntax highlighting (`tokenizeInput`), tree sidebar data
(`getTree`, `getSelectedPath`, `selectNode`), and tab completion (`complete`).
The `TreeNode` type (see `src/engine/result.ts`) carries data-driven visual
properties (`colour`, `filledDot`, `dimmed`, `diff`) resolved by mode-specific
pipeline functions like `propagateChainColors()` in builder.ts.

### Entering Modes

| Command                    | Effect                                            |
|----------------------------|---------------------------------------------------|
| `/builder`                 | Enter builder mode (module tree)                  |
| `/script [processor]`      | Enter script mode (defaults to Interface)         |
| `/workspace <module>`      | Switch HISE workspace + enter contextual mode     |
| `/export`                  | Enter export mode                                 |
| `/project`                 | Enter project mode                                |
| `/inspect`                 | Enter inspect mode                                |

`/workspace` is the **primary navigation command** - it tells HISE to switch
its IDE view to the appropriate workspace (Scripting, Sampler, or Scriptnode)
and puts the CLI into the matching mode. The mode is inferred from the module
type:

| Module type                          | HISE workspace | CLI mode             |
|--------------------------------------|---------------|----------------------|
| ScriptProcessor                      | Scripting     | `[script:Name]`      |
| StreamingSampler                     | Sampler       | `[sampler:Name]`     |
| HardcodedSynth / ScriptFX with DSP  | Scriptnode    | `[dsp:NetworkName]`  |

DSP mode is **only** reachable via `/workspace` - there is no `/dsp` command
because a network context is always required.

### Slash Commands

Slash commands are always available in every mode. They are never forwarded to
HISE, never recorded in plan mode.

> **Note**: The currently registered commands are in `src/engine/commands/slash.ts`.
> This table is the full planned set — not all are implemented yet.

| Command              | Action                                              |
|----------------------|-----------------------------------------------------|
| `/help [topic]`      | Context-sensitive help                              |
| `/exit`              | Leave current mode (pop one level)                  |
| `/modes`             | Open command palette (same as Ctrl+Space)           |
| `/builder`           | Enter builder mode                                  |
| `/script [proc]`     | Enter script mode                                   |
| `/workspace <mod>`   | Switch HISE workspace + enter mode                  |
| `/export`            | Enter export mode                                   |
| `/project`           | Enter project mode                                  |
| `/inspect`           | Enter inspect mode                                  |
| `/wizard [id]`       | Open wizard (or list available wizards)              |
| `/clear`             | Clear output                                        |
| `/history`           | Show command history                                |

### Input Routing

```
Input starts with "/"  -->  Slash command dispatcher
Anything else          -->  Current mode's parser
```

### Mode Stack

Modes can nest (builder -> builder:plan). `/exit` pops one level. Ctrl+C
always exits entirely.

### Command Palette (Ctrl+Space)

A filterable overlay showing all available modes and commands. Arrow keys to
navigate, Enter to execute, Escape to dismiss, type to filter. Equivalent
slash command: `/modes`.

---

## Mode Grammars

### Builder Mode

Wraps the HISE Builder REST API (`/api/builder/*`) for constructing the
module tree. Commands map to `POST /api/builder/apply` operations.

```
# Adding modules
add <type> [as "<name>"] [to <target>[.<chain>]]

  add StreamingSampler as "Sampler 1"
  add AHDSR to Sampler 1.gain
  add SimpleReverb to Master Chain          # chain auto-resolved to fx

# Cloning (simple duplication, auto-renames IDs)
clone <target> [x<count>]

  clone Sampler 1
  clone Sampler 1 x4

# Removing
remove <target>

# Moving (stub - not yet in HISE C++ API)
move <target> to <parent>[.<chain>]

# Renaming
rename <target> to "<name>"

  rename SineSynth1 to "My Sine"

# Parameters (dot separates target from param)
set <target>.<param> [to] <value>

  set Master Chain.Volume to 0.5
  set Pad Osc 1.Detune to 0.25

# Loading DSP networks / compiled nodes
load "<source>" into <target>

  load "MyReverb" into ScriptFX1

# Inspection
show tree | show <target> | docs [type-or-field]

# Bypass
bypass <target> | enable <target>
```

**Comma chaining**: multiple operations on one line, separated by commas.
Maps to multiple entries in the `operations[]` array of the REST API call.
Verb inheritance: omit the verb keyword to reuse the previous one.
Set target inheritance: omit `target.` to reuse the previous set target.

```
# Explicit verbs
add SineSynth, add LFO to SineSynth1, set SineSynth1.Volume to 0.5

# Verb inheritance (omit verb = reuse last)
add SineSynth as Funky, SineSynth2 as Funky3, set Funky3.Volume to 0.5

# Set target inheritance (omit target. = reuse last set target)
set Master Chain.Volume to 0.5, Pan to 10, LFO.FadeIn to 100
```

**Target identifiers**: bare words (`SineSynth1`) or multi-word
(`Master Chain`). Quoted strings (`"Master Chain"`) also accepted.
Autocomplete inserts quotes for IDs with spaces.

**Dot notation**: `Master Chain.gain` means the gain chain of Master Chain.
In `set`, dot separates target from parameter: `Master Chain.Volume`.

**Chain auto-resolution**: when no `.chain` is specified in `add`/`move`,
the chain is inferred from the module's type:
- `SoundGenerator` - chain index -1 (direct child)
- `Effect` - fx chain (index 3)
- `MidiProcessor` - midi chain (index 0)
- `Modulator` - requires explicit dot notation (`Sine.gain`),
  fuzzy-matched against the parent's `modulation[]` chain IDs

#### Builder Mode Validation

The builder mode uses a **hybrid validation model**:

**Local validation** (instant, no HISE round-trip):
- Module type exists (validated against `moduleList.json`)
- Module subtype can go in the target chain (constrainer matching)
- Parameter name is valid for the module type
- Parameter value is in range (min/max/stepSize)
- ComboBox values match the `items` list
- Parent module has the specified chain type
- Builder API path lookup (`builderPath` field)

**Instance validation** (needs live module tree):
- Module instance name exists (tracked locally after initial fetch)
- Module instance name uniqueness
- Dynamic module parameters (modules with `metadataType: "dynamic"`)

On entering builder mode, the CLI calls `GET /api/builder/tree` once to
get the current module tree. From then on, it tracks the tree locally as
commands are executed, allowing instance-level validation without further
round-trips. The tree can be re-synced if the user edits in the HISE IDE.

#### Module Data (`moduleList.json`)

All HISE module types with rich metadata (see `data/moduleList.json` for current count):

| Field | Purpose |
|-------|---------|
| `id` | Short type name used in commands (e.g., `"AHDSR"`) |
| `type` / `subtype` | Classification: `SoundGenerator`, `Effect`, `MidiProcessor`, `Modulator` with subtypes like `EnvelopeModulator`, `MasterEffect`, `VoiceStartModulator` |
| `builderPath` | Builder API constant (e.g., `"b.Modulators.AHDSR"`) |
| `hasChildren` | Can contain child SoundGenerators |
| `hasFX` / `fx_constrainer` | Has FX chain + which effect subtypes are allowed |
| `parameters[]` | Full parameter definitions with `range`, `type`, `items`, `mode`, `unit` |
| `modulation[]` | Modulation chain definitions with `chainIndex`, `constrainer`, `modulationMode` |

Standard chain mapping for SoundGenerators:
`midi`=0, `gain`=1, `pitch`=2, `fx`=3 (implicit from structure).

Constrainer syntax: `"*"` (any), `"VoiceStartModulator"` (exact subtype),
`"MasterEffect|!RouteEffect|!SlotFX"` (subtype + exclusion list).

### Undo Mode

Top-level mode (`/undo`, cyan `#66d9ef`) providing undo/redo navigation and
plan groups across all domains. Supports inline one-shot calls from any mode
(`/undo back` from builder).

```
[undo] > back                    # undo one action/group
[undo] > forward                 # redo one action/group
[undo] > plan "Add oscillators"  # start plan group
[plan:Add oscillators] > ...     # (switch to builder, make changes)
[undo] > apply                   # commit plan as one undoable unit
[undo] > discard                 # roll back plan
[undo] > diff                    # show current diff
[undo] > history                 # show full history
[undo] > clear                   # clear all history
```

**Plan groups**: `plan "name"` calls `POST /api/undo/push_group`. While a
group is active, builder commands execute via `/api/builder/apply` as usual —
HISE validates against the group's evolving state. The runtime tree is empty
during a plan; builder detects this via `GET /api/undo/diff` (`groupName`)
and fetches `?group=current` for the plan tree. `apply` commits the group
as one undoable unit, `discard` rolls back.

**Sidebar tree**: shows undo history from `GET /api/undo/history`. Past
actions are flat, the active plan group is nested one level with its diff
children. Cursor position highlighted with `>`.

### DSP (Scriptnode) Mode

Entered via `/workspace` targeting a module with a DspNetwork. Wraps the
DspNetwork and Node scripting APIs.

```
add <factory.node> [as "<name>"] to <parent>
remove <name>
move <name> to <parent> [at <index>]
connect <source>[.<output>] to <target>.<parameter>
disconnect <source> from <target>.<parameter>
set <node> <property> [to] <value>
bypass <node> | enable <node>
show graph | show <node> | show factories | show <factory>
undo | clear
```

Node factories and nodes are listed in `data/scriptnodeList.json`.

### Script Mode

HiseScript REPL. Defaults to Interface processor. Everything typed is sent
to HISE's expression evaluator via `POST /api/repl`.

```
[script:Interface] > Engine.getSampleRate()
44100.0
[script:Interface] > Console.print("hello")
hello
```

- **Multi-line**: unclosed brackets continue on next line
- **Last result**: `_` stores the last evaluated result
- **`/api Namespace.method`**: inline API reference from static data

Uses `POST /api/repl` (not `set_script`). For external file edits, the user
edits in their editor and calls `/recompile` from the TUI.

#### Variable Watch

A live variable watch replicating the HISE IDE's ScriptWatchTable. Shows all
script variables with their current values, updated by polling
`GET /api/inspect/watch_variables` (new endpoint, see
[REST_API_ENHANCEMENT.md](REST_API_ENHANCEMENT.md)).

```
[script:Interface] > /watch                    # toggle watch panel
[script:Interface] > /watch myVar*             # filter by glob pattern
[script:Interface] > /watch --type var,const    # filter by variable type
```

**Data per entry** (matches `DebugInformationBase` in C++ source):

| Field | Description |
|-------|-------------|
| `type` | Category: `register`, `variable`, `constant`, `inlineFunction`, `globals`, `callback`, `apiClass`, `namespace` |
| `dataType` | HiseScript type: `int`, `double`, `String`, `Array`, `Object`, `ScriptButton`, etc. |
| `name` | Variable name, possibly namespaced (`MyNamespace.myConst`) |
| `value` | Current value as string |
| `children` | Nested properties/elements for objects and arrays (hierarchical) |

**TUI rendering**: sidebar panel
([docs/TUI_STYLE.md — Section 3.8](docs/TUI_STYLE.md)) or toggled view
that splits the output area. Type badges use color-coded single letters
(R=register, V=variable, C=constant, etc.) matching the HISE IDE.

**Filter**: glob patterns on variable names (`my*`, `*.value`, `Namespace.*`).
Type filter restricts which categories are shown. Both filters are applied
client-side on the full dataset from HISE.

**Refresh**: configurable polling interval, default 500ms (matching the HISE
IDE's default ScriptWatchTable refresh rate). The variable list itself only
rebuilds on recompilation — between recompilations, only values are polled.

### Sampler Mode

Entered via `/workspace` targeting a StreamingSampler. Selection-based
workflow that syncs with the HISE sample map editor UI.

```
# Sample maps
maps | load <map> | save [<name>] | clear | info

# Import
import <path|glob> | automap <path|glob> | import sfz <path>

# Selection (syncs to HISE UI)
select all | select "<regex>" | select where <prop> <op> <value>
select add "<regex>" | select subtract "<regex>"

# Editing (on selection)
set <property> [to] <value> | set <property> [to] <value> for all

# Operations
show | show all | count | duplicate | delete | replace <sample> with <path>

# Batch
monolith [<map>] | monolith all | validate

# Mic positions
mics | purge <name> | unpurge <name>
```

#### Complex Group Management (first-class)

The complex group manager replaces the simple RR group axis with a 64-bit
bitmask supporting arbitrary organizational layers (RR, crossfade, keyswitch,
legato, custom).

```
# Layer management
groups                                    # show all layers
groups add <type> <name> [--bits N] [--cached] [--ignore]
groups remove <name>

  Layer types: rr, xfade, keyswitch, legato, custom

# Assigning samples to groups
assign <layer> <group>                    # for selected samples
assign <layer> ignore                     # set ignore flag

# Filtering (controls playback)
filter <layer> <group>
filter <layer> off

# Per-group audio
volume <layer> <group> <dB>
delay <layer> <group> <samples>
fadein <layer> <group> <ms> [<dB>]
fadeout <layer> <group> <ms>
```

### Inspect Mode

Runtime introspection. One-shot snapshots + SSE subscriptions for live
monitoring.

```
cpu | memory | voices | modules | <name> | connections | routing | midi
latency
```

Live monitoring (cpu, midi) uses `GET /api/events` (SSE). While a live
monitoring session is active, the SSE connection is modal - no other requests
are processed. This is acceptable because monitoring is an explicit user
action.

### Project Mode

Project inspection and settings.

```
# Assets
info | samples | scripts | images | networks | presets
settings [<key>] [<value>]
```

### Export Mode

```
vst3|au|standalone|aax [debug|release] | dsp-dll | all [debug|release]
status | cancel | log | clean
export samples | export resources
```

### HISE Asset Manager Mode (`/assets`)

```
list [installed|available|outdated]
install <name> [version] | update <name>
uninstall <name> | cleanup <name>
versions <name>
add-local <path> | remove-local <path>
test [archive] | create
```

`create` is a command alias to `/wizard create_asset_payload`.

### User Preset Manager Mode (`/presets`)

```
load <preset>
save <preset> | save as <preset>
set default <preset> | default | clear default
reset
validate <preset> | validate all
ls [path] | cd <path> | pwd | search <term>
```

`reset` hard-fails if no default user preset is configured.

---

## Static Data

Three JSON datasets ship with the CLI in `data/` and serve triple duty: tab
completion, local validation, and inline help.

### `data/moduleList.json` (provided)

All HISE module types with rich metadata. Covers:
- Type metadata (`id`, `type`, `subtype`, `builderPath`, `category`)
- Structure (`hasChildren`, `hasFX`, `fx_constrainer`, `constrainer`)
- Parameters with full range/type/items data
- Modulation chains with constrainer and mode info

See "Builder Mode Validation" section for details. See `src/engine/data.ts`
for the `ModuleList` type definition.

### `data/scriptnodeList.json` (provided)

Scriptnode factories and nodes. Same structure as `moduleList.json`:
- Node metadata (`id`, `description`, `type` polyphonic/monophonic)
- Structure (`hasChildren`, `hasFX`, `fx_constrainer`, `constrainer`)
- Parameters with full range/type/items data (ComboBox params decoded)
- Modulation outputs with constrainer type (`Normalised`/`Unnormalised`)
- Properties (`Mode`, `Connection`, `Code`, `NumParameters`, `LocalId`, etc.)
- Interfaces (`TableProcessor`, `SliderPackProcessor`, `AudioSampleProcessor`,
  `DisplayBufferSource`)

### `data/scripting_api.json` (provided, partially enriched)

Covers the full HiseScript API. Inspect the JSON for current class/method counts.
- Base data on all classes: `name`, `description`, `category`, `methods[]`
- Each method: `name`, `returnType`, `description`, `parameters[]` (name+type)
- Enriched classes (see `enrichedClasses` array in JSON) add: `commonMistakes`,
  `llmRef`, `obtainedVia`, and per-method `callScope`, `crossReferences`,
  `pitfalls`, `examples`

Key classes per mode:

| CLI Mode  | Key classes |
|-----------|-------------|
| Builder   | `Builder`, `Synth` |
| Script    | All classes — this is the REPL |
| Sampler   | `Sampler`, `Sample`, `ComplexGroupManager` |
| DSP       | `DspNetwork`, `Node`, `Connection`, `Parameter` |
| Inspect   | `Engine` |
| Project   | `Settings`, `ExpansionHandler` |

### Future datasets (not yet provided)

| Dataset | Purpose |
|---------|---------|
| Sample property indexes | Sampler mode select/set |

These can be fetched at runtime from `GET /api/meta/*` endpoints or provided
as additional JSON files.

---

## Third-party Dependencies

Libraries are selected for focused functionality, isomorphic compatibility
(engine layer must run in both Node.js and browsers), and avoiding
reimplementation of hard problems. Bundle size is not a significant
concern for a CLI tool (current bundle: 2.6MB, Node.js itself: ~40MB).

### Engine Layer (isomorphic — zero `node:` imports)

| Library | Unpacked | Bundled (est.) | Purpose |
|---------|----------|----------------|---------|
| `@lezer/lr` + `@lezer/common` + `@lezer/highlight` | 499KB | ~120KB | HiseScript parsing, tokenization, bracket balancing, syntax highlighting |
| `chevrotain` (+ 5 internal pkgs) | 1,491KB | ~250KB | Builder, DSP, sampler command grammars with error recovery |
| `marked` | 434KB | ~90KB | Markdown parsing to AST |
| `picomatch` | 83KB | ~8KB | Glob matching (variable watch filters, import paths) |
| `brace-expansion` | 50KB | ~4KB | `{2..10}` brace patterns in clone commands |
| `fastest-levenshtein` | 20KB | ~2KB | "Did you mean?" suggestions on typos |
| **Engine total** | **~2,577KB** | **~474KB** | |

### TUI Layer (Node.js terminal — may use `node:` imports)

| Library | Size | Purpose |
|---------|------|---------|
| `ink` + `chalk` + `ink-text-input` + `ink-spinner` | Existing | Core TUI framework |
| `marked` + `marked-terminal` | ~80KB | Markdown rendering for output and overlay |
| `@byteland/ink-scroll-bar` | 5KB | Scrollbar for output and overlay |
| `ink-scroll-view` | 10KB | Overlay body scrolling |
| `ink-testing-library` (devDep) | 10KB | Ink component testing in vitest |

### Rationale

**Lezer** (`@lezer/lr`, `@lezer/common`, `@lezer/highlight`): The parser
system behind CodeMirror 6. Incremental parsing (fast on keystroke input),
custom grammar DSL, and the same grammar serves both TUI tokenization and
future web frontend CodeMirror integration. HiseScript is syntactically
close to JavaScript — we fork the Lezer JS grammar and simplify (remove
JSX, modules, classes, async/await; add `reg`, `inline`, `namespace`,
`local` keywords). Also provides bracket balancing (multi-line detection
in script mode) and error recovery as byproducts of the parse tree.

**Chevrotain**: TypeScript-native parser toolkit with no code generation
step. Produces excellent context-aware error messages out of the box —
critical for a REPL where users type commands interactively. Builder mode,
DSP mode, and sampler mode each have distinct but structurally similar
grammars (verb-first with optional clauses, quoted strings, dot-paths,
keyword markers). Chevrotain lets us define shared token types and reuse
them across mode grammars. Each grammar rule is a method on a class,
individually testable in vitest.

**Lezer vs. Chevrotain — why both**: These handle different parsing domains.
Lezer parses a *programming language* (HiseScript: expressions, statements,
functions, recursive nesting, operator precedence). Chevrotain parses
*imperative CLI commands* (fixed verb-first structure, optional clauses,
keyword markers). Using Lezer for commands would be overkill; using
Chevrotain for HiseScript tokenization would miss incremental parsing
and CodeMirror integration.

**marked**: Zero-dependency markdown parser. Produces an AST of tokens
(headings, bold, links, code blocks, tables). The engine parses markdown
into an AST; each frontend renders it with platform-appropriate formatting.
TUI: custom `marked` renderer (~150 lines) using chalk + cli-table3 +
Lezer for code blocks. Web: `react-markdown` or similar. This avoids the
`marked-terminal` → `cli-highlight` → `highlight.js` dependency chain
(~7MB) by using our own syntax highlighting for the two languages we
support in code blocks: HiseScript (via Lezer) and XML (via a ~30-line
regex tokenizer for `<tag attr="value">` patterns). Code blocks in other
languages render without highlighting.

**picomatch**: Zero-dependency glob matching. Used in variable watch
filters (`/watch myVar*`) and preset path filtering in `/presets`. Simple
`*`/`?` globbing is a 10-line function, but picomatch handles edge cases
(brace expansion, character classes, negation) that would accumulate bugs.

**brace-expansion**: Handles `{2..10}` numeric ranges in builder clone
commands and HiseScript code generation. Tiny, well-tested, avoids
reimplementing range expansion edge cases.

**fastest-levenshtein**: Edit distance for "Did you mean?" suggestions
when users mistype module names, API methods, or node names. 20KB, zero deps.

**cli-table3**: Unicode-aware terminal table rendering with box-drawing
characters. Handles the hard problem of column alignment when cells contain
ANSI escape codes (chalk-colored text). Used in two places: markdown table
rendering and `CommandResult { type: "table" }` output.

### Deliberately Skipped

| Library | Why skipped |
|---------|-------------|
| `marked-terminal` (1.9MB) | Custom renderer using our color system + Lezer is lighter and consistent |
| `ink-markdown` | Was a thin wrapper for `marked-terminal` |
| `cli-highlight` / `highlight.js` (5MB+) | Only need HiseScript + XML highlighting, both covered by Lezer + 30-line regex |
| `sugar-high` (42KB) | JS tokenizer, but Lezer is the better long-term choice — same grammar serves TUI and web CodeMirror |
| `fuse.js` / `fzf-for-js` | Prefix matching on ~2,000 items is fast enough with sorted array + binary search |
| `ink-autocomplete` | Dead (2017, Ink v1, v0.0.0) |
| `prism-react-renderer` | Heavy, HTML-oriented, not needed when Lezer handles tokenization |

### Custom Components (~500 lines total)

| Component | Lines est. | Purpose |
|-----------|-----------|---------|
| Markdown terminal renderer | ~150 | `marked` AST → chalk + cli-table3 + Lezer code highlighting |
| XML syntax highlighter | ~30 | Regex tokenizer for module tree XML output |
| Highlighted input | ~100-150 | Lezer-tokenized input with ghost text completion |
| CompletionPopup | ~120 | Absolute-positioned dropdown above input, arrow keys, Tab/Enter accept |
| Overlay | ~180 | Centered floating panel for help, absolute-positioned, mouse wheel scroll |
| ThemeContext | ~75 | `ThemeProvider` + `useTheme()` — all components read colors from context. Enables the overlay dimming system: the backdrop wraps a `ThemeProvider` with `darkenScheme()` values, so every component automatically renders dimmed without override props. See TUI_STYLE.md §1.7–1.8. |

### Bundle Impact

Adding all engine + TUI libraries increases the bundle from ~2.6MB to
~3.1MB (~19% increase). This buys: proper HiseScript parsing with
incremental highlighting, three mode command grammars with error recovery,
markdown rendering with box-drawn tables, glob matching, edit distance
suggestions, and brace expansion.

### TUI Performance Constraints

Ink uses a React reconciler → Yoga flexbox layout → string buffer → terminal
output pipeline. Every render regenerates the entire output string (no
incremental DOM patching). Known limitations and required mitigations:

**Ink configuration** (set at `render()` call):

| Option | Value | Rationale |
|--------|-------|-----------|
| `incrementalRendering` | `true` | Line-by-line terminal diff instead of full erase+rewrite. Eliminates most flicker. |
| `alternateScreen` | `true` | Uses alternate screen buffer (like vim/htop). Clean terminal restore on exit. |
| `maxFps` | `20` | A REPL doesn't need the default 30fps. 20fps (50ms/frame) is perceptually equivalent and reduces CPU. |

**Pin Ink version**: Use `"ink": "6.8.0"` (exact, not caret range). Ink
6.6-6.7 had a confirmed memory leak
([#869](https://github.com/vadimdemedes/ink/issues/869)). Exact pinning
prevents surprise regressions from patch releases.

**No built-in scroll**: Ink does not implement `overflow: "scroll"`
([#765](https://github.com/vadimdemedes/ink/issues/765)). The Output
component must implement virtual scrolling:

- Keep full output history in a plain array (not React state)
- Compute visible slice: `history.slice(scrollOffset, scrollOffset + viewportHeight)`
- Only the visible slice enters the React tree
- Scroll offset is managed via `useRef` to avoid re-renders on scroll position changes
- Cap history at `MAX_HISTORY_LINES` (see `src/tui/components/Output.tsx`) to bound memory growth

**Memory management**: Ink stores dual output buffers internally
([#826](https://github.com/vadimdemedes/ink/issues/826)). Mitigations:

- Use `<Static>` for command results that scroll off-screen permanently —
  Ink excludes `<Static>` content from the dynamic re-render cycle
- Pre-compute and cache syntax-highlighted ANSI strings when output is
  created (not on every render)
- Trim output history beyond the cap

**Render cost rules**:

- `React.memo` on every panel component (TopBar, Output, Input, StatusBar,
  WatchPanel, CompletionPopup) — prevents cascading re-renders when only
  one panel changes
- `useCallback` for input handlers and event callbacks — prevents
  invalidating memoized children on every parent render
- Never call syntax highlighting functions inside `render()` — pre-compute
  highlighted strings when output lines are added to the history array
- For the watch panel (500ms polling), compare new values against previous
  via `useRef` — only call `setState` when values actually change

**Escape hatch**: If Ink proves inadequate at Phase 2 (the first phase with
a working TUI), the engine layer (`src/engine/`) is completely independent —
zero Ink imports, zero terminal dependencies. Only `src/tui/` would need
replacement. The most practical fallback is a lower-level Node.js terminal
renderer (direct ANSI escape codes, no React reconciler) rather than a
full-language rewrite.

### Renderer

The TUI uses stock [Ink](https://github.com/vadimdemedes/ink) (Yoga-backed
layout). All components import `Box`, `Text`, and hooks directly from
`"ink"`.

**256-color fallback**: For terminals without truecolor support, two
mechanisms keep colors faithful:

1. `snapSchemeFor256()` (`src/tui/theme.ts`) — pre-snaps all theme hex
   colors to their nearest xterm-256 palette equivalent. Applied once in
   `AppInner` before any component sees the scheme. Prevents chalk from
   mapping dark backgrounds (e.g. `#272822`) to wrong indices.
2. `fgHex()`/`bgHex()` (`src/tui/components/prerender.ts`) — detect
   truecolor at import time and emit `\x1b[38;5;Nm` (256-color) instead
   of `\x1b[38;2;r;g;bm` (24-bit) for pre-rendered ANSI output.

---

## Screencast Framework

Scriptable terminal recordings that serve three purposes from one definition:
TUI integration tests (vitest), documentation assets (asciicast files for the
HISE docs site), and future interactive demos (live engine replay in the
browser).

### VHS-Derived `.tape` Format

The definition format is derived from [VHS](https://github.com/charmbracelet/vhs)
(Charm.sh, 19k stars), the gold standard for scripted terminal recording. We
adopt VHS's command vocabulary verbatim and extend it with assertion and
annotation commands for testing and documentation.

**VHS commands adopted directly:**

| Command | Description |
|---------|-------------|
| `Type "text"` | Simulate typing |
| `Type@500ms "text"` | Typing with custom speed per character |
| `Enter`, `Tab`, `Space`, `Backspace [count]` | Key presses |
| `Up`, `Down`, `Left`, `Right` | Arrow keys |
| `Ctrl+C`, `Ctrl+R`, etc. | Control sequences |
| `Sleep 500ms` / `Sleep 2s` | Pause |
| `Wait /regex/` | Wait for output matching regex |
| `Hide` / `Show` | Stop/resume frame recording (setup/teardown) |
| `Set Width 80`, `Set Height 24` | Terminal dimensions |
| `Set TypingSpeed 50ms` | Default typing speed |
| `Output path.cast` | Output file path |
| `Screenshot name.png` | Capture frame as image |
| `Source other.tape` | Include commands from another tape file |
| `Env KEY "value"` | Set environment variables |

**hise-cli extensions (additive — VHS ignores unknown commands):**

| Command | Description |
|---------|-------------|
| `Expect "text" [region]` | Assert screen contains text. Optional region: `topbar`, `statusbar`, `sidebar`, `output`, `input`. Without region, searches the full screen. Sidebar region auto-fails if sidebar is not visible (detected via `⌕` search icon). |
| `ExpectMode "builder"` | Assert current mode |
| `ExpectPrompt "[builder] >"` | Assert prompt text |
| `Snapshot "name"` | Capture frame for snapshot testing (vitest snapshots) |
| `Annotation "text"` | Caption for docs — not rendered in terminal, shown as overlay in web player |
| `Set Connection "mock"` / `"live"` | Use MockHiseConnection or real HISE |
| `Set MockResponse "/api/repl" {...}` | Configure mock endpoint responses |

### Example `.tape` File

```tape
# screencasts/builder-intro.tape
# Builder Mode Introduction — serves as integration test + docs screencast

Output screencasts/builder-intro.cast
Set Width 80
Set Height 24
Set TypingSpeed 50ms
Set Connection "mock"

# Launch and enter builder mode
Annotation "Start hise-cli and enter builder mode"
Sleep 500ms
Type "/builder"
Enter
Sleep 300ms
ExpectMode "builder"
ExpectPrompt "[builder] >"

# Add a module
Annotation "Add a sampler to the module tree"
Type "add StreamingSampler as "
Type@100ms '"Sampler 1"'
Sleep 200ms
Enter
Sleep 500ms
Expect "ok — added StreamingSampler"

# Tab completion
Annotation "Tab completion shows matching module types"
Type "add AH"
Tab
Sleep 300ms
Expect "AHDSR"
Snapshot "completion-popup"

# Smart client validation
Annotation "Smart client catches typos locally"
Backspace 4
Type "add FakeModule"
Enter
Sleep 300ms
Expect "Unknown module type"
Expect "Did you mean"

# Show tree
Type "show tree"
Enter
Sleep 500ms
Snapshot "module-tree"

# Exit
Type "/exit"
Enter
ExpectPrompt ">"
```

### Execution Paths

The same `.tape` file is consumed by four different runners:

```
                    ┌─── vitest ──────→ test pass/fail
                    │    (Expect/Snapshot assertions checked)
                    │
builder-intro.tape ─┼─── asciicast ───→ .cast file for HISE docs site
                    │    (frames captured with timestamps)
                    │
                    ├─── VHS ─────────→ GIF/MP4 (optional, unmodified VHS)
                    │    (our extensions silently ignored)
                    │
                    └─── web replay ──→ interactive demo (Phase 8)
                         (Annotations shown as overlays)
```

**vitest runner**: Parses the `.tape` file, spawns the real app in a
pseudo-terminal via `node-pty` (with `--mock --no-animation`), feeds
keystrokes character-by-character, captures raw terminal output (full ANSI,
24-bit colors, cursor control), and checks `Expect` / `ExpectMode` /
`ExpectPrompt` assertions against the last visible screen (`\x1b[2J`
boundary). Region-scoped assertions (`Expect "text" sidebar`) extract
specific screen regions using layout geometry. Each `.tape` file is a
vitest test.

**asciicast writer**: Same execution as the vitest runner, but additionally
collects timestamped output events and writes them to the
[asciicast v2 format](https://docs.asciinema.org/manual/asciicast/v2/)
(`.cast` file). Optimized with event merging (<5ms gaps), consecutive
dedup, and gzip compression. A 3-second screencast is ~4-8KB compressed.

**VHS (optional)**: The `.tape` files are a superset of VHS syntax. Running
`vhs builder-intro.tape` against a real `hise-cli` binary produces a
GIF/MP4/WebM. Our extension commands (`Expect`, `Annotation`, etc.) are
ignored by VHS. Useful when video format is needed (social media, README).

**Web replay (Phase 8)**: The `.tape` file is parsed in the browser, and
the commands drive the live engine `Session` with `MockHiseConnection`.
Each `Type`/`Enter`/`Tab` action plays back against the real engine,
producing real completions, real mode switches, real formatted output.
`Annotation` commands render as overlay captions. The visitor can pause
and optionally take over typing.

### Architecture

The `.tape` parser is isomorphic (pure string parsing, no `node:` imports)
and lives in the engine layer. The runners are platform-specific:

```
src/engine/screencast/
  tape-parser.ts          Parse .tape files into TapeCommand[]
  tape-parser.test.ts     Parser tests
  types.ts                TapeCommand type + extension commands

src/tui/screencast/
  runner.ts               Execute tape via node-pty (real pseudo-terminal)
  writer.ts               Asciicast v2 writer with merge/dedup/gzip
  tester.ts               Wrap runner with vitest assertions

screencasts/              Tape files + generated .cast outputs
  builder-intro.tape      Builder mode demo
  builder-intro.cast      Generated asciicast (gitignored or committed)
  script-repl.tape        Script mode REPL demo
  ...
```

### Docs Integration

The HISE documentation website (Nuxt.js) embeds screencasts using the
[asciinema-player](https://docs.asciinema.org/manual/player/) web
component (~50KB). A Vue wrapper loads `.cast` files and renders them
in the HISE color theme. The `.cast` files are generated by CI on each
release and published as artifacts or committed to the docs repo.

In Phase 8 (web frontend), the asciinema-player is optionally replaced by
the live engine replay — same `.tape` definition, but running the actual
engine in the browser instead of playing back pre-recorded frames.

---

## Wizard Framework

Wizards are declarative multi-step guided workflows for complex operations that
require multiple coordinated inputs — broadcaster configuration, asset payload
creation, monolith encoding, project scaffolding, etc. HISE already has C++
multipage dialogs for many of these tasks; the wizard framework provides a
better UX in the TUI and a structured single-shot interface for the CLI.

### Dual Interface — Same Definition

A wizard definition lives in the engine layer and serves both frontends:

| Aspect           | TUI (human)                          | CLI (LLM / automation)                |
|------------------|--------------------------------------|---------------------------------------|
| Invocation       | `/wizard broadcaster`                | `hise-cli wizard broadcaster --answers '{...}'` |
| Interaction      | Step-by-step form rendered inline in scrollback, one page at a time | Single-shot: all answers supplied upfront |
| Validation       | Per-step, inline error display       | All-at-once, returns error array      |
| Dynamic data     | Resolved lazily per step             | Resolved during validation            |
| Output           | Preview → accept/copy/reject         | JSON result with generated content    |
| Schema discovery | The wizard guides you                | `--schema` dumps definition as JSON   |

This is a key architectural benefit: complex multi-parameter operations (like
monolith encoding with sample map selection, format options, and target paths)
get a single unified interface rather than requiring the LLM to know the raw
REST API endpoints, their parameter formats, and their sequencing.

### Engine Types (`src/engine/wizard/`)

```ts
interface WizardDefinition {
  id: string;                    // e.g. "broadcaster"
  name: string;                  // "Broadcaster Wizard"
  description: string;
  modes: string[];               // which modes can invoke this (empty = global only)
  standalone?: boolean;          // runs without REPL session or HISE connection
  steps: WizardStep[];
  output: WizardOutput;
}

type WizardStep =
  | SelectStep
  | MultiSelectStep
  | TextStep
  | ToggleStep
  | FormStep
  | RepeatGroup
  | PreviewStep
  | PipelineStep;

// --- Step types ---

interface SelectStep {
  type: "select";
  id: string;
  title: string;
  description?: string;
  options?: SelectOption[];           // static options
  resolve?: ResolverFn;              // or dynamic options from HISE
  showIf?: (answers: Answers) => boolean;
}

interface MultiSelectStep {
  type: "multi-select";
  id: string;
  title: string;
  description?: string;
  options?: SelectOption[];
  resolve?: ResolverFn;
  showIf?: (answers: Answers) => boolean;
}

interface TextStep {
  type: "text";
  id: string;
  title: string;
  description?: string;
  placeholder?: string;
  validate?: (value: string) => string | null;  // sync format check
  validateAsync?: ValidateAsyncFn;              // async instance-level check
  showIf?: (answers: Answers) => boolean;
}

interface ToggleStep {
  type: "toggle";
  id: string;
  title: string;
  description?: string;
  default?: boolean;
  showIf?: (answers: Answers) => boolean;
}

interface FormStep {
  type: "form";
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
  validateAsync?: ValidateAsyncFn;              // step-level async validation
  showIf?: (answers: Answers) => boolean;
}

interface RepeatGroup {
  type: "repeat";
  id: string;
  title: string;
  addLabel?: string;                  // "Add another listener?"
  maxCount?: number;
  steps: WizardStep[];                // nested steps to repeat
  showIf?: (answers: Answers) => boolean;
}

interface PreviewStep {
  type: "preview";
  id: string;
  title: string;
  generate: (answers: Answers) => PreviewResult;
}

interface PipelineStep {
  type: "pipeline";
  id: string;
  title: string;
  phases: PipelinePhase[];
  showIf?: (answers: Answers) => boolean;
}

interface PipelinePhase {
  id: string;
  name: string;
  shouldSkip?: (answers: Answers) => boolean;
  execute: (answers: Answers, callbacks: PipelineCallbacks) => Promise<PhaseResult>;
}

interface PipelineCallbacks {
  onLog: (line: string) => void;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

interface PhaseResult {
  success: boolean;
  error?: string;
  duration: number;
}

// --- Supporting types ---

interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

type FormField = {
  id: string;
  label: string;
  required?: boolean;
  description?: string;
  showIf?: (answers: Answers) => boolean;
} & (
  | { type: "text"; placeholder?: string; validate?: (v: string) => string | null; validateAsync?: ValidateAsyncFn }
  | { type: "select"; options?: SelectOption[]; resolve?: ResolverFn }
  | { type: "toggle"; default?: boolean }
  | { type: "display"; resolve: (answers: Answers, hise?: HiseConnection) => Promise<string> }
);

interface PreviewResult {
  content: string;
  language?: string;               // for syntax highlighting ("hisescript", "json")
  actions: ("accept" | "reject" | "copy")[];
}

type WizardOutput =
  | { type: "clipboard"; generate: (answers: Answers) => string }
  | { type: "apply"; execute: (answers: Answers, hise: HiseConnection) => Promise<CommandResult> }
  | { type: "preview-then-decide" };  // uses the PreviewStep's actions

type Answers = Record<string, unknown>;
type ResolverFn = (answers: Answers, hise?: HiseConnection) => Promise<SelectOption[]>;
type ValidateAsyncFn = (value: unknown, answers: Answers, hise?: HiseConnection) => Promise<string | null>;
```

**FormStep** renders multiple fields on a single page. This matches the
existing HISE wizard layout where one page often has 2–5 related inputs
(e.g., the broadcaster's ComplexData branch needs DataType, EventType,
ModuleIDs, SlotIndex, and Metadata on one page).

**RepeatGroup** clones its inner steps for each iteration, appending `_0`,
`_1`, etc. to field IDs in the answers map. After completing the group's
steps, a "Add another?" prompt appears. `maxCount` caps repetitions.

**PipelineStep** executes a sequence of phases with streaming log output,
progress tracking, and abort capability. Used for heavyweight operations:
compiling HISE from source (setup wizard), building plugins (export wizard),
compiling DLL networks, removing installations. On failure, the wizard stays
on the pipeline step — the user can retry from the failed phase or go back
to the previous configuration step. Back navigation from a pipeline step
returns to the last configuration step, not mid-pipeline.

In CLI mode, pipeline phases run non-interactively. Progress and logs are
emitted as structured JSON lines (`{phase, status, log?, progress?}`). On
failure, the result includes the failed phase ID and error message.

**FormField `display` type** is a read-only computed text shown in a form
step. The `resolve` function runs when the step is entered and its result is
shown as non-editable context. Used for: output file path preview (export
wizard), detected network/file lists (compile-networks wizard), platform
detection results (setup wizard).

### Step Validation

Each step supports two levels of validation that run when the user presses
Enter to advance:

```ts
// Sync — format checks (on TextStep and FormField type:"text")
validate?: (value: string) => string | null;

// Async — instance-level checks, may round-trip to HISE
validateAsync?: (value: unknown, answers: Answers, hise?: HiseConnection) => Promise<string | null>;
```

**Validation lifecycle (TUI):**

1. User presses Enter to advance
2. All sync `validate` functions run on the current step's fields
3. If any sync error → stop, show errors inline, jump cursor to first error field
4. If all sync pass → run all `validateAsync` functions (parallel where independent)
5. If any async error → stop, show errors inline, jump cursor to first error field
6. If all pass → advance to next step

During async validation the UI blocks briefly (no spinner). If validation
takes >2 seconds, a `Validating...` hint appears in the footer.

**Error display:** errors appear below the failing field in
`HISE_ERROR_COLOUR`. In form steps with multiple failing fields, all error
messages are shown simultaneously and the cursor jumps to the first error
field. Errors persist until the next Enter press — they are not cleared on
keystroke.

**Validation lifecycle (CLI):** `WizardExecutor.validate()` runs all sync
and async validators at once. Returns `{ field: string; message: string }[]`
for all failures.

**Example — broadcaster component ID validation:**

```ts
{
  type: "text",
  id: "componentIds",
  label: "Component IDs",
  placeholder: "Enter component IDs...",
  required: true,
  validate: (v) => v.trim() === "" ? "Required" : null,
  validateAsync: async (v, _answers, hise) => {
    const ids = String(v).split(",").map(s => s.trim());
    const components = await hise?.get("/api/list_components");
    const known = new Set(components?.map((c: any) => c.id));
    const unknown = ids.filter(id => !known.has(id));
    return unknown.length > 0
      ? `Unknown component(s): ${unknown.join(", ")}`
      : null;
  },
}
```

### State Machines

Two entry points into the same definition:

**WizardRunner** (TUI path — step-by-step):

```ts
class WizardRunner {
  definition: WizardDefinition;
  answers: Answers;
  currentStepIndex: number;
  repeatCounts: Record<string, number>;

  visibleSteps(): WizardStep[];       // filters by showIf, expands repeats
  currentStep(): WizardStep;
  advance(answer: unknown): void;     // validate, store, move forward
  back(): void;                       // restore previous, move back
  canGoBack(): boolean;
  isComplete(): boolean;
  generateOutput(): Promise<string | CommandResult>;
}
```

Answers are preserved when navigating back. Changing an answer that affects
`showIf` conditions does not reset later answers — they are re-evaluated on
each advance, and hidden steps retain their stored values silently.

**WizardExecutor** (CLI path — single-shot):

```ts
class WizardExecutor {
  definition: WizardDefinition;

  execute(answers: Answers, hise?: HiseConnection): Promise<{
    result: string | CommandResult;
    errors?: { field: string; message: string }[];
  }>;

  validate(answers: Answers): ValidationResult;

  schema(): WizardSchema;             // JSON-serializable definition for --schema
}
```

The `validate` method evaluates `showIf` predicates to determine which fields
are required given the supplied answers, checks required fields, validates
values against options/validators, and resolves dynamic options to validate
against them. The `schema` method returns a JSON-serializable representation
of the wizard definition (steps, options, types, descriptions) that LLMs can
use to discover what parameters are needed.

### Registration & Invocation

Wizards are registered in a `WizardRegistry` (engine layer):

| Invocation | Syntax | Effect |
|------------|--------|--------|
| Global     | `/wizard <id>` | Opens wizard from any mode or root |
| Global     | `/wizard` (no args) | Selection list of available wizards, filtered by current mode |
| Mode-specific | `wizard <id>` (no slash) | Available when current mode is in the wizard's `modes[]` |
| CLI        | `hise-cli wizard <id> --answers '<json>'` | Single-shot execution |
| CLI        | `hise-cli wizard <id> --schema` | Dump wizard parameter schema as JSON |
| CLI        | `hise-cli wizard list` | List available wizards |

Tab completion works on wizard IDs in both `/wizard` and mode-specific `wizard`
contexts. The `--schema` flag is particularly valuable for LLMs — they can
query the wizard's parameter schema, see all options and help text, and
construct the right answers without step-by-step interaction.

### Lifecycle

**TUI:**
1. User invokes wizard → engine creates `WizardRunner` → TUI appends a wizard
   form block to the output log (rendered by `renderWizardBlock()` in
   `src/tui/components/wizard-render.ts`)
2. Each step: engine resolves options if needed → form block re-renders in
   place → user answers via the form key router (`wizard-keys.ts`) → engine
   validates and advances
3. On complete: engine generates output → form block is replaced with a
   preview or action result in the same scrollback slot
4. On cancel (`Escape` from step 1): engine discards runner → form block is
   replaced with a cancellation result

**CLI:**
1. Tool invokes `hise-cli wizard <id> --answers '{...}'`
2. Engine creates `WizardExecutor`, validates all answers at once
3. If valid: resolves dynamic data, generates output, returns JSON result
4. If invalid: returns error array with field-level messages

### Standalone Mode

Wizards with `standalone: true` run without a REPL session or HISE
connection. This covers operations that must work before HISE exists (setup),
on installations that may be broken (update, migrate), or that destroy
installations (nuke). In standalone mode:

- The wizard form block renders inline at the top of the output log on a
  plain `backgrounds.standard` fill (no REPL content above it)
- The entry point is `hise-cli wizard <id>`
- Resolver functions receive no `HiseConnection` — they use local
  filesystem scanning, GitHub API calls, or static data instead

### Shared Pipeline Phases

Pipeline phases are composable building blocks in `src/engine/wizard/phases/`.
Multiple wizard definitions reuse the same phase implementations:

```
src/engine/wizard/phases/
  compile.ts      # Projucer resave + MSBuild/xcodebuild/make
  verify.ts       # Binary existence + size + build flag check
  sdk-check.ts    # Verify SDKs are extracted
  git-ops.ts      # Clone, fetch, checkout, submodule update
  cleanup.ts      # Directory removal, PATH cleanup, settings removal
```

| Phase          | Used by                            |
|----------------|------------------------------------|
| `compile`      | setup, update, export, compile-networks |
| `verify`       | setup, update, export              |
| `sdk-check`    | setup, export, compile-networks    |
| `git-ops`      | setup, update, migrate             |
| `cleanup`      | nuke                               |

The `compile` phase encapsulates the entire platform-aware C++ compilation
pipeline from the legacy setup templates (`docs/LEGACY_SETUP_SCRIPTS.md`) —
Projucer project resave,
MSBuild (Windows) / xcodebuild (macOS) / make (Linux) invocation, build
configuration selection. The same logic that builds HISE from source also
builds plugins and DLL networks. Only the build target and configuration
parameters differ, and those come from the wizard's answers.

### Command Entry Point

Lifecycle aliases were removed pre-1.0 as part of stale system cleanup.
Use explicit wizard commands (`hise-cli wizard <id>`) when lifecycle wizards
are implemented.

When `hise-cli` runs with **no arguments**:

1. Probe `localhost:1900` for a running HISE instance
2. If reachable → launch the REPL
3. If not → prompt for launching HISE Debug and continue with REPL startup

### Planned Wizards

Eight wizard definitions are planned. Four are standalone lifecycle wizards
(no HISE connection required), four operate on a running HISE project.

#### Standalone Lifecycle Wizards

**Setup** (`id: "setup"`, standalone):

| Step | Type     | Content |
|------|----------|---------|
| 1    | form     | Platform detection results (display fields: OS, arch, git, compiler, Faust, IPP — auto-populated by resolvers) |
| 2    | form     | Prerequisites (showIf: missing required prereqs). Actionable remediation list with URLs and commands |
| 3    | form     | Configuration: install path (text), include Faust (toggle), include IPP (toggle, showIf: Windows) |
| 4    | pipeline | Build: 9 phases — git clone, build deps, Faust install, SDK extraction, compile, add to PATH, verify, test. Each phase has `shouldSkip` |
| 5    | preview  | Completion: success/failure summary, install path, build time, next steps, log file path |

Output: `preview-then-decide` (accept exits, reject goes back to config).

**Update** (`id: "update"`, standalone):

| Step | Type     | Content |
|------|----------|---------|
| 1    | select   | Detected HISE installations (resolver: scan `DEFAULT_INSTALL_PATHS` + PATH) |
| 2    | form     | Update options: target commit (text, default: latest CI passing), update Faust (toggle) |
| 3    | pipeline | Phases: git fetch, checkout target, submodule update, optional Faust update, recompile (shared `compile` phase), verify (shared `verify` phase) |
| 4    | preview  | Completion summary |

Output: `preview-then-decide`.

**Migrate** (`id: "migrate"`, standalone):

| Step | Type     | Content |
|------|----------|---------|
| 1    | text     | Path to existing ZIP-based HISE installation (validateAsync: check directory exists and contains HISE) |
| 2    | form     | Options: keep backup (toggle, default: true), target commit (text, default: latest CI passing) |
| 3    | pipeline | Phases: backup existing, init git repo, add remote, fetch, checkout target, submodule init, verify |
| 4    | preview  | Completion summary |

Output: `preview-then-decide`.

**Nuke** (`id: "nuke"`, standalone):

| Step | Type         | Content |
|------|--------------|---------|
| 1    | multi-select | Detected HISE installations to remove (resolver: scan filesystem + PATH) |
| 2    | form         | Cleanup options: remove settings files (toggle), remove PATH entries (toggle) |
| 3    | preview      | Confirm: show exactly what will be deleted. Explicit accept required. |
| 4    | pipeline     | Phases: remove selected directories (shared `cleanup` phase), clean PATH entries, remove settings files |

Output: `preview-then-decide`.

#### HISE-Connected Wizards

**Broadcaster** (`id: "broadcaster"`, modes: `["script"]`):

| Step | Type   | Content |
|------|--------|---------|
| 1    | form   | Broadcaster ID (text, validateAsync: valid identifier + unique), comment (text), tags (text), colour (text) |
| 2    | select | Attach type: None, ComplexData, ComponentProperties, ComponentValue, ComponentVisibility, ContextMenu, EqEvents, ModuleParameters, MouseEvents, ProcessingSpecs, RadioGroup, RoutingMatrix |
| 3    | form   | Source configuration (showIf per attach type — 12 conditional forms with fields like moduleIds, componentIds, propertyType, slotIndex. Dynamic fields use validateAsync to check IDs against HISE) |
| 4    | select | Target type: None, Callback, Callback (Delayed), ComponentProperty, ComponentRefresh, ComponentValue, ModuleParameter |
| 5    | form   | Target configuration (showIf per target type — 7 conditional forms) |
| 6    | preview | Generated HiseScript code with syntax highlighting |

Output: `preview-then-decide` (accept copies to clipboard).
Source: `data/wizards/broadcaster.json`.

**Install Package** (`id: "install-package"`, modes: `["project"]`):

| Step | Type   | Content |
|------|--------|---------|
| 1    | form   | Load existing settings (toggle), info text (text, multiline) |
| 2    | form   | Wildcards: include patterns (text), exclude patterns (text) |
| 3    | multi-select | File type filter (showIf: use filter toggle): Scripts, AdditionalSourceCode, Samples, Images, AudioFiles, SampleMaps, MidiFiles, DspNetworks |
| 4    | multi-select | Preprocessors (showIf: use preprocessors toggle): resolved from `project_info.xml` |
| 5    | form   | Clipboard content (showIf: use clipboard toggle): text to copy after install |
| 6    | preview | Generated `install_package.json` content |

Output: `apply` (writes `install_package.json` to project root).
Source: `data/wizards/install_package_maker.json`.

**Plugin Export** (`id: "export"`, modes: `["compile"]`):

| Step | Type     | Content |
|------|----------|---------|
| 1    | form     | Export target (select: Plugin/Standalone), project type (select: Instrument/FX/MIDI), plugin type (select: VST/AU/AAX/All). Display field: computed output file path |
| 2    | pipeline | Compilation: SDK check (shared), Projucer resave + compile (shared `compile` phase), verify (shared `verify` phase) |
| 3    | preview  | Completion: binary path, size, build time |

Output: `preview-then-decide` (accept shows file location).
Source: `data/wizards/plugin_export.json`.

**Compile Networks** (`id: "compile-networks"`, modes: `["dsp"]`):

| Step | Type     | Content |
|------|----------|---------|
| 1    | form     | Display fields: detected networks, C++ files, Faust files (resolved from project). Toggles: replace script FX modules, open DLL project in IDE |
| 2    | form     | C++ node properties (showIf: has C++ nodes, foldable equivalent): IsPolyphonic (multi-select of node names), AllowPolyphonic (multi-select of node names). Items resolved dynamically. |
| 3    | pipeline | Compilation: SDK check (shared), DLL compile (shared `compile` phase with DLL target) |

Output: `apply` (DLL written to project, optionally opens IDE).
Source: `data/wizards/compile_networks.json`.

### Source Data

Wizard definitions are hand-written TypeScript in
`src/engine/wizard/definitions/`. The existing C++ multipage dialog JSON
files in `data/wizards/` serve as design reference material — they contain
page layouts, component types, option lists, help text, and branching logic
from the HISE desktop dialogs. These are not parsed at runtime. See
[docs/WIZARD_CONVERSION.md](docs/WIZARD_CONVERSION.md) for the conversion
process from C++ dialog JSON to TypeScript `WizardDefinition`.

Currently available source JSONs: `broadcaster.json`, `new_project.json`,
`install_package_maker.json`, `plugin_export.json`, `compile_networks.json`.

---

## Key Design Decisions

### 1. Smart client - local type validation + HISE instance validation

**Decision**: The CLI validates type-level constraints locally using
`moduleList.json` (module type exists, chain accepts subtype, parameter
name valid, value in range). Instance-level constraints (does "Sampler1"
exist in the live tree?) are tracked locally after an initial fetch from
`GET /api/builder/tree` on mode entry.

**Rationale**: The module list JSON is rich enough (full parameter
definitions, modulation chain constrainers, FX chain rules) to catch the
vast majority of user errors instantly. Only a handful of modules have
dynamic parameters (`metadataType: "dynamic"`) that the JSON cannot
describe. This gives instant
feedback for typos and structural mistakes without waiting for HISE, while
HISE remains the authority for execution.

**Previous decision**: The original design called for a pure "thin client"
where all validation was done by HISE. Analysis of `moduleList.json` showed
this was unnecessarily conservative.

### 2. HISE-side validation with `--validate` flag

**Decision**: The same API endpoints accept a `validate: true` flag that runs
the command through the normal code path but stops before executing.

**Alternative rejected**: Separate `builder.validate.add` endpoints would
double the API surface. The validate flag keeps it at one endpoint per
operation.

### 3. CLI-side script generation

**Decision**: The CLI generates HiseScript from validated plan steps using
the `builderPath` field from `moduleList.json`.

**Alternative rejected**: HISE-side code generation would require building a
string-based code generator in statically compiled C++, which is the wrong
tool for template-based string manipulation. TypeScript with template literals
is far more natural for this.

### 4. Static autocomplete + validation data

**Decision**: Module types, API methods, and node factories ship as static
JSON files with the CLI. These serve both tab completion and validation.

**Alternative rejected**: Querying HISE at runtime for completions adds latency
on every Tab press and requires a live connection. Static data works offline,
is instant, and covers 99% of cases. The `meta.*` REST endpoints exist for
runtime refresh if the static data is stale.

### 5. Dot notation for parent.chain

**Decision**: `Sampler1.gain` uses dots to separate parent from chain.

**Alternative rejected**: Slash (`Sampler1/gain`) was considered but conflicts
with filesystem paths used elsewhere (script connections, sample imports).
Dots mirror HiseScript conventions and read naturally as "property of."

### 6. Hybrid clone syntax - no trailing number inference

**Decision**: Clone count is always explicit (`x4`) or uses brace expansion
(`{2..10}`). No automatic trailing-number detection.

**Rationale**: Trailing number extraction is fragile. `"My Sampler V2"`,
`"Bass_12_Layer"`, `"Pad 1A"` - all break trailing-number inference in
different ways. Explicit count/range is unambiguous.

### 7. Workspace = HISE IDE workspaces

**Decision**: `/workspace` refers to HISE's three IDE workspaces (Scripting,
Sampler, Scriptnode), not project directories.

**Rationale**: The original brainstorm confused "workspace" with "project
directory management." In HISE, workspaces are IDE views. `/workspace
MySampler` switches the HISE IDE to the Sampler workspace AND enters the
CLI's sampler mode - one command does both.

### 8. HTTP + SSE over named pipe

**Decision**: Use HISE's existing HTTP REST API (`localhost:1900`) for
request/response and Server-Sent Events for push. The named pipe REPL
server is scheduled for removal.

**Rationale**: The REST API is battle-tested (MCP server uses it daily),
HTTP naturally supports multiple simultaneous clients (MCP + CLI), and
SSE covers push use cases (progress, monitoring) without a custom protocol.
cpp-httplib already supports SSE natively. The SSE endpoint is modal
(blocks other requests while streaming), which is correct for the
long-running operations it serves (compression, export, render).

**Multi-client requirement**: The typical workflow has a terminal with
Claude Code / opencode (using the MCP server via HTTP) and a second terminal
with hise-cli (also using HTTP). Both connect simultaneously. Named pipes
(JUCE `NamedPipe` is single-client) cannot support this without complex
multiplexing.

**Alternative rejected**: Named pipe as sole transport - cannot handle
multiple simultaneous clients. Named pipe as sidecar for push events -
adds complexity with two transports to maintain.

### 9. Tests as API contract

**Decision**: Mode contracts are defined through the shared mock runtime,
contract normalizers, and live parity tests.

**Rationale**: The mock runtime defines the stable payloads the engine builds
against, while live parity tests verify that real HISE responses still conform
to those contracts. This avoids drift between mock mode, engine behavior, and
live REST integrations.

**Workflow**: See [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md) for the canonical
mode implementation pipeline.

### 10. Dual frontends from day one

**Decision**: The engine is UI-agnostic from the start, with both TUI and CLI
frontends.

**Rationale**: Designing for LLM access after the fact would require
retrofitting structured output, non-interactive invocation, and JSON
formatting onto a TUI-only codebase. Building both from the start means every
command naturally has both a human-readable and machine-readable representation.

### 11. REPL via /api/repl, not /api/set_script

**Decision**: The TUI's script mode uses `POST /api/repl` for expression
evaluation, not `POST /api/set_script`.

**Rationale**: The script mode is a REPL - evaluate an expression, see the
result. `set_script` wholesale replaces callback code, which is the MCP
server's job (AI agents editing scripts programmatically). The TUI never
needs to replace script content. For external file changes, the user edits
in their editor and calls `POST /api/recompile` from the TUI.

### 12. Wizards as unified interface for complex operations

**Decision**: Complex multi-parameter operations (broadcaster setup, monolith
encoding, asset payload creation, project scaffolding, plugin export, HISE
installation) are modeled as declarative wizard definitions in the engine
layer, with the TUI rendering them as interactive step-by-step forms inline
in the output log and the CLI exposing them as single-shot parameterized
commands. This includes
the setup/update/migrate/nuke lifecycle, which becomes standalone wizards
replacing the current dedicated TUI flows.

**Rationale**: HISE already has C++ multipage dialogs for many of these tasks,
but their UX is poor. More importantly, the raw REST API endpoints for these
operations require the caller to know endpoint URLs, parameter formats, valid
option sets, and sequencing. A wizard definition captures all of this in one
place — the TUI gets a guided experience, the CLI gets a self-documenting
command with built-in validation, and LLMs get a `--schema` flag to discover
parameters. One definition serves three audiences.

The `pipeline` step type enables code reuse across wizards that share
heavyweight operations. The same `compile` phase (Projucer resave +
MSBuild/xcodebuild/make) is used by the setup wizard (building HISE), the
export wizard (building plugins), and the compile-networks wizard (building
DLLs). Battle-tested platform-specific compilation logic from legacy setup
templates (see `docs/LEGACY_SETUP_SCRIPTS.md`) becomes a shared building
block rather than being locked inside one flow.

**Alternative rejected**: Separate TUI flows and CLI commands per operation.
This duplicates validation logic, option definitions, and help text across two
codepaths. The wizard framework ensures a single source of truth.

### 13. Isomorphic engine for web compatibility

**Decision**: The engine layer (`src/engine/`) must contain zero `node:`
imports and use two platform abstraction interfaces (`DataLoader` for static
dataset access, `PhaseExecutor` for shell execution) so it runs unmodified
in both Node.js and browser environments.

**Rationale**: A browser-based frontend is a high-value target — from a
hosted demo playground (marketing, documentation, training) to a local
companion app with richer rendering than a terminal. The engine is already
UI-agnostic (no Ink/React imports); extending this to platform-agnostic
costs two small interfaces and one rule (`no node:` imports). The `fetch()`
API used by `HiseConnection` works in both environments natively.

**Cost**: Two interfaces (`DataLoader`, `PhaseExecutor`) with
platform-specific implementations in the frontend layers. All static
datasets (`moduleList.json`, etc.) need to be loaded through `DataLoader`
rather than direct filesystem access. Pipeline wizard phases (shell scripts)
are Node.js-only and disabled in the browser frontend.

**Alternative rejected**: Making the engine Node.js-only would be simpler
today but would require a full rewrite of the engine to add a web frontend
later. The abstraction cost now is trivial compared to the retrofit cost.

### 14. VHS-derived `.tape` format for screencasts and TUI testing

**Decision**: Adopt the [VHS](https://github.com/charmbracelet/vhs) `.tape`
command vocabulary as the base format for scripted terminal recordings.
Extend it with assertion commands (`Expect`, `ExpectMode`, `Snapshot`) and
documentation annotations. One `.tape` file serves as TUI integration test,
asciicast generator, optional VHS input, and future web replay source.

**Rationale**: VHS (19k stars) is the gold standard for scripted terminal
recording. Its command set (`Type`, `Enter`, `Tab`, `Sleep`, `Wait`,
`Hide`/`Show`, `Set`, `Source`, `Screenshot`) covers all terminal interaction
primitives and is battle-tested across thousands of projects. Adopting it
gives us a future-proof, familiar format for free, while our extensions
(`Expect`, `Annotation`, `Set Connection`) add the testing and documentation
capabilities VHS doesn't provide. The `.tape` files remain VHS-compatible —
running them through VHS produces GIFs/videos, with our extension commands
silently ignored.

Unifying testing and documentation under one artifact means every TUI feature
gets tested and documented simultaneously. When the UI changes, updating the
`.tape` file re-runs the test and regenerates the screencast. No separate
recording step, no stale demos.

**Alternative rejected**: Custom TypeScript definition format
(`ScreencastDefinition` as objects). Less readable, requires TypeScript
knowledge to author, not compatible with VHS, and invents syntax for
problems VHS already solved.

**Alternative rejected**: Recording-only approach (VHS or asciinema without
assertions). Produces documentation but not tests. Testing would require
a separate mechanism, duplicating the action sequences.

### 15. Ink with mitigations over native TUI rewrite

**Decision**: Use Ink (React for terminals) as the TUI framework despite
known performance limitations, applying specific mitigations from the start
(see TUI Performance Constraints above). Phase 2 serves as a go/no-go
checkpoint — if Ink proves inadequate with real content, the engine layer
is decoupled and only `src/tui/` would need replacement.

**Rationale**: ratatui (Rust) and bubbletea (Go) produce technically
superior terminal UIs — native scrolling, immediate-mode rendering,
near-zero latency, minimal memory. However, switching would cost:

- **Web frontend target**: Rust/Go don't compile to usable browser apps.
  The isomorphic engine constraint (Decision #13) becomes meaningless.
- **TypeScript ecosystem**: Lezer (grammar toolkit), Chevrotain (parser
  toolkit), marked (markdown) are all JS-native. Rust equivalents exist
  but require porting all grammar/parser work.
- **Development velocity**: Rust's 5-15 second incremental compile vs
  TypeScript's ~100ms esbuild. For a project with extensive UI iteration
  (8 modes, 8 wizards, tab completion, overlays), this compounds.
- **Existing codebase**: Complete rewrite. Setup wizard pipeline phases,
  GitHub API helpers, and command history logic are all TypeScript.

The performance gap is manageable for a REPL-class application at 20fps.
Claude Code (Anthropic) and Gemini CLI (Google) — both more complex Ink
apps — ship successfully. Both teams actively contribute upstream fixes.

**Escape hatch**: The engine layer has zero Ink imports. If Ink fails at
Phase 2, the practical fallback is a lower-level Node.js terminal renderer
(direct ANSI escape codes, no React reconciler), not a full Rust rewrite.

---

## Implementation

Concrete deliverables, file paths, dependencies, phase gate criteria, and
test requirements are in [ROADMAP.md](ROADMAP.md). That document is the
canonical implementation reference — phases, issue cross-references, and
ordering are defined there.

Critical path: **Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7** (1.0 release).
[#12](https://github.com/christoph-hart/hise-cli/issues/12) (HISE C++ REST
endpoints) is independent work that proceeds in parallel. Web frontend is
deferred to post-1.0.
