# ROADMAP.md — hise-cli Implementation

> De-facto implementation reference for hise-cli 1.0.
> Architecture and type specifications live in [DESIGN.md](DESIGN.md).
> Visual design system in [docs/TUI_STYLE.md](docs/TUI_STYLE.md).

---

## Issue Cross-Reference

ROADMAP phases are canonical. GitHub issues use descriptive titles.

| ROADMAP Phase | GitHub Issue | Scope |
|---------------|-------------|-------|
| Phase 0 — Foundation | [#1](https://github.com/christoph-hart/hise-cli/issues/1) | Engine core, test infra, directory structure |
| Phase 1 — Session + Modes | [#1](https://github.com/christoph-hart/hise-cli/issues/1), [#2](https://github.com/christoph-hart/hise-cli/issues/2) | Mode system, slash commands, session |
| Phase 2 — TUI v2 Shell | [#2](https://github.com/christoph-hart/hise-cli/issues/2) | TUI components, entry point rewire, screencasts |
| Phase 3 — Tab Completion | [#3](https://github.com/christoph-hart/hise-cli/issues/3) | Completion engine + popup |
| Phase 3.5 — Dot-Notation Dispatch | [#3](https://github.com/christoph-hart/hise-cli/issues/3) | Mode cache, arg completion, one-shot execution |
| Phase 3.7 — Markdown Renderer | — | Terminal markdown rendering + virtualized output |
| Phase 4 — Builder + Plan | [#5](https://github.com/christoph-hart/hise-cli/issues/5), [#4](https://github.com/christoph-hart/hise-cli/issues/4) | C++ builder endpoints, full grammar, module tree, plan submode |
| Phase 5 — Wizards | [#15](https://github.com/christoph-hart/hise-cli/issues/15) | Wizard framework + setup wizard |
| Phase 6 — Remaining Modes | [#6](https://github.com/christoph-hart/hise-cli/issues/6), [#8](https://github.com/christoph-hart/hise-cli/issues/8), [#7](https://github.com/christoph-hart/hise-cli/issues/7), [#11](https://github.com/christoph-hart/hise-cli/issues/11), [#9](https://github.com/christoph-hart/hise-cli/issues/9) | DSP, script (full), inspect, sampler, project/compile |
| Phase 6 — New Modes | [#16](https://github.com/christoph-hart/hise-cli/issues/16), [#17](https://github.com/christoph-hart/hise-cli/issues/17), [#18](https://github.com/christoph-hart/hise-cli/issues/18), [#19](https://github.com/christoph-hart/hise-cli/issues/19), [#20](https://github.com/christoph-hart/hise-cli/issues/20), [#21](https://github.com/christoph-hart/hise-cli/issues/21) | `/modules` reference, `/api` docs, `/ui` component CRUD, `/expansions` manager, `/assets` HISE asset manager, `/presets` user preset manager |
| Phase 7 — Polish | [#10](https://github.com/christoph-hart/hise-cli/issues/10), [#15](https://github.com/christoph-hart/hise-cli/issues/15) | Command palette, remaining wizards, CLI frontend |
| HISE C++ (parallel) | [#12](https://github.com/christoph-hart/hise-cli/issues/12) | New REST endpoints + SSE |
| Post-1.0 — Web Frontend | — | Browser frontend, live screencast replay |
| Future | [#13](https://github.com/christoph-hart/hise-cli/issues/13) | Wave editing + sample analysis |
| Future | — | Plugin UI testing via tape sessions |

---

## Principles

- **Engine-first, TUI-validated**: every feature starts as tested engine code
  (zero UI deps), then gets a TUI rendering. The TUI is the integration test
  you can feel.
- **TDD**: vitest for all engine code. Mode implementation workflow, mock
  contracts, and live parity testing are defined in [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md).
- **Live HISE early**: existing endpoints like `POST /api/repl` and
  `GET /api/status` are wired early, but mode work still follows the mock-first
  contract pipeline in [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md).
- **REST-first for HISE-connected modes**: any mode requiring new HISE REST
  endpoints follows the implementation sequence documented in
  [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md), plus the C++ endpoint work tracked
  in this roadmap.
- **Clean break**: existing code in `src/` stays as reference. New code goes
  into `src/engine/`, `src/tui/`, `src/cli/`. Entry point (`src/index.ts`)
  is rewired in Phase 2.

## Resolved Design Decisions

These were open questions that are now settled:

- **Test file placement**: colocated (`session.test.ts` next to `session.ts`)
- **Session design**: class with thin methods delegating to pure functions
- **HiseConnection interface**: explicit `get()` / `post()` methods (not a
  single `request()` method). See Phase 0.3 for the interface definition.
- **Phase 8 (Web Frontend)**: deferred to post-1.0. The 1.0 release ships
  TUI + CLI only. The isomorphic engine constraint remains to keep the door
  open.

---

## Phase 0 — Foundation ✓

**Goal**: testable engine layer skeleton, HISE REST client, test infrastructure.

Tracks [#1](https://github.com/christoph-hart/hise-cli/issues/1) (engine core).

**Status: Completed.** Engine directory structure established, vitest configured,
all core types and interfaces implemented.

### Key decisions

- **Isomorphic constraint** ([DESIGN.md — Decision #13](DESIGN.md#13-isomorphic-engine-for-web-compatibility)):
  engine layer has zero `node:` imports. Platform-specific operations use
  `DataLoader` (see `src/engine/data.ts`) and `PhaseExecutor` (see DESIGN.md)
  interfaces.
- **Ink 6.8.0 exact** — pinned after memory leak smoke test passed.
- **`MockHiseConnection`** as living API contract
  ([DESIGN.md — Decision #9](DESIGN.md#9-tests-as-api-contract)).

### What was built

- `src/engine/hise.ts` — `HiseConnection` interface, `HttpHiseConnection`,
  `MockHiseConnection`
- `src/engine/result.ts` — `CommandResult` union type (canonical definition)
- `src/engine/data.ts` — `DataLoader` interface + dataset type definitions
- `src/engine/highlight/` — Lezer HiseScript grammar, XML tokenizer, token colors
- `src/engine/screencast/` — `.tape` parser (isomorphic)
- `vitest.config.ts` with `.js` → `.ts` resolver plugin
- Ink memory leak smoke test + scroll prototype (seed for Output component)

**Phase 0 gate: passed.** Build, typecheck, and all tests pass.

---

## Phase 1 — Session + Mode System ✓

**Goal**: the engine can parse commands, manage modes, route input, and talk
to HISE. Fully tested. No TUI yet — all validation through tests.

Tracks [#1](https://github.com/christoph-hart/hise-cli/issues/1) (engine core)
and [#2](https://github.com/christoph-hart/hise-cli/issues/2) (mode system).

**Status: Completed.** Mode system, session, command registry, and three mode
stubs (script, inspect, builder) implemented with full test coverage.

### Key decisions

- **`SessionContext` interface** avoids circular imports between modes and session.
  Modes depend on `SessionContext` (minimal), not the full `Session` class.
- **`handleInput` dispatch**: input starts with `/` → `CommandRegistry`;
  anything else → `currentMode().parse()`. Single entry point for both TUI and CLI.
- **Script mode reads `response.value`** (not `response.result`) — verified
  against `RestHelpers.cpp:513-517`.
- **Builder local validation** against `data/moduleList.json` — typos caught
  with `fastest-levenshtein` suggestions. Validates the smart-client concept.
- **Mode accent colors**: see `MODE_ACCENTS` in `src/engine/modes/mode.ts`
  (canonical) and [docs/TUI_STYLE.md — Section 1.3](docs/TUI_STYLE.md) (visual spec).

### What was built

- `src/engine/modes/mode.ts` — `Mode` interface, `ModeId` type, `CompletionResult`,
  `CompletionItem`, `MODE_ACCENTS` (canonical color definitions)
- `src/engine/session.ts` — `Session` class (mode stack, history, dispatch,
  completion routing)
- `src/engine/commands/registry.ts` — `CommandRegistry` (slash command → handler map)
- `src/engine/commands/slash.ts` — Built-in handlers (see source for current list)
- `src/engine/modes/root.ts` — Root mode (slash commands only)
- `src/engine/modes/script.ts` — Script mode (`POST /api/repl`, processor ID)
- `src/engine/modes/inspect.ts` — Inspect mode MVP (`version`, `project`)
- `src/engine/modes/builder.ts` — Builder mode (Chevrotain parser: `add`, `show`, `set`)
- `src/engine/modes/tokens.ts` — Shared Chevrotain token types

**Phase 1 gate: passed.** All tests pass including session dispatch, command registry,
mode stubs with mock HISE round-trips, builder parser + local validation.

---

## Phase 2 — TUI v2 Shell ✓

**Goal**: new TUI that renders engine `Session` state. The design becomes
tangible — you can see the color system, switch modes, interact with live HISE.

Tracks [#1](https://github.com/christoph-hart/hise-cli/issues/1) (TUI split)
and [#2](https://github.com/christoph-hart/hise-cli/issues/2) (mode prompts).

**Status: Completed.** Full TUI shell with 4-layer color system, virtual scrolling,
overlay dimming, ThemeContext, entry point rewire. Screencast infrastructure
planned but not yet implemented.

### Key decisions

- **4-layer color system**: brand (hardcoded), mode accents (hardcoded), syntax
  highlighting (hardcoded), color scheme (user-selectable). 8 shipped schemes.
  See [docs/TUI_STYLE.md — Section 1](docs/TUI_STYLE.md#1-color-system) for the
  visual spec; `src/tui/theme.ts` for canonical color values.
- **ThemeContext** (`src/tui/theme-context.tsx`): all components read colors via
  `useTheme()`, never importing `brand` directly. Enables overlay dimming
  (re-render with darkened scheme).
- **Virtual scrolling**: Output stores history as a plain array, renders only
  the visible slice. Scroll offset is a `useRef`. `React.memo` on all panels.
  See [DESIGN.md — TUI Performance Constraints](DESIGN.md#tui-performance-constraints).
- **Entry point**: probes `localhost:1900`, auto-detects HISE, falls back to
  standalone menu. See `src/index.ts`.

### What was built

- `src/tui/theme.ts` — Brand colors, `ColorScheme` interface, 8 schemes,
  `darkenHex()`, `lightenHex()`, `darkenScheme()`, `darkenBrand()`
- `src/tui/theme-context.tsx` — `ThemeProvider`, `useTheme()` hook
- `src/tui/app.tsx` — Main shell (session wiring, overlay snapshot/dimming,
  completion state, scroll handling)
- `src/tui/components/TopBar.tsx` — Branding, mode label, project name, status dot
- `src/tui/components/Output.tsx` — Virtual scrolling, `CommandResult` rendering,
  pre-computed ANSI strings, history cap
- `src/tui/components/Input.tsx` — Mode-colored prompt, command history
- `src/tui/components/StatusBar.tsx` — Context hints, scroll position
- `src/tui/components/Overlay.tsx` — Help overlay with dimmed backdrop
- `src/index.ts` — Rewired entry point with HTTP probe

**Screencasts**: fully implemented. Pty-based runner (`node-pty` spawns
`dist/index.js --mock --no-animation`), asciicast v2 writer with merge/dedup/gzip
optimizations, vitest tester, `generate.py` post-processing (gzip + self-contained
HTML preview). Region-based `Expect` assertions scope checks to `topbar`, `statusbar`,
`sidebar`, `output`, or `input` regions of the screen (sidebar visibility detected
via search icon `⌕`). 5 tape scripts with assertions: mode-switching, script-repl,
builder-validation, tab-completion, builder-tree-expanded.
See `src/tui/screencast/` for implementation, [docs/CODE_STYLE.md](docs/CODE_STYLE.md)
§ Screencast Tests for writing conventions.

**Phase 2 gate: passed.** Build, typecheck, all tests pass. Manual verification
with live HISE completed (mode switching, script REPL, builder validation).

---

## Phase 3 — Tab Completion + UX Polish ✓

**Goal**: instant feedback from the static datasets. Validates the smart-client
concept for humans.

Tracks [#3](https://github.com/christoph-hart/hise-cli/issues/3).

**Status: Completed.** Completion engine, popup UX, ghost text, syntax
highlighting, tree sidebar, central key dispatch, builder navigation.

### Key decisions

- **Completion engine** (`src/engine/completion/engine.ts`): consumes three
  static datasets (moduleList, scriptnodeList, scripting_api). Mode-aware:
  slash commands at root, builder keywords + module types, script API methods.
  `CompletionResult.label` shown as popup header.
- **Immediate popup**: appears as user types. Escape toggles open/close.
  Enter accepts + submits. Up/Down gated when popup visible. Max 8 items.
  See `src/tui/components/CompletionPopup.tsx`.
- **Input rewrite** (`src/tui/components/Input.tsx`): `useReducer` for atomic
  `{value, cursorOffset}` updates. Full cursor navigation (Home/End, word
  boundary, Cmd+Left/Right). Ghost text, horizontal scroll window.
- **Syntax highlighting**: per-mode tokenizers (`src/engine/highlight/`).
  `Mode.tokenizeInput()` on the interface. HiseScript, builder, inspect, slash.
- **Central key dispatch**: single `useInput` in `app.tsx` with priority chain
  (Overlay > Popup > TreeSidebar > Input > App scroll). Components expose
  imperative handles. See [docs/CODE_STYLE.md](docs/CODE_STYLE.md) § Central
  Key Dispatch.
- **Tree sidebar** (`src/tui/components/TreeSidebar.tsx`): `Ctrl+B` toggle.
  Connector lines, colored chain dots (○/●), diff indicators (+/-/*). Data-driven
  via `TreeNode` properties. See [docs/MODULE_TREE.md](docs/MODULE_TREE.md).
- **Builder navigation**: `cd`/`ls`/`pwd` with `contextLabel` in prompt.
  `cd ..` at root exits mode.

**Phase 3 gate: passed.** All tests green. Build + typecheck pass. 5 `.tape`
screencast tests passing.

---

## Phase 3.5 — Mode Instance Cache + Dot-Notation Dispatch ✓

**Goal**: one-shot execution (`/builder add SimpleGain`) and cross-mode argument
completion from root.

### Key decisions

- **Mode instance cache** (`src/engine/session.ts`): `getOrCreateMode()` caches
  mode instances. Re-entering a mode restores state (builder's `currentPath`).
  `popMode(silent)` suppresses exit message for one-shot cleanup.
- **Argument completion from root**: `/builder add A` → session detects space
  after mode name, delegates to builder's `complete()` with adjusted cursor.
  Position translation handles `from`/`to` offset shift.
- **Dot-notation dispatch** (`src/engine/commands/slash.ts`): `/builder.Sine.pitch`
  splits into context + args. `createModeHandler()` handles four patterns:
  enter mode, enter with context, one-shot, one-shot with context.
- **`executeOneShot()`** (`src/engine/session.ts`): push mode, parse, silent pop.
  Result carries target mode's `accent` for echo border coloring.
- **`setContext(path)`** on Mode interface: builder sets `currentPath`, script
  sets processor ID.

**Phase 3.5 gate: passed.** 499 tests. Build + typecheck pass.

---

## Phase 3.7 — Terminal Markdown Renderer ✓

**Status: Completed.** `marked` + `marked-terminal` for ANSI output, `cli-highlight`
with custom HiseScript language definition, virtualized viewport slicer (pre-render
once, slice on scroll). Key files: `src/tui/components/Markdown.tsx`,
`src/tui/components/Output.tsx`, `src/tui/components/prerender.ts`.

---

## Phase 4 — Builder Mode + Plan Submode

**Goal**: the first mode with real depth. Local validation, module tree
tracking, plan recording, HiseScript generation. **First test balloon for
the REST-first workflow** — C++ endpoints are implemented and tested before
the CLI-side execution is wired up.

Tracks [#5](https://github.com/christoph-hart/hise-cli/issues/5) (builder)
and [#4](https://github.com/christoph-hart/hise-cli/issues/4) (plan submode).

### 4.0 HISE C++ builder endpoints (REST-first) ✓

The builder is the first mode that mutates HISE state via REST. Following
the REST-first principle, C++ endpoints were implemented and tested before
the CLI-side builder execution code.

**Status: Completed.** All builder and undo endpoints probed against live
HISE. Three C++ bugs found and fixed (empty runtime tree children, name
truncation, SynthGroup constrainer `!` negation). Two API inconsistencies
fixed (group apply returning null result, integer colours on disabled
chains). Canonical API contract documented in
`hise-source/guidelines/api/rest-api.md`. Friction points tracked in
`hise-source/guidelines/api/BUILDER_PITFALLS.md`.

**Actual C++ API** (consolidated, not per-operation endpoints):
- `GET /api/builder/tree` - hierarchical module tree with parameters,
  modulation chains, colours. Supports `moduleId`, `group`, `verbose`,
  `queryParameters` params.
- `POST /api/builder/apply` - batched operations: `add`, `remove`,
  `clone`, `set_attributes`, `set_id`, `set_bypassed`, `set_effect`,
  `set_complex_data`. Returns diff summary (`+`/`-`/`*` actions).
- `POST /api/undo/push_group` / `pop_group` - grouped execution (plan mode)
- `POST /api/undo/back` / `forward` - undo/redo
- `GET /api/undo/diff` / `history` - diff inspection
- `POST /api/undo/clear` - clear undo history

**4.0.4 — Mock data & contract alignment** ✓

- `src/mock/contracts/builder.ts` - Raw HISE tree types (`RawTreeNode`,
  `RawModulationChain`), diff types (`BuilderDiffEntry`, `BuilderApplyResult`),
  normalizer functions (`normalizeBuilderTree` -> `TreeNode`,
  `applyDiffToTree`, response normalizers). 29 contract tests.
- `src/engine/hise.ts` - Widened `HiseEnvelopeResponse.result` from
  `string` to `string | object | null` for builder object responses.
- `src/mock/runtime.ts` - Mock handlers for `GET /api/builder/tree`,
  `POST /api/builder/apply` (with diff tracking), undo group endpoints
  (`push_group`, `pop_group`, `GET diff`, `clear`).
- `src/mock/builderTree.ts` - Rewritten to match the "Hybrid Keys" mock
  project (23 modules, 15 types, 4 nesting depths, all chain types).

**Constrainer parser** (Track 1) ✓

- `src/engine/constrainer-parser.ts` - TypeScript port of HISE's
  `ProcessorMetadata::ConstrainerParser`. Handles `*`, positive subtype
  matching, `!` negation, mixed patterns. 10 tests.
- Wired into `validateChainConstraint()` in builder.ts for data-driven
  chain validation using constrainer strings from `moduleList.json`.
  13 chain constraint tests.

### 4.1 Builder parser ✓

**Status: Completed.** Full Chevrotain grammar rewrite matching the actual
HISE `builder/apply` operations. Updated grammar spec in
[DESIGN.md - Builder Mode](DESIGN.md#builder-mode).

**Grammar** (10 command rules):
- `add <type> [as "<name>"] [to <target>[.<chain>]]`
- `clone <target> [x<count>]`
- `remove <target>`
- `move <target> to <parent>[.<chain>]` (stub - not yet in C++ API)
- `rename <target> to "<name>"`
- `set <target>.<param> [to] <value>`
- `load "<source>" into <target>`
- `bypass <target>` / `enable <target>`
- `show tree` / `show <target>` / `docs [type-or-field]`

**Key features:**
- Multi-word targets via greedy `AT_LEAST_ONE(Identifier)` or `QuotedString`
- Dot notation for `set` (separates target from param: `set Master Chain.Volume to 0.5`)
- Chain auto-resolution by module type (SoundGenerator -> children,
  Effect -> fx, MidiProcessor -> midi, Modulator -> explicit `.chain` required)
- Comma chaining with verb inheritance and set target inheritance
  (`set X.Volume to 0.5, Pan to 10, LFO.FadeIn to 100`)
- 9 new keyword tokens + XCount multiplier + Comma in `tokens.ts`

**Instance ID completion** ✓

- `collectModuleIds()` tree walker - extracts `{id, type}` pairs from `TreeNode`
- Token-aware `complete()` using Chevrotain lexer for position detection
- Context-dependent completions: module types after `add`, instance IDs
  after `remove`/`clone`/`bypass`/`enable`/`rename`/`move`/`load`, parent
  IDs after `add ... to`, parameters after `set <target>.`
- Instance-to-type resolution for `set` param completion (e.g., `set Osc 1.`
  resolves "Osc 1" to SineSynth, completes SineSynth params)
- Auto-quoting: IDs with spaces get `insertText: '"Master Chain"'`
- Comma-aware: completes only the last segment after a comma

**Files modified/created:**
- `src/engine/modes/tokens.ts` - 9 keyword tokens, XCount, Comma, VERB_KEYWORDS
- `src/engine/modes/builder.ts` - Full parser rewrite, tree utilities,
  completion rewrite (~500 lines changed)
- `src/engine/highlight/builder.ts` - New keywords in syntax highlighter
- `src/engine/completion/engine.ts` - Updated keyword list (13 builder keywords)
- `src/engine/modes/builder.test.ts` - 105 tests (parser, comma chaining,
  validation, integration, collectModuleIds, instance completion)

**Removed from old spec** (not in C++ API): `clear`, `flush`, `select`,
`connect`, clone templates/brace-expansion.

**Added** (match C++ API): `rename` (set_id), `load...into` (set_effect),
`bypass`/`enable` (set_bypassed), comma chaining (maps to operations array).

### 4.2 Execution wiring + tree tracking ✓

**Status: Completed.** Builder commands execute against live HISE via
`POST /api/builder/apply`. Tree fetched on mode entry via `onEnter()`,
re-fetched after mutations. Sidebar updates via React state.

**Key decisions:**
- **`commandToOps()`**: maps parsed `BuilderCommand` → `BuilderOp[]` for
  the apply endpoint. Chain auto-resolution by module type + `currentPath`.
- **Pretty names**: users type "Sampler" (prettyName), resolved to
  "StreamingSampler" (type ID) via `resolveModuleTypeId()`. Validation
  suggests pretty names on typos.
- **Plan-aware tree fetch**: `fetchTree()` calls `GET /api/undo/diff` to
  detect active plan group (`groupName !== "root"`), then uses
  `?group=current` for plan tree or plain endpoint for runtime tree.
- **`onEnter()` on Mode interface**: called by `createModeHandler()` after
  `pushMode()`. Builder fetches tree, undo fetches history. Ensures sidebar
  has content immediately on mode entry (not deferred to first `parse()`).
- **`invalidateTree()`** on Mode interface: called by `executeOneShot()`
  after `/undo` one-shots so the active mode re-fetches its tree.
- **Tree sidebar refresh**: `modeTree` and `modeSelectedPath` stored as
  React state (`useState`), updated in `handleSubmit`'s `finally` block.
  `TreeSidebar` re-expands via `useEffect` on tree root identity change.
- **Compact view**: `/compact` toggles `compactView` flag. `compactTree()`
  strips chain nodes, promoting their module children — preserves chains
  on the active navigation path.
- **Root container guard**: `remove` rejects the tree root (project-name-aware).

### 4.3 Undo mode ✓

**Status: Completed.** `/undo` is a top-level mode (cyan `#66d9ef`) with
its own sidebar tree showing undo history and plan group state.

**Commands:** `back`, `forward`, `clear`, `plan "name"`, `apply`, `discard`,
`diff`, `history`. Simple keyword dispatch (no Chevrotain needed).

**Key decisions:**
- **Standalone mode** (not a builder submode): undo spans all domains.
  Inline one-shot calls work from any mode (`/undo back` from builder).
- **Sidebar tree**: `GET /api/undo/history` → flat list of past actions,
  active plan group nested one level. Cursor position highlighted with `>`.
  Built by `buildHistoryTree()` in `src/mock/contracts/undo.ts`.
- **Plan groups**: `plan "name"` → `POST /api/undo/push_group`. Builder
  continues to work normally — HISE validates against group state. `apply`
  commits as one undoable unit, `discard` rolls back.
- **Shared `DiffEntry` type**: `src/mock/contracts/builder.ts` defines
  `DiffEntry`, aliased as `BuilderDiffEntry` and `UndoDiffEntry`.
- **`/export`**: deferred (requires `builderPath` mapping from moduleList).

**Files:**
- `src/engine/modes/undo.ts` — UndoMode class
- `src/mock/contracts/undo.ts` — history/diff normalizers, tree builder
- `src/engine/highlight/undo.ts` — keyword tokenizer

**Phase 4 gate: passed.**
- ✓ All builder and undo C++ endpoints probed and validated
- ✓ 643 tests pass (contract normalizers, Chevrotain parser, instance
  completion, constrainer validation, undo mode, mock runtime)
- ✓ `npm run build && npm run typecheck` pass
- ✓ 5 `.tape` screencast tests passing

---

## Phase 5 — Wizard Framework

**Goal**: declarative multi-step workflows serving both TUI and CLI.

Tracks [#15](https://github.com/christoph-hart/hise-cli/issues/15).
Source wizard JSONs from HISE's C++ multipage dialogs live in `wizards/`.
Converted YAML definitions in `data/wizards/`.

### 5.1 Engine types + JSON parser + YAML format ✓

**Status: Completed.** Engine-layer wizard types, a converter from HISE
multipage dialog JSON to internal representation, and YAML serialization.

`WizardDefinition`, `WizardField` (5 types: text, file, choice, toggle,
multiselect), `WizardTab`, `WizardTask`, `WizardPostAction`, `WizardAnswers`,
`WizardValidation`, `WizardProgress`, `WizardExecResult`.

**Key decisions:**
- **YAML as canonical format**: HISE JSON is converted once via
  `scripts/convert-wizards.mjs`. Runtime loads YAML directly — no JSON
  parser in the hot path. YAML files are human-editable.
- **Flat field types**: no `Branch`/`Column`/`List` nesting from HISE JSON.
  Branches become conditional tabs (`tab.condition`). Radio-group buttons
  merged into `choice` fields by the converter.
- **`multiselect` field type**: added for tag-list-style multi-toggle fields
  (e.g., file type filters). Stored as comma-separated string.
- **`itemDescriptions`**: per-item tooltips shown dimmed next to each option
  during choice/multiselect editing.
- **`body`**: markdown field rendered below the header for self-documenting
  wizard descriptions (bullet points, tips, blockquotes).
- **`submitLabel`**: description shown next to the Submit button explaining
  what happens on submit.
- **Broadcaster wizard omitted**: too complex (6-page decision tree, not a
  form). The 6 ported wizards: `new_project`, `plugin_export`,
  `audio_export`, `compile_networks`, `install_package_maker`, `recompile`.

**Files:**
- `src/engine/wizard/types.ts` — all type definitions
- `src/engine/wizard/parser.ts` — HISE JSON → WizardDefinition converter
- `src/engine/wizard/yaml.ts` — YAML serialize/deserialize
- `src/engine/wizard/validator.ts` — answer validation, `isTabComplete()`
- `src/engine/wizard/executor.ts` — one-shot execution via HiseConnection
- `src/engine/wizard/registry.ts` — WizardRegistry loaded at session bootstrap
- `src/engine/wizard/index.ts` — re-exports
- `scripts/convert-wizards.mjs` — one-shot JSON→YAML conversion script
- `data/wizards/*.yaml` — 6 wizard definitions

### 5.2 `/wizard` slash command ✓

**Status: Completed.** Registered in `src/engine/commands/slash.ts`.

- `/wizard` or `/wizard list` → table of available wizards
- `/wizard <name>` → returns `wizardResult()` to activate TUI form
- `/wizard <name> key:value` → pre-fill fields
- `/wizard <name> --run key:value` → validate + execute directly
- `/wizard <name> --schema` → JSON field schema for CLI/LLM use
- Fuzzy-matched wizard IDs (prefix match)

`"wizard"` added to `ModeId` with accent `#e8a060` (copper).
`CommandResult` union extended with `type: "wizard"`.

### 5.3 TUI wizard form ✓

**Status: Completed.** Wizard form renders as a `PrerenderedBlock` in the
Output viewport using chalk. No Ink/React components — pure ANSI strings
with the same rendering pipeline as markdown blocks, echo, and errors.

**Key decisions:**
- **Output-block rendering**: three prior approaches failed (manual Ink
  padding, `wrap="truncate"`, `@inkjs/ui` components) due to Ink layout
  glitches. The working approach renders the entire form as ANSI lines via
  chalk and displays it through the Output viewport's existing slice-and-
  render pipeline. See `feedback_ink_rendering` memory.
- **Block replacement**: on each keystroke the last block in `outputBlocks`
  is replaced with a fresh render. Auto-scroll keeps it in view.
- **Three interaction modes**: navigate (arrows + tab), edit (typing +
  choice/multiselect expansion), submit (enter on button).
- **Input hidden during wizard**: the form captures all keys via the
  `useInput` handler in app.tsx. Output viewport gets the full height.
- **Deactivated render**: on submit/cancel the form re-renders with
  `active: false` (no signal-color highlights) before returning to normal.
- **Required field indicator**: `*` in accent color for empty required
  fields, disappears once filled.
- **File path completion**: `listPathCompletions()` in `src/tui/wizard-files.ts`
  reads the filesystem, filters by prefix/wildcard/directory flag, renders
  suggestions below the field like choice expansion. Tab accepts, Enter
  exits edit keeping typed value.
- **`✦` icon**: four-pointed star in accent color before the wizard title.

**Files:**
- `src/tui/components/wizard-render.ts` — pure render function
- `src/tui/components/wizard-keys.ts` — pure key handler (state transitions)
- `src/tui/wizard-files.ts` — filesystem path completion
- `src/tui/app.tsx` — integration (state, key routing, block replacement)

### 5.4 CLI commands + wizard aliases ✓

**Status: Completed.** `/wizard <name> --run` and `--schema` work via the
slash command handler. Wizard alias system registers top-level slash
commands from YAML `aliases:` fields (e.g., `/setup` → `/wizard setup`).
Aliases are registered after wizard definitions load in session bootstrap
and fed into the completion engine for tab completion.

Remaining for 1.0: dedicated `hise-cli wizard` entry point in
`src/cli/run.ts` with `--answers` JSON input and structured JSON output.

### 5.5 Pipeline executor + execution wiring ✓

**Status: Completed (client-side).** The `WizardExecutor` is fully wired
with three execution patterns:

1. **Sync** — POST returns result immediately (`recompile`, `new_project`,
   `install_package_maker`)
2. **Async job** — POST returns `{ jobId, async: true }`, executor polls
   `GET /api/wizard/status` every 500ms until `finished: true`
   (`audio_export`, future monolith/expansion encoding)
3. **Prepare-only** — POST returns build paths (`buildScript`,
   `buildDirectory`), executor forwards as `data` to subsequent internal
   compile task (`plugin_export`, `compile_networks`)

**Key changes:**
- `WizardExecResult.data?` carries structured inter-task data
- `InternalTaskHandler` gains optional `context?` parameter for receiving
  data from preceding HTTP tasks
- Compile handlers (`src/tui/wizard-handlers/compile-tasks.ts`) run system
  compiler via `PhaseExecutor`, reusing setup wizard's `filterXcodeLine`
- Init sections (`type: http`) added to `new_project`, `plugin_export`,
  `audio_export`, `install_package_maker` YAMLs for HISE-provided defaults
- `plugin_export` and `compile_networks` tasks split: HTTP prepare + internal compile
- `install_package_maker` gained `writePackageJson` task (was `tasks: []`)
- REST API contracts fully specified in `REST_API_ENHANCEMENT.md` §Wizard Endpoints

**Blocked on**: HISE C++ endpoint implementation. Client code is ready;
once endpoints return real data, the pipeline executes end-to-end.

### 5.6 Tests + screencast ✓

**Status: Completed.** 744 tests pass across 42 suites. 10 screencast
tests pass (7 existing + 3 wizard).

**Engine tests:** executor (25 tests including async polling, abort,
prepare+data forwarding, inter-task data), validator (13), render (16),
key handler (18), compile handlers (6).

**Screencast tests:** `wizard-list.tape` (list + form display + cancel),
`wizard-form.tape` (field navigation, text input, toggle, choice cycling),
`wizard-alias.tape` (/setup alias, tab completion).

**Phase 5 gate — passed:**
- ✓ `npm run build && npm run typecheck` pass
- ✓ `npm test` passes (744 tests, 42 suites)
- ✓ `/wizard list` shows 7 wizards, `/wizard <name>` opens form
- ✓ TUI form: navigate, edit text/choice/multiselect/toggle, file
  completion, submit
- ✓ Pipeline executor with async polling, prepare+compile, inter-task data
- ✓ Wizard aliases (`/setup` → setup wizard)
- ✓ `.tape` screencasts for wizard walkthrough (3 tests)
- ○ CLI `--answers` JSON execution path (deferred to Phase 7)

---

## Phase 6 — Remaining Modes

New `ModeId` entries for Phase 6: `ui`, `api`, `expansions`, `modules`,
`assets`, `presets`.
Accent colors: `ui: "#66d9ef"` (cyan), `api: "#b8bb26"` (warm green),
`expansions: "#d4879c"` (muted pink), `modules: "#83a598"` (soft teal),
`assets: "#d8c86f"` (golden yellow), `presets: "#d7a65f"` (warm amber).
Added to `MODE_ACCENTS` in `src/engine/modes/mode.ts` and shared
Chevrotain tokens in `src/engine/modes/tokens.ts` (new keywords: `At`,
`Remove`, `Move`, `Rename` for the UI grammar extension).

All modes support Phase 3.5 argument parsing for one-shot execution
(e.g., `/api Console.print` directly shows docs, `/modules AHDSR` shows
module reference).

Modes are ordered by C++ dependency: local-data-only modes first, then
modes requiring new REST endpoints (REST-first: C++ implementation +
tests before CLI-side mode code).

### 6.1 Module reference browser (`/modules`)

Tracks [#16](https://github.com/christoph-hart/hise-cli/issues/16).
**No C++ work needed** — pure local data from `DataLoader.loadModuleList()`.

Searchable offline reference for all HISE module types. Tree sidebar
shows module categories (from `moduleList.json` `categories` map) with
module types as children. Chat window renders markdown-formatted module
docs with parameter tables, modulation slots, interfaces, and builder
paths. Commands: type module name for full docs, `search` for fuzzy
search, `ls` to list by category, `params` for parameter-only view,
`compare` for side-by-side comparison. Completion: module names, category
names, parameter names within module context.

Phase 3.5: `/modules AHDSR` directly shows AHDSR docs.

### 6.2 API documentation browser (`/api`)

Tracks [#17](https://github.com/christoph-hart/hise-cli/issues/17).
**No C++ work needed for browsing** — local data from
`DataLoader.loadScriptingApi()`. Uses existing `POST /api/repl` for
example execution.

Read-only documentation browser for the HISE scripting API. Tree sidebar
shows class list grouped by category (namespace, object, component,
scriptnode) from `scripting_api.json`. Chat window renders full markdown
docs with method signatures, parameter tables, code examples, pitfalls,
and cross-references. Enriched classes (22 of 89) show additional detail
(thread safety, common mistakes, `obtainedVia`). Commands: type class
or `Class.method` name for docs, `search` for fuzzy search, `run N` to
execute code examples in-place via REPL (stays in `/api` mode), `cd` to
set class context, `ls` to list methods. No HISE connection required for
browsing; connection needed only for `run`.

Phase 3.5: `/api Console.print` directly shows method docs.

### 6.3 UI component management (`/ui`) — C++ first

Tracks [#18](https://github.com/christoph-hart/hise-cli/issues/18).
**REST-first**: 5 new endpoints needed. Existing endpoints
(`GET /api/list_components`, `GET /api/get_component_properties`,
`POST /api/set_component_properties`, `GET/POST /api/*_component_value`)
handle browsing and property mutation. New endpoints handle component
CRUD.

**C++ endpoints** (implement + test before CLI-side code):
- `POST /api/ui/add_component` — create component (`{moduleId, type, id,
  x, y, w, h, parentId?}`)
- `POST /api/ui/remove_component` — remove by ID
- `POST /api/ui/rename_component` — rename (`{moduleId, id, newId}`)
- `POST /api/ui/move_component` — change position/size
- `POST /api/ui/reparent_component` — move to different parent panel

Full CRUD for UI components via NLP grammar. Extends the builder
Chevrotain grammar (shared tokens, context flag) with UI-specific rules:
`add ScriptButton "name" at x y w h`, `remove name`, `set name prop
value`, `move name to x y`. Tree sidebar shows component hierarchy from
`GET /api/list_components?hierarchy=true`. Validates component types
against `scripting_api.json` `category: "component"` (14 types).
Navigation: `cd` into components, `ls` lists children. Completion:
component type names, existing component IDs, property names.

Validation ownership in this phase: `validate parameters` belongs to `/ui`
(moved out of `/project`).

Full specification in GitHub issue (see cross-reference table).

Phase 3.5: `/ui PlayButton` enters UI mode focused on PlayButton.

### 6.4 Expansion manager (`/expansions`) — C++ first

Tracks [#19](https://github.com/christoph-hart/hise-cli/issues/19).
**REST-first**: 6 new endpoints needed. No existing expansion endpoints.

**C++ endpoints** (implement + test before CLI-side code):
- `GET /api/expansions/list` — all expansions with properties + active
  status
- `POST /api/expansions/switch` — switch active expansion
- `POST /api/expansions/create` — create new expansion
- `POST /api/expansions/encode` — encode expansion assets
- `GET /api/expansions/assets` — list assets by type for an expansion
- `POST /api/expansions/refresh` — refresh expansion list

Full specification in
[REST_API_ENHANCEMENT.md](REST_API_ENHANCEMENT.md) § Expansion Management.

Manage HISE expansions: list, create, switch, encode. Tree sidebar shows
expansion list with asset children grouped by type (Images, AudioFiles,
SampleMaps, MidiFiles, UserPresets). Active expansion highlighted.
Commands: `list`, `switch`, `create`, `encode`, `cd` into expansion,
`ls` shows assets by type, `info` for properties, `refresh`. Dummy tree
for development until C++ endpoints are validated.

Phase 3.5: `/expansions switch "Pack 1"` one-shot switches.

### 6.5 DSP (Scriptnode) mode — C++ first

Tracks [#6](https://github.com/christoph-hart/hise-cli/issues/6).
**REST-first**: uses consolidated `GET /api/dsp/list`, `GET /api/dsp/tree`,
`POST /api/dsp/apply` endpoints (same pattern as builder/UI modes). See
[REST_API_ENHANCEMENT.md](REST_API_ENHANCEMENT.md) § DSP.
C++ endpoints implemented and tested before CLI-side mode code.

Chevrotain grammar for graph editing, nodes from `scriptnodeList.json`.
Shares token types with builder mode grammar (quoted strings, dot-paths,
identifiers, numbers). Tree sidebar shows the scriptnode network hierarchy
(root network as single root node, containers and nodes as children).
`set` works uniformly for parameters and properties (e.g.,
`set Osc1.Frequency 440`, `set Filter1.Frequency.SkewFactor 0.5`).
Parameters returned as `[{id, value}]` arrays; `?verbose=true` adds
range metadata. Connections are per-node (incoming modulation sources).

### 6.6 Script mode — full implementation

Tracks [#8](https://github.com/christoph-hart/hise-cli/issues/8).
Multi-line support (unclosed brackets — detected via Lezer parse tree),
`_` for last result, `/api` inline help (rendered as `markdown`
CommandResult — requires Phase 3.7 markdown renderer). Input syntax
highlighting already wired via the regex tokenizer (Phase 3.6); upgrade
to Lezer grammar is a drop-in replacement. Tree sidebar shows namespace
hierarchy from `scripting_api.json`. Diff indicators show variable
changes between compilations.

**Variable watch** (see
[DESIGN.md — Script Mode / Variable Watch](DESIGN.md#variable-watch)):

- Engine: `src/engine/modes/script-watch.ts` — polls
  `GET /api/inspect/watch_variables`, parses hierarchical debug info,
  applies glob/type filters client-side (glob matching via `picomatch`)
- TUI: sidebar panel or toggled split view with live-updating table.
  Type badges (R/V/C/G/N) in color. Expandable object/array children.
  `/watch [glob]` to toggle and filter.
- Configurable polling interval (default 500ms, matching HISE IDE)
- **REST-first**: depends on `GET /api/inspect/watch_variables` — new
  endpoint, C++ implementation + tests before CLI-side watch code

### 6.7 Inspect mode — full implementation

Tracks [#7](https://github.com/christoph-hart/hise-cli/issues/7).
Live monitoring (cpu, midi) via SSE subscriptions when available, with
polling `GET /api/inspect/cpu` at 500ms intervals as fallback (SSE is
not yet implemented in HISE C++ — see DESIGN.md SSE Status). The polling
fallback ships in 1.0; SSE upgrade is transparent when
[#12](https://github.com/christoph-hart/hise-cli/issues/12) delivers it.

### 6.8 Sampler mode — C++ first

Tracks [#11](https://github.com/christoph-hart/hise-cli/issues/11).
**REST-first**: requires `POST /api/sampler/*` endpoints (see
[REST_API_ENHANCEMENT.md](REST_API_ENHANCEMENT.md) § Sampler).
C++ endpoints implemented and tested before CLI-side mode code.

Selection-based workflow, sample map management, complex group manager.
Tree sidebar shows sample map structure (samplemap ID as root, groups
and zones as children).

Validation ownership in this phase: `validate samples` belongs to `/sampler`
(moved out of `/project`).

### 6.9 Project and Compile modes

Tracks [#9](https://github.com/christoph-hart/hise-cli/issues/9).
Project mode uses the tree sidebar for folder structure (project folder
as root). Diff indicators from git status (added/removed/modified files).
Project mode scope is limited to project inspection and settings.

### 6.10 HISE asset manager (`/assets`) — C++ first

Tracks [#20](https://github.com/christoph-hart/hise-cli/issues/20).
**REST-first**: requires `GET/POST /api/assets/*` endpoints for HISE asset
manager operations (list, install, update, uninstall, cleanup, versions,
local sources, dry-run test).

Manage HISE asset payloads with list/search/install/update/uninstall flows,
version browsing, and local source management. Full specification in GitHub
issue (see cross-reference table). Alias: `/assets create` invokes
`/wizard create_asset_payload`.

### 6.11 User preset manager (`/presets`) — C++ first

Tracks [#21](https://github.com/christoph-hart/hise-cli/issues/21).
**REST-first**: requires `GET/POST /api/presets/*` endpoints for listing,
loading, saving, default preset management, and validation.

Manage user presets as first-class objects with natural language commands
(`load`, `save`, `set default`, `reset`, `validate`). Tree sidebar mirrors
the `UserPresets` folder hierarchy. `reset` must hard-fail if no default
user preset is configured.

**Phase 6 gate — all must pass:**
- **C++ gate**: all new endpoints (UI mutations, expansions, DSP, sampler,
  HISE asset manager, user presets, watch_variables) pass unit tests in `ServerUnitTests.cpp`
- **hise-cli gate**: `npm test` passes with all mode parsers, tree
  building, search, completion, and markdown docs rendering
- All modes have at least one `.tape` screencast test
- `npm run build && npm run typecheck` pass
- **Integration**: each C++-dependent mode executes correctly against
  live HISE with validated endpoints

---

## Phase 7 — Polish

### 7.1 Command Palette (Ctrl+Space)

Tracks [#10](https://github.com/christoph-hart/hise-cli/issues/10).
Filterable overlay showing all modes and commands.

### 7.2 Remaining wizards

Tracks [#15](https://github.com/christoph-hart/hise-cli/issues/15).
Broadcaster, export, compile-networks, install-package,
create_asset_payload, update, migrate, nuke.

### 7.3 CLI polish

Files: `src/index.ts`, `src/cli/run.ts`

The baseline one-shot CLI already exists and uses the same `Session` and
`Mode` infrastructure as the TUI. Remaining work here is polish: richer
introspection flags like `--tree`, additional automation-oriented output,
and any follow-up ergonomics discovered during live usage.

### 7.4 SSE event streaming

Upgrade inspect mode and wizard pipelines from polling to SSE push when
available. Non-blocking — 1.0 ships with polling fallback. SSE is an
enhancement when [#12](https://github.com/christoph-hart/hise-cli/issues/12)
delivers the `GET /api/events` endpoint.

**Phase 7 gate (1.0 release gate) — all must pass:**
- `npm run build && npm run typecheck && npm test` all pass
- All modes have tests and at least one `.tape` screencast
- Command palette opens and filters correctly
- CLI frontend `src/cli/index.ts` produces structured JSON output
- Remaining wizards (broadcaster, export, compile-networks,
  create_asset_payload) render and execute in both TUI and CLI modes
- Manual: full end-to-end walkthrough with live HISE covering all modes

---

## Post-1.0 — Web Frontend

> Deferred from the 1.0 release. The isomorphic engine constraint (Phase 0)
> keeps the door open. This section is included for architectural context.

**Goal**: browser-based frontend sharing the engine layer. Terminal aesthetic
via monospace CSS. Three targets, implemented incrementally.

See [DESIGN.md — Web Frontend](DESIGN.md#web-frontend-future) and
[DESIGN.md — Decision #13](DESIGN.md#13-isomorphic-engine-for-web-compatibility).

### 8.1 Web shell

Directory: `src/web/`

React DOM app (Vite) that renders engine `Session` state in the browser.
Monospace CSS replicating the TUI aesthetic:

- Monospace font (`JetBrains Mono` / `Fira Code` / system fallback)
- All 4 color layers as CSS custom properties (same hex values as TUI)
- Layout regions (TopBar, Output, Input, StatusBar) as flexbox divs
- Box-drawing characters (`─`, `│`, `├`, `└`, `▎`) rendered natively
- Mode-colored prompts, type badges, tree connectors — all CSS
- Cursor blinking via CSS animation

Web superpowers beyond what the TUI can do:
- Hover tooltips on module types, API methods
- Clickable elements (expand trees, navigate to definitions)
- Resizable panes (sidebar, output split)
- Smooth scrolling
- Copy-to-clipboard buttons on code blocks
- Syntax highlighting via CodeMirror 6 using the same Lezer HiseScript
  grammar from the engine — zero additional parser work
- Markdown rendering via `react-markdown` or similar, consuming the same
  `marked` AST from the engine

### 8.2 Mock playground

The demo/playground — a standalone web app with `MockHiseConnection` and
bundled static datasets. No HISE instance needed.

- Interactive command entry with tab completion
- Mode switching, wizard walkthrough
- Module type browser (all modules with parameters from `data/moduleList.json`)
- API reference browser (all classes/methods from `data/scripting_api.json`)
- Scriptnode node browser (all nodes/factories from `data/scriptnodeList.json`)
- Deployable to GitHub Pages, Vercel, or similar static hosting

### 8.3 Live companion

Connect to a real HISE instance at configurable `host:port`. Uses
`HttpHiseConnection` (same `fetch()` API, works in browser).

- Full REPL functionality against live HISE
- Variable watch with live updates
- Module tree visualization
- Requires HISE on same machine (localhost) or network-accessible

### 8.4 Screencast live replay

Replace the asciinema-player on the HISE docs site with the live engine
replay. The same `.tape` files from `screencasts/` now drive the actual
engine `Session` with `MockHiseConnection` in the browser. Screencasts
become interactive — visitors see real syntax highlighting, real
completions, real mode transitions. `Annotation` commands render as
overlay captions. Visitors can pause and optionally take over typing.

This reuses the web shell (8.1) + mock playground (8.2) infrastructure.
The tape parser is already in the engine layer (isomorphic). The only
new code is the playback controller that feeds tape commands to the
Session at the scripted timing.

### Future: Remote access

Requires C++ changes (HISE binding to `0.0.0.0`, authentication) and
SSE/WebSocket for efficient push. Not in current scope.

### Future: Plugin UI testing via tape sessions

The `.tape` screencast format can be extended to drive UI tests for HISE
plugins. The same declarative structure that describes terminal interactions
(type, wait, assert output) maps naturally to plugin-level UI testing:

```tape
# Test page switching
Click "EffectsButton"
Wait 100ms
Assert Visible "EffectsPage"
Assert Hidden "MainPage"

Click "MainPageButton"
Wait 100ms
Assert Visible "MainPage"
Assert Hidden "EffectsPage"

# Test knob interaction
Set "CutoffKnob" 0.75
Assert Value "CutoffKnob" 0.75
Assert Connected "CutoffKnob" "SimpleFilter.Frequency"
```

New tape commands for plugin testing:

- `Click "<componentId>"` — simulate click on a UI component
- `Set "<componentId>" <value>` — set a component's value
- `Assert Visible "<componentId>"` — check component is visible
- `Assert Hidden "<componentId>"` — check component is not visible
- `Assert Value "<componentId>" <value>` — check component value
- `Assert Connected "<componentId>" "<processorId>.<param>"` — verify parameter connection
- `SendMidi NoteOn <note> <velocity>` — send MIDI into the plugin
- `SendMidi NoteOff <note>` — release a note
- `Wait <duration>` — already exists in the tape format

The tape parser (`src/engine/screencast/tape-parser.ts`) is isomorphic and
extensible. The execution backend would use the HISE runtime API
(`set_component_value`, `get_component_properties`, `screenshot`) instead of
terminal keystrokes, but the parser, test runner, and assertion framework
are shared infrastructure. Plugin developers could ship `.tape` files as
regression tests alongside their HISE projects.

---

## Dependencies on HISE C++ work

[#12](https://github.com/christoph-hart/hise-cli/issues/12) tracks all new
REST API endpoints. Following the REST-first principle, each group of
endpoints is implemented and tested in C++ before the corresponding
CLI-side mode code is written. The mode-side workflow, including mock runtime
contracts and live parity tests, is defined in [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md).

| hise-cli feature | Required HISE endpoint | Phase blocked |
|------------------|----------------------|---------------|
| Script mode (basic) | `POST /api/repl` (exists) | None — works now |
| Script mode (recompile) | `POST /api/recompile` (exists) | None — works now |
| Script mode (diagnostics) | `POST /api/diagnose_script` (exists) | None — works now |
| Script mode (file list) | `GET /api/get_included_files` (exists) | None — works now |
| Inspect mode (basic) | `GET /api/status` (exists) | None — works now |
| Connection probe | `GET /api/status` (exists, returns 503 while loading) | None — works now |
| UI browsing | `GET /api/list_components` (exists) | None — works now |
| UI properties | `GET/POST /api/*_component_properties` (exists) | None — works now |
| UI parameter validation | `POST /api/ui/validate_parameters` | Phase 6.3 |
| Module reference (`/modules`) | None — local `moduleList.json` | None |
| API docs (`/api`) | None — local `scripting_api.json` | None |
| Builder execution | `POST /api/builder/apply` (batched ops), `GET /api/builder/tree` | Phase 4 (4.0) ✓ |
| Undo/plan groups | `POST /api/undo/push_group`, `pop_group`, `back`, `forward`, `clear`; `GET /api/undo/diff`, `history` | Phase 4 (4.0) ✓ |
| UI component CRUD | `POST /api/ui/add_component`, `/remove_component`, `/rename_component`, `/move_component`, `/reparent_component` | Phase 6.3 |
| Expansion management | `GET /api/expansions/list`, `/assets`; `POST /api/expansions/switch`, `/create`, `/encode`, `/refresh` | Phase 6.4 |
| DSP mode | `POST /api/dsp/*` | Phase 6.5 |
| HISE asset manager (`/assets`) | `GET /api/assets/list`, `/versions`; `POST /api/assets/install`, `/update`, `/uninstall`, `/cleanup`, `/add_local`, `/remove_local`, `/test` | Phase 6.10 |
| User preset manager (`/presets`) | `GET /api/presets/list`, `/get_default`; `POST /api/presets/load`, `/save`, `/set_default`, `/clear_default`, `/reset_to_default`, `/validate`, `/validate_all` | Phase 6.11 |
| Variable watch | `GET /api/inspect/watch_variables` (new) | Phase 6.6 |
| Sampler mode | `POST /api/sampler/*`, `/validate_maps` | Phase 6.8 |
| SSE events | `GET /api/events` (not yet implemented in C++) | Phase 6-7 |

Phases 0–3 require **no new C++ endpoints**. Everything uses existing APIs
or local validation against static datasets. Phase 6.1 (`/modules`) and
6.2 (`/api`) also require no new endpoints.

---

## File disposition

| Current file | Status | Notes |
|---|---|---|
| `src/index.ts` | Modified in Phase 2.7 | Rewired to new TUI |
| `src/app.tsx` | Removed | Legacy pipe-based REPL deleted |
| `src/pipe.ts` | Removed | Legacy named pipe transport deleted |
| `src/theme.ts` | Removed | Replaced by `src/tui/theme.ts` |
| `src/hooks/usePipe.ts` | Removed | Legacy pipe hook deleted |
| `src/hooks/useCommands.ts` | Removed | Legacy hook deleted |
| `src/menu/App.tsx` | Removed | Legacy menu deleted |
| `src/components/*` | Removed | Legacy components deleted |
| `src/setup/*` | Removed | Legacy setup flow deleted |
| `src/setup-core/*` | Removed | Legacy setup types/helpers deleted |
| `docs/LEGACY_SETUP_SCRIPTS.md` | Reference | Preserved setup templates for reimplementation |

<!-- All design questions resolved — see "Resolved Design Decisions" at top -->
