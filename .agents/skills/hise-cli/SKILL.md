---
name: hise-cli
description: Use hise-cli direct commands to inspect and modify HISE builder trees, UI components, DSP networks, and HiseScript callbacks.
allowed-tools: Read Grep Glob Bash
---

# hise-cli

Use `hise-cli` for automated development of HISE projects.

This skill is opinionated: use the shown command shape first. Other supported forms may exist in `--help`, but agents should not branch unless a command fails or `which` returns a different recipe.

## Verify

Run these first when you need to confirm the local CLI surface:

```bash
hise-cli --help
hise-cli -status --agent
hise-cli agent-context --agent
```

For documentation lookup, use `hise-cli mcp` so the workflow stays inside the CLI surface.

## Discovery

Start with `which`, then fetch only the selected command recipe. Do not load full mode context by default.

```bash
hise-cli which "connect slider to filter cutoff" --agent --select value[0]
hise-cli agent-context --command ui.connect.control --agent
```

Use compact mode context only for multi-command workflows or strategy decisions:

```bash
hise-cli agent-context ui --agent
```

Use full mode context only when compact context and command recipes are insufficient:

```bash
hise-cli agent-context ui --full --agent
```

## MCP Documentation

Use `explore_hise` when unsure. Use exact query tools only when you already know the symbol or API class.

```bash
hise-cli mcp explore_hise --query "slider callback" --agent
hise-cli mcp query_scripting_api --api-call ScriptSlider.setControlCallback --agent
```

Do not invent HiseScript APIs, UI properties, module parameters, or LAF functions from JavaScript knowledge. Look them up with `hise-cli mcp` first. If the current agent already has native HISE MCP access, that is equivalent for docs lookup.

## Script Workflow

For generated callback bodies, use stdin. For new persistent script features, use `script add-file` first so the code lives in an external file that can be diagnosed and compiled separately.

```bash
hise-cli script get --module-id Interface --callback onInit --agent
hise-cli script set --module-id Interface --callback onInit --stdin --agent
hise-cli script add-file UI/MyControls.js --module-id Interface --agent
hise-cli script diagnose --file-path Scripts/UI/MyControls.js --agent
hise-cli script compile --module-id Interface --agent
```

Keep `onInit` small in real projects: initialize the interface, include external files, and avoid large implementation bodies directly in the callback.
Do not build static UI layout in HiseScript callbacks. Use `hise-cli ui add/set/connect` for components, bounds, text, colours, and hierarchy; use scripts for callbacks, runtime behaviour, LAF, and paint routines on existing components.
If `Content.addXXX()` is unavoidable, omit position arguments and set bounds afterwards with `hise-cli ui set --component <id> --bounds x,y,w,h --agent`; this keeps Interface Designer edits from jumping back after recompilation.

Use REPL only for short read-only queries or explicit calls to existing functions:

```bash
hise-cli script repl --module-id Interface --stdin --agent
```

Inspect compiled script symbols with server-side filtering to avoid huge responses:

```bash
hise-cli script show tree --module-id Interface --symbols-only --agent
hise-cli script show tree Knob --module-id Interface --format flat --limit 20 --agent
```

## Builder, UI, And DSP Workflows

Use direct flag-style commands for builder, UI, and DSP automation.

### Inspect Before Mutating

```bash
hise-cli builder tree --agent
hise-cli builder show --module Drive --agent
hise-cli builder show --module Drive --param Gain --agent
hise-cli ui tree --agent
hise-cli dsp tree --module "Script FX1" --agent
```

### Builder: Add And Configure Modules

```bash
hise-cli builder add --type SimpleGain --id Drive --agent
hise-cli builder set --module Drive --Gain -6 --Balance 50 --agent
hise-cli builder add --type LFO --id LeadGainLFO --parent Lead --chain "Gain Modulation" --agent
hise-cli builder set --module "Script FX1" --network my_dsp --agent
```

Use exact HISE parameter names for dynamic flags, for example `--Gain`, `--Balance`, and `--Frequency`.

### UI: Add Controls And Link Parameters

```bash
hise-cli ui add --type ScriptSlider --id Cutoff --agent
hise-cli ui set --component Cutoff --bounds 0,0,128,32 --text Cutoff --itemColour 0xFFFFFFFF --agent
hise-cli ui set --component Cutoff --parent ControlsPanel --agent
hise-cli ui connect --component Cutoff --target MainFilter --param Frequency --matched --agent
hise-cli ui screenshot --component Cutoff --scale 0.5 --output images/cutoff.png --agent
```

