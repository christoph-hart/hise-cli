---
name: hise-cli
description: Use hise-cli to inspect, edit, validate, and document HISE projects safely from agent workflows.
allowed-tools: Read Grep Glob Bash
---

# hise-cli

Use `hise-cli` for HISE project automation. Prefer dedicated CLI modes and documented wrappers over ad-hoc HiseScript snippets.

## Verify

Run these first when you need to confirm the local CLI surface:

```bash
hise-cli --help
hise-cli agent-context --agent
```

For documentation lookup, use `hise-cli mcp` so the workflow stays inside the CLI surface.

## Discovery

Use deterministic local lookup before guessing commands:

```bash
hise-cli which "set a script callback from a file" --agent
hise-cli agent-context script --agent
hise-cli agent-context mcp --agent
```

Use `--select <path>` to keep JSON small:

```bash
hise-cli which "inspect script symbols" --agent --select value.matches
```

## MCP Documentation

Use `hise-cli mcp` for HISE documentation lookup from this skill:

```bash
hise-cli mcp search_hise --query Content.addKnob --domain api --limit 3 --agent
hise-cli mcp explore_hise --query sampler --agent
hise-cli mcp query_scripting_api --api-call ScriptSlider.setControlCallback --agent
hise-cli mcp resources/read --uri hise://style-guides/hisescript-style --agent
```

Do not invent HiseScript APIs, UI properties, module parameters, or LAF functions from JavaScript knowledge. Look them up with `hise-cli mcp` or `hise-cli -api` first. If the current agent already has native HISE MCP access, that is equivalent for docs lookup.

## Script Workflow

Avoid shell-quoting callback bodies. Use stdin, files, or JSON files:

```bash
hise-cli script get --module-id Interface --callback onInit --agent
hise-cli script set --module-id Interface --callback onInit --file ./onInit.js --agent
hise-cli script set --module-id Interface --callback onInit --stdin --agent
hise-cli script set --module-id Interface --callbacks-json ./callbacks.json --agent
```

`script set` compiles by default. Add `--no-compile` only when intentionally staging changes.

For external script files, diagnose before compiling when possible:

```bash
hise-cli script diagnose --file-path Scripts/UI.js --agent
hise-cli script compile --module-id Interface --agent
```

Use REPL for read-only queries or explicit calls to existing functions. Do not use REPL to create persistent variables, callbacks, includes, or large source edits:

```bash
hise-cli script repl --module-id Interface --stdin --agent
```

Inspect compiled script symbols with server-side filtering to avoid huge responses:

```bash
hise-cli script show tree --module-id Interface --symbols-only --agent
hise-cli script show tree Knob --module-id Interface --format flat --limit 20 --agent
hise-cli script show Components.Knob1 --module-id Interface --agent
```

## Modal Modes

Use the mode that matches the state you are changing:

```bash
hise-cli -builder "show tree" --agent
hise-cli -ui "show tree" --agent
hise-cli -ui set Button1.text "Start" --agent
hise-cli -dsp "show tree" --agent
```

Prefer these modes over mutating UI, builder, DSP, project, or asset state through REPL-side HiseScript when a dedicated command exists.

## Output And Errors

Use `--agent` for machine-readable output. It implies JSON and compact output:

```bash
hise-cli script get --module-id Interface --agent
```

Use `--select <path>` for focused output. Missing paths return `code: "select_not_found"`.

Agent errors use stable `code` values. Exit codes are:

- `0` success
- `1` `execution_error` or generic failure
- `2` `usage_error` or `select_not_found`
- `3` `hise_unavailable`
- `4` `hise_api_error`
- `5` `validation_error`
- `6` `expectation_failed`

## Decision Rules

- Prefer `hise-cli which` and `hise-cli agent-context` for command discovery.
- Use `hise-cli mcp` or equivalent native HISE MCP docs before guessing HISE APIs.
- Prefer stdin, file, or JSON-file inputs for multi-line or nested data.
- Prefer `--target "Script FX1"` syntax for targets with spaces.
- Keep `onInit` small in real projects; include external files that can be diagnosed separately.
- Prefer component-specific control callbacks using `Component.setControlCallback(f)`. HISE requires `f` to be an `inline function` reference with signature `(component, value)`.
- Do not rely on global `--compact` to alter command semantics. Use explicit mode options such as `--symbols-only` for compact tree shapes.
