# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview — hise-cli

Modal REPL and CLI for [HISE](https://hise.dev), an open-source framework for building
audio plugins. Two frontends (TUI for humans, CLI for LLMs) share one engine layer.

## Key Concepts

**Smart client**: The CLI validates locally using shipped JSON datasets in `data/`
(module types, parameter ranges, chain constraints, API signatures) and delegates
execution to HISE. See [DESIGN.md](DESIGN.md) for the full architecture.

**HISE communication**: HTTP REST API on `localhost:1900` (request/response). SSE for
push events is planned but not yet implemented in HISE C++ - polling is the 1.0 fallback.

**Three-layer design**: `engine/` (zero UI deps), `tui/` (inline Ink REPL),
`cli/` (JSON output). The engine layer must never import Ink, React, or terminal
libraries. The TUI is a sticky-bottom inline shell — no alt-screen, no full-screen
layout. Output blocks commit to scrollback via Ink `<Static>`. Tree panel toggles
above the prompt with **Ctrl+B**; `/compact` (builder mode) flattens chains.

**Isomorphic engine** (`src/engine/`): zero `node:` imports — no `node:fs`, `node:path`,
`node:child_process`. Platform-specific operations use `DataLoader` (filesystem access)
and `PhaseExecutor` (shell execution) interfaces. See [DESIGN.md](DESIGN.md) Decision #13.

**Static datasets** in `data/`: `moduleList.json` (module types + parameters),
`scriptnodeList.json` (scriptnode factories + nodes), `scripting_api.json` (HiseScript
API classes + methods). Used for tab completion, local validation, and inline help.
See `src/engine/data.ts` for type definitions.

**Wizard framework**: Declarative multi-step workflows for complex operations (broadcaster
setup, asset payloads, monolith encoding, plugin export, HISE installation). Same
definition serves TUI (step-by-step form rendered inline in the output log) and
CLI (single-shot with `--answers` JSON).
Source wizard JSONs from HISE's C++ multipage dialogs live in
`data/wizards/`. Conversion guide: [docs/WIZARD_CONVERSION.md](docs/WIZARD_CONVERSION.md).

**Pre-1.0 policy**: Before `1.0.0`, stale systems are removed aggressively. Do not preserve
backwards compatibility for obsolete commands, files, or APIs. Keep only explicit reference
material when useful for reimplementation.

**REST-first development**: Follow [MODE_DEVELOPMENT.md](MODE_DEVELOPMENT.md) for the
canonical mode workflow: contract probing, shared mock runtime support, engine work
against normalized mock payloads, and live parity tests. For new HISE REST endpoints,
pair that workflow with the C++ endpoint work tracked in [ROADMAP.md](ROADMAP.md).

**Terminal markdown renderer**: Renders markdown via `marked` + `marked-terminal`
with syntax-highlighted code blocks. Pre-rendered to ANSI strings once via
`renderMarkdown()` in `src/tui/markdown.ts`, then committed to scrollback via
Ink `<Static>` (no virtualization needed in inline shell — terminal handles scroll).

## Build & Verify

```bash
npm run build          # esbuild → dist/index.js
npm run typecheck      # tsc --noEmit
npm run test           # vitest run (single file: npx vitest run <path>; -t "name" by pattern)
npm run dev            # build + start
```

Three gates (build, typecheck, test) must pass.

**Live contract tests** in `src/live-contract/**/*.live.test.ts` (require HISE on
`:1900`): `test:live-contract[:inspect|:script|:dsp|:project]`. **Screencasts**:
`test:screencasts` (uses `vitest.screencast.config.ts`, requires `npm run build` first).

**HISE source reference**: clone `https://github.com/christoph-hart/HISE` (no
submodules) into `hise-source/` for C++ inspection. Gitignored — local reference only.

## Release pipeline

Tag-triggered (`v*`) via `.github/workflows/release.yml` — parallel macOS +
Windows jobs on self-hosted runners produce `hise-cli.pkg` (universal2,
codesigned + notarized) and `hise-cli-setup.exe` (Inno Setup, see
`installer/hise-cli.iss`). `workflow_dispatch` runs build-only smoke tests
without publishing. Runner bootstrap: [docs/RUNNER_SETUP.md](docs/RUNNER_SETUP.md).

`hise-cli update` (`src/cli/update.ts`) resolves the latest tag via
`/releases/latest` redirect, runs the platform installer (macOS
`sudo installer -pkg`; Windows rename-trick + `/VERYSILENT`). Auto-check fires
2s into TUI launch only — CLI stays silent for LLM agents.

### Web SPA embedding

The bun-compiled binary serves `--web` from memory. Build chain:
`build-web.mjs → embed-web-assets.mjs → build-embed.mjs → esbuild`. The embed
step writes `src/web/embedded-assets.ts` (gitignored) — base64 `Map<string,
Uint8Array>` decoded once at startup.

## Project Structure

Top-level layout under `src/`:

- `engine/` — shared core (zero UI/`node:` deps). Subdirs: `commands/`, `modes/`,
  `completion/`, `highlight/`, `screencast/`, `wizard/`, `project/`, `run/`,
  `audio/`, `assets/`. Key files: `session.ts`, `hise.ts`, `data.ts`, `result.ts`.
- `tui/` — inline Ink REPL shell. `InlineApp.tsx` is the root. Node platform
  adapters: `node*.ts` (data loader, HISE launcher, phase executor, asset I/O).
  Subdirs: `wizard-handlers/`, `screencast/`.
- `cli/` — JSON-output CLI (`run.ts`, `args.ts`, `help.ts`, `update.ts`, …).
- `live-contract/` — `*.live.test.ts` against running HISE. `mock/` — mock
  runtime. `web/` + `web-embed/` — `--web` SPA + bundled assets.
- `index.ts` — entry point (TUI + one-shot CLI dispatcher).

Outside `src/`: `data/` (shipped JSON datasets + `wizards/` conversion sources),
`scripts/` (esbuild + binary + web build scripts), `screencasts/` (VHS `.tape`).

New code follows the `engine/` / `tui/` / `cli/` split.

## Documentation Rules

**Source code is the single truth** for exact values, counts, interface definitions,
hex colors, and implementation details. Design docs describe *what and why* (architecture,
visual intent, design decisions). Never duplicate into docs:

- Exact test counts, file counts, method counts, line counts
- TypeScript interface or type definitions (reference the source file instead)
- Hex color values (live in `src/tui/theme.ts` and `src/engine/highlight/tokens.ts`)
- Full directory listings of every file (use structural descriptions with brief purpose)
- Code examples that mirror actual source (they become stale immediately)

When referencing implementation details, point to the source file location:
`see src/engine/modes/mode.ts for the full interface`.

### Grammar reference

[`docs/CLI_GRAMMAR.md`](docs/CLI_GRAMMAR.md) is the **canonical source of truth**
for the hise-cli command grammar. Any change to verb shape, keyword
inventory, value forms, comma-chaining rules, BNF, or per-mode verb tables
must update CLI_GRAMMAR.md in the same PR. Parser, dispatcher, completion,
highlighter, and help text follow the spec — never the other way around.

## Conventions

Full reference: [docs/CODE_STYLE.md](docs/CODE_STYLE.md). Highlights:

- Tabs, double quotes, semicolons, trailing commas. `camelCase.ts` /
  `PascalCase.tsx`. Interfaces over enums; string-literal unions.
- TypeScript: ES2022, Node16 modules, strict mode. `.js` extension required on
  local imports. ESM only. `node:` prefix on builtins — **forbidden in
  `src/engine/`**.
- No default exports. Tests colocated (`foo.test.ts` next to `foo.ts`).
- Git commits: lowercase, terse, no conventional-commits prefix.
- **Help text sync**: when adding/changing commands, modes, or wizards, update
  both `src/engine/commands/help.ts` (TUI `/help`) and `src/cli/help.ts` (CLI
  `--help`). CLI help is the primary LLM reference — full syntax + examples +
  subcommands.