Use exact HISE property names for dynamic flags, for example `--itemColour`, `--fontSize`, and `--visible`.
For reparenting, prefer `--parent`; `--parentComponent` is accepted when metadata suggests that property name.
`ui tree --agent` displays the root as `root`; omit `--parent` for root-level adds, or use `--parent root` when explicit root placement is clearer. `--parent Content` is accepted only as a compatibility alias for root.
Use `ui screenshot` for full interface PNGs or `--component <id>` to crop to a component's bounds. `--module` defaults to `Interface`.
Build static UI structure with UI commands first: hierarchy, bounds, text, colours, and grouped IDs. Dynamic UI logic means callbacks and runtime updates, not scripted creation or layout of static controls.
Use HiseScript for callbacks, runtime behaviour, LAF, and paint routines on existing components.
If scripted `Content.addXXX()` creation is unavoidable, do not pass position arguments; set bounds with `ui set` afterwards to preserve Interface Designer editability.
Prefer nested panels and focused components over one large painted background. Do not remove/recreate controls just to reparent them; use `ui set --parent`.
After visual-risk edits such as Path drawing, FloatingTile layout, LAF, paint routines, or complex nesting, capture the smallest useful screenshot with `--component` and a low `--scale`.

### DSP: Edit Scriptnode Networks

```bash
hise-cli builder set --module "Script FX1" --network my_dsp --agent
hise-cli dsp tree --module "Script FX1" --agent
hise-cli dsp add --module "Script FX1" --type core.filter --id F1 --agent
hise-cli dsp set --module "Script FX1" --node F1 --Frequency 1000 --skewFactor 0.3 --middlePosition 1000 --agent
hise-cli dsp connect --module "Script FX1" --source LFO1 --target F1 --param Frequency --matched --agent
hise-cli dsp connect --module "Script FX1" --source Root --source-param Cutoff --target F1 --param Frequency --agent
hise-cli dsp save --module "Script FX1" --agent
```

`--source-param` and `--source-output` append a dot child to the source path internally. They are mutually exclusive.

### Validate Before Committing

Use `--dry-run` for builder/UI/DSP mutations when uncertain:

```bash
hise-cli builder add --type LFO --id LeadGainLFO --parent Lead --chain "Gain Modulation" --dry-run --agent
hise-cli ui connect --component Cutoff --target MainFilter --param Frequency --matched --dry-run --agent
hise-cli dsp connect --module "Script FX1" --source LFO1 --target F1 --param Frequency --matched --dry-run --agent
```

## Verification Workflow

Verify state with direct read commands before and after mutations. Use `--select <path>` only for large read outputs.

```bash
hise-cli builder tree --agent
hise-cli builder show --module Drive --agent
hise-cli builder show --module Drive --param Gain --agent
hise-cli ui tree --agent
hise-cli dsp tree --module "Script FX1" --agent
```

## Output And Errors

Use `--agent` for machine-readable output. It implies JSON and compact output:

```bash
hise-cli script get --module-id Interface --agent
```

Agent errors use stable `code` values. Exit codes are:

- `0` success
- `1` `execution_error` or generic failure
- `2` `usage_error` or `select_not_found`
- `3` `hise_unavailable`
- `4` `hise_api_error`
- `5` `validation_error`
- `6` `expectation_failed`

## Decision Rules

- Start with `hise-cli which "<intent>" --agent --select value[0]`; use `agent-context --command <id>` only for full command details.
- Use `hise-cli mcp explore_hise` before guessing, and exact MCP query tools only when you know the symbol.
- Use direct `builder`, `ui`, and `dsp` commands for project mutations.
- Use dynamic exact HISE flags for normal property and parameter writes. Use `--param/--value` only if `which` or `agent-context` specifically recommends it.
- Use `--dry-run` before uncertain builder/UI/DSP mutations.
- Inspect parameter metadata before setting unfamiliar values.
- Use stdin for generated in-memory callback bodies.
- Use `script add-file` for new persistent script features, then diagnose and compile the returned file path.
- Keep `onInit` small in real projects; use `hise-cli script add-file <relative-path>.js --module-id Interface --agent` for new external files so they can be diagnosed separately.
- Prefer component-specific control callbacks using `Component.setControlCallback(f)`. HISE requires `f` to be an `inline function` reference with signature `(component, value)`.
- Do not rely on global `--compact` to alter command semantics. Use explicit mode options such as `--symbols-only` for compact tree shapes.
