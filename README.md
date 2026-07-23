# hise-cli

[![Latest release](https://img.shields.io/github/v/release/christophhart/hise-cli?label=latest&sort=semver)](https://github.com/christophhart/hise-cli/releases/latest)
[![Release build](https://img.shields.io/github/actions/workflow/status/christophhart/hise-cli/release.yml?branch=master&label=build)](https://github.com/christophhart/hise-cli/actions/workflows/release.yml)

Official command-line interface for [HISE](https://hise.dev) — a modal REPL
and automation tool for building audio plugins.

## What it does

`hise-cli` connects to a running HISE instance and gives you a fast, modal
shell for editing modules, UI, scriptnode graphs, and HiseScript without
leaving the terminal. Guided wizards cover the longer chores (HISE setup,
plugin export, network compilation, audio rendering, installer packaging),
and every command also runs one-shot from your shell with structured JSON
output — so the same tool drives interactive workflows, CI pipelines, and
LLM agents.

## Install

### Standalone binary (no Node.js required)

**macOS** (universal, Apple Silicon + Intel — signed + notarized):

```bash
curl -fsSL -o /tmp/hise-cli.pkg https://github.com/christophhart/hise-cli/releases/latest/download/hise-cli.pkg \
  && sudo installer -pkg /tmp/hise-cli.pkg -target /
```

Installs to `/usr/local/bin/hise-cli` (already on `PATH`).

**Windows** (PowerShell, x64):

```powershell
irm https://github.com/christophhart/hise-cli/releases/latest/download/hise-cli-setup.exe -OutFile $env:TEMP\hise-cli-setup.exe
& $env:TEMP\hise-cli-setup.exe /VERYSILENT /NORESTART
```

Per-user install (no UAC). Adds `hise-cli` to your `PATH`. Open a new shell
after install so the updated `PATH` is picked up.

**Linux** (x64 + ARM64):

```bash
curl -fsSL https://github.com/christophhart/hise-cli/releases/latest/download/install.sh | sh
hise-cli
```

Installs to `~/.local/bin/hise-cli` and verifies the release checksum. Override
the destination with `HISE_CLI_INSTALL_DIR`. Node.js users can alternatively
run `npm i -g @hise/cli` or use `npx @hise/cli` without installing.

The automated `/setup` flow supports Debian, Ubuntu, and compatible systems
with `apt-get`. Other distributions can use hise-cli, but their HISE build
dependencies must currently be installed manually.

## Get HISE building on your machine — `/setup`

If you've never compiled HISE from source, this is your starting line.
The `/setup` wizard is a fully automated replacement for the manual
toolchain setup that has historically blocked new HISE developers — it
detects what your system already has, installs only what's missing, then
clones, configures, and builds HISE end-to-end.

```bash
hise-cli              # then
> /setup
```

What the wizard takes care of for you:

- Platform compiler toolchain (Xcode CLT on macOS, Visual Studio Build
  Tools on Windows, gcc/clang + dev headers on Linux)
- Optional tools: IPP (Windows), Faust
- FFTW development libraries on Linux (enabled by default for projects using
  `AUDIOFFT_FFTW3=1`; review FFTW licensing before distribution)
- Projucer (downloaded and built automatically)
- HISE source clone with the right submodules and branch
- First full build + smoke test that the resulting binary launches

Each step is detected idempotently — re-running `/setup` after a partial
failure resumes from where it stopped instead of starting over. Pair with
`/update` to pull the latest CI-green develop commit and rebuild whenever
you want a fresh HISE.

## Quickstart

```bash
hise-cli                              # launch the interactive REPL
```

Inside the REPL:

```
/help                                 # list every mode and wizard
/setup                                # build HISE from source (see above)
/builder                              # enter a mode
/wizard plugin_export                 # run a guided workflow
```

Run any mode command one-shot from your shell (JSON output by default,
`--pretty` for terminal-friendly text):

```bash
hise-cli -builder "show tree"
hise-cli -script "Engine.getSampleRate()"
hise-cli -wizard run plugin_export --answers '{"projectType":"Instrument"}'
```

Connects to HISE at `http://127.0.0.1:1900` (REST API must be enabled in
HISE settings). Add `--mock` to test without a running HISE.

## Feature catalog

### REPL modes

Each mode has its own grammar, tab completion, and `/help` text. Enter with
`/<mode>` (TUI) or run one-shot with `hise-cli -<mode> "<command>"`.

| Mode        | What you do |
|-------------|-------------|
| `/builder`  | Add, remove, move, clone modules in the signal chain; set parameters |
| `/ui`       | Add, configure, reparent UI components (sliders, buttons, panels, …) |
| `/dsp`      | Edit Scriptnode graphs — add nodes, connect modulation, set parameters |
| `/script`   | Live HiseScript REPL with API completion and console capture |
| `/project`  | Project lifecycle — list, switch, save/load, settings, preprocessor defines |
| `/sequence` | Compose and play timed MIDI sequences for synth testing |
| `/inspect`  | Runtime monitor — HISE version, current project, processors |
| `/assets`   | Install, manage, and publish HISE asset packages (store + local sources) |
| `/undo`     | Undo/redo navigation, plan groups for atomic multi-step edits |
| `/hise`     | Control the HISE process — launch, shutdown, screenshot, profile, playground |
| `/publish`  | Build and sign installer packages from compiled binaries |
| `/export`   | Export targets and build artifacts |

### Wizards

Multi-step guided workflows. Same definition serves the TUI (inline form)
and the CLI (`hise-cli -wizard run <id> --answers '{…}'`).

| Wizard                  | What it does |
|-------------------------|-------------|
| `setup`                 | **Featured above** — fully automated HISE-from-source bootstrap (toolchain + Projucer + clone + build) |
| `update`                | Pull latest CI-green develop commit and rebuild HISE |
| `new_project`           | Create a HISE project from template (empty / HXI import / Rhapsody) |
| `plugin_export`         | Compile project as VST3 / AU / AAX plugin or standalone |
| `compile_networks`      | Compile Scriptnode networks to a C++ DLL |
| `recompile`             | F5-style recompile with optional cache clearing |
| `audio_export`          | Render audio output to WAV (realtime or offline) |
| `install_package_maker` | Author an installable asset package from the current project |
| `build_installer`       | Sign and package binaries into platform installers |

### Automation & integrations

- **Structured JSON output** — every one-shot command emits
  `{ ok, result, logs, errors }`. Exit code `0` on success, `1` on error.
  Designed for CI pipelines and LLM agents.
- **`.hsc` test scripts** — write multi-step scenarios with `/builder`,
  `/script`, and `/expect` assertions. Run with
  `hise-cli --run script.hsc [--mock] [--dry-run] [--verbosity=…]`.
- **`--mock` mode** — exercise commands and tests without a running HISE
  instance.
- **`hise-cli update`** — self-update to the latest signed/notarized
  GitHub release.
- **HiseScript diagnostics** — `hise-cli diagnose <file.js>` runs the
  shadow parser and emits errors as JSON or pretty text. Plugs into
  Claude Code as a post-edit hook (see below).

## HiseScript diagnostics in Claude Code

`hise-cli diagnose` doubles as a lightweight LSP — wire it into Claude Code
so script errors surface after every file edit.

**1. Create `~/.claude/hise-lsp.sh`:**

```bash
#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
if [[ "$FILE" == */Scripts/*.js ]]; then
  DIAG=$(hise-cli diagnose "$FILE" --format=pretty --errors-only 2>&1)
  if [ -n "$DIAG" ]; then
    echo "" >&2
    echo "$DIAG" >&2
    exit 2
  fi
fi
```

**2. Add to `~/.claude/settings.json`:**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hise-lsp.sh"
          }
        ]
      }
    ]
  }
}
```

HISE must be running with the project open. Scripts must be included in a
ScriptProcessor and compiled at least once for diagnostics to work.

## Requirements

- Node.js 18+ (only for the `npm` install path; the standalone binary has none)
- A running HISE instance with the REST API enabled (default port `1900`)

## License

MIT
