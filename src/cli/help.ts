import type { CommandEntry } from "../engine/commands/registry.js";
import { renderAgentModeHelp } from "./agentContext.js";

export function renderCliHelp(_commands: CommandEntry[], scope?: string): string {
	if (scope) {
		if (GENERATED_MODE_HELP_SCOPES.has(scope)) {
			const generated = renderAgentModeHelp(scope);
			if (generated) return generated;
		}
		const section = SCOPED_HELP[scope];
		if (section) return section;
		return `Unknown help topic: "${scope}". Available: ${Object.keys(SCOPED_HELP).join(", ")}`;
	}
	return GLOBAL_HELP;
}

const GENERATED_MODE_HELP_SCOPES = new Set(["builder", "ui", "dsp", "script"]);

// ── Global help (overview only) ─────────────────────────────────────

const GLOBAL_HELP = `hise-cli — automation frontend for HISE audio plugin framework (connects to HISE at http://127.0.0.1:1900).

USAGE
  hise-cli                                  Open the interactive TUI
  hise-cli builder <command> [flags]         Builder module tree commands
  hise-cli ui <command> [flags]              UI component commands
  hise-cli dsp <command> [flags]             DSP network commands
  hise-cli run <file.hsc> [--dry-run]        Run a .hsc script file
  hise-cli --run <file.hsc> [--dry-run] [--verbosity=<level>]   Run a .hsc script file
  hise-cli --run --inline "<script>"        Run an inline script
  hise-cli --run - < script.hsc             Run script from stdin
  hise-cli -wizard <subcommand>             Wizard operations
  hise-cli diagnose <filepath>              Diagnose HiseScript file
  hise-cli agent-context [scope]            Emit structured CLI context for agents
  hise-cli which "<intent>"                  Find the command for an intent
  hise-cli mcp <tool-or-method>             Call the HISE MCP docs server
  hise-cli update [--check]                 Self-update to latest GitHub release
  hise-cli -version                         Print the CLI version
  hise-cli -status                          Print CLI + HISE status
  hise-cli --help                           Show this help
  hise-cli <topic> --help                   Show topic-specific help

OUTPUT FORMAT
  Default: pretty text. Markdown rendered as ANSI on a TTY, plain text
  when piped. ANSI is stripped on non-TTY output.

  --json   Emit structured JSON instead:
             { "ok": true|false, "result": ..., "logs": [...], "errors": [...] }
           Use this in scripts that parse output programmatically.

  --agent  Agent-safe output. Implies --json --compact and guarantees
           errors include a stable code:
             { "ok": false, "code": "hise_api_error", "error": "..." }

  --compact
           Compact the final CLI payload by removing empty logs/errors and
           similar wrapper noise. Output-only: does not alter mode behavior.

  --select <path>
           Extract a field from the final payload and keep the envelope:
             { "ok": true, "value": <selected> }
           Supports dot paths and array indexes, e.g. value.project.name or
           value.items[0].id. Implies JSON output.

  Exit codes:
    0 success
    1 generic execution error
    2 usage error or --select path not found
    3 HISE unavailable / transport error
    4 HISE API error
    5 validation error
    6 expectation failure

MODES
  builder <command>        Module tree editor       (--help for syntax)
  dsp <command>            Scriptnode graph editor  (--help for syntax)
  ui <command>             UI component editor      (--help for syntax)
  -script "<expression>"   HiseScript REPL          (--help for syntax)
  -inspect "<command>"     Runtime monitor           (--help for syntax)
  -undo "<command>"        Undo history navigation   (--help for syntax)
  -hise "<command>"        Runtime control            (--help for syntax)
  -publish "<command>"     Build & sign installers    (--help for syntax)
  -assets "<command>"      Install, manage, and publish asset packages (--help for syntax)
  -api "<query>"           HiseScript API doc browser (--help for syntax)
  -mcp "<tool> <args>"     HISE MCP docs bridge     (--help for syntax)

  -wizard <subcommand>     Guided workflows          (--help for syntax)

OPTIONS
  --help             Show this help or topic help
  --json             Emit structured JSON output instead of pretty text
  --agent            Emit compact JSON for tool/LLM callers
  --compact          Compact the final output payload only
  --select <path>    Select a payload field, preserving { ok, value }
  --dry-run          Validate builder/ui/dsp mutations inside a discarded
                     HISE undo plan without committing state changes`;

// ── Per-mode scoped help ────────────────────────────────────────────

const SCOPED_HELP: Record<string, string> = {
	script: renderAgentModeHelp("script") ?? "hise-cli script - HiseScript REPL and callback editing",

	"agent-context": `hise-cli agent-context — structured context for agents

SYNTAX
  hise-cli agent-context
  hise-cli agent-context <mode>
  hise-cli agent-context --command <id>
  hise-cli agent-context --list-commands
  hise-cli agent-context --pretty

DESCRIPTION
	Emits JSON describing agent-safe flags, error exit codes, and authored
	command recipes generated from docs/agent-context/*.yaml. This command
	does not require a running HISE instance.

	The default output is a compact manifest. Use a mode or command query for
	full details when needed.

EXAMPLES
  hise-cli agent-context --agent
  hise-cli agent-context script --agent
  hise-cli agent-context --command script.compile --agent
  hise-cli agent-context --list-commands --select value[0].id`,

	which: `hise-cli which — find commands by intent

SYNTAX
  hise-cli which "<intent>" [--limit N]
  hise-cli which [--limit N]

DESCRIPTION
  Searches the generated agent command index using deterministic local
  matching over titles, aliases, tags, purposes, and command tokens. It does
  not call an AI service and does not require a running HISE instance.

EXAMPLES
  hise-cli which "edit onInit from file" --agent
  hise-cli which "compile script" --limit 1 --agent
  hise-cli which "evaluate expression from stdin" --agent`,

	mcp: `hise-cli mcp — HISE MCP bridge

SYNTAX
  hise-cli mcp <tool-name> [--field value ...] [--agent]
  hise-cli mcp <tool-name> --args '<json>' [--agent]
  hise-cli mcp <tool-name> --args-file ./args.json [--agent]
  hise-cli mcp <tool-name> --args-stdin [--agent]

DESCRIPTION
  Calls the HISE documentation server using its stateless REST tool API. Tool
  names are sent to POST /api/tools/<tool-name>. The tools/list method is
  supported through GET /api/tools for discovery.

	  Default endpoint: HISE_DOCS_API_URL, HISE_MCP_URL, or http://localhost:4406.

OPTIONS
  --url <url>          Override the REST API base URL
  --timeout <seconds>  Request timeout (also accepts 500ms or 2s)
  --args <json>        Exact JSON arguments / params
  --args-file <path>   Read exact JSON arguments / params from a file
  --args-stdin         Read exact JSON arguments / params from stdin

FIELD FLAGS
  Any other --field value flag becomes an MCP argument. Kebab-case is converted
  to camelCase, so --api-call becomes apiCall. Repeated flags become arrays.

EXAMPLES
  hise-cli mcp search_hise --query "Content.addKnob" --domain api --limit 3 --agent
  hise-cli mcp explore_hise --query "create slider callback" --domain ui --source docs --timeout 180 --agent
  hise-cli mcp query_scripting_api --api-call ScriptSlider.setControlCallback --agent
  hise-cli mcp tools/list --agent

TUI MODE
  Type /mcp, then enter calls like:
    explore_hise sampler
    search_hise Content.addKnob
    query_module_parameter WaveSynth.Gain`,

	project: `hise-cli -project — project lifecycle (list, switch, save, settings, snippets)

SYNTAX
  hise-cli -project "<command>"

QUICK START
  hise-cli -project info                          name, projectFolder, scriptsFolder
  hise-cli -project show projects                 list known projects, mark active
  hise-cli -project show settings                 project settings table
  hise-cli -project show files                    saveable XML + HIP files
  hise-cli -project show preprocessors            preprocessor macros (all scopes)
  hise-cli -project describe Version              full description + options for one key
  hise-cli -project "switch TestSynth"            switch by name (resolved to path)
  hise-cli -project "switch /Users/foo/HISE Projects/X"  switch by absolute path
  hise-cli -project "switch ./"                   switch to current working directory
  hise-cli -project "switch ../sibling"           switch to a sibling folder relative to CWD
  hise-cli -project "save xml as MyPlugin_v2"     save XML preset (renames chain if differs)
  hise-cli -project "save hip"                    save HIP archive with default filename
  hise-cli -project "load MyPlugin"               resolve bare name (.xml > .hip)
  hise-cli -project "load MyPlugin.hip"            force the .hip variant
  hise-cli -project "load XmlPresetBackups/MyPlugin.xml"  exact relative path
  hise-cli -wizard run compile_networks            run network DLL compile with defaults
  hise-cli -wizard run plugin_export with Format=VST3   plugin export with override
  hise-cli -project "get Version"                 read a single setting value
  hise-cli -project "set Version 1.1.0"           update a project setting
  hise-cli -project "set VST3Support yes"         lenient bool norm (yes/no/on/off/1/0)
  hise-cli -project "set preprocessor ENABLE_FOO 1 on win for plugin"
  hise-cli -project "clear preprocessor ENABLE_FOO on Windows"
  hise-cli -project snippet export                emit full snippet to stdout

COMMANDS
  info                                          Project name + folder + scripts folder
  show projects                                 List available HISE projects
  show settings                                 List all settings (key, value, options)
  show files                                    Saveable XML + HIP files
  show preprocessors [for <target>] [on <os>]   Preprocessor macros grouped by scope
  show tree                                     File tree (referenced files highlighted)
  describe <key>                                Full description + options for one setting
  switch <name|path>                            Switch active project
                                                  Accepts: known project name,
                                                  absolute path, ./ or ../ path
                                                  resolved against CWD
  save xml [as <filename>]                      Save as XML preset
  save hip [as <filename>]                      Save as HIP archive
  load <name|relative-path>                     Load XML or HIP file
                                                  bare name resolves to .xml > .hip;
                                                  add .xml/.hip to override
  get <key>                                     Read a single setting value
  set <key> <value>                             Update a project setting
  set preprocessor <name> <value>               Upsert a preprocessor macro
                                                  ([on <os>] [for <target>])
  clear preprocessor <name>                     Remove a preprocessor override
                                                  ([on <os>] [for <target>])
  snippet export                                Export snippet (CLI: stdout)
  snippet load [<string>]                       Import snippet (omit arg → clipboard)
  (use 'hise-cli -wizard run new_project', '... compile_networks', '... plugin_export'
   for the equivalent guided workflows)

OS ALIASES
  Windows:  windows | win | Win | x64 | WIN
  macOS:    macos | mac | osx | macosx | apple | darwin
  Linux:    linux
  all:      all | * | any  (default when "on" clause is omitted)

TARGET ALIASES
  Project:  project | plugin
  Dll:      dll | DLL
  all:      all | * | any  (default when "for" clause is omitted)

PREPROCESSOR VALUES
  Integer:   "1", "0", "42"           macro is set to MACRO=N
  Default:   "default"                 clears the override (same as "clear preprocessor")

NOTES
  - switch resolves names client-side via /api/project/list, then sends the
    absolute path to /api/project/switch. Pass an absolute path to bypass.
  - save xml/hip with a custom filename renames the master chain when the
    filename differs from the current chain id.
  - When the snippet browser is active in HISE, /api/project/* returns 409;
    info will surface a hint when this is the case.`,

	inspect: `hise-cli -inspect — runtime monitor

SYNTAX
  hise-cli -inspect "<command>"

COMMANDS
  version    HISE server version and compile timeout
  project    Current project paths and script processors

EXAMPLES
  hise-cli -inspect "version"
  hise-cli -inspect "project"`,

	undo: `hise-cli -undo — undo history navigation

SYNTAX
  hise-cli -undo "<command>"

COMMANDS
  back             Undo last action
  forward          Redo last undone action
  clear            Clear undo history
  history          Show undo history

Plan groups are interactive TUI-only and are intentionally hidden from the
one-shot CLI surface. CLI automation should run direct commands or use .hsc
scripts for scripted workflows.

EXAMPLES
  hise-cli -undo "back"
  hise-cli -undo "forward"
  hise-cli -undo "history"`,

	wizard: `hise-cli -wizard — guided multi-step workflows

SYNTAX
  hise-cli -wizard list                                   List available wizards
  hise-cli -wizard get <id>                               Show merged default state
  hise-cli -wizard run <id>                               Execute with all defaults
  hise-cli -wizard run <id> with Key=Value, K2=V2         Execute with overrides

AVAILABLE WIZARDS
  setup                Install and build HISE from source
  update               Pull latest CI-green develop commit and rebuild HISE
  new_project          Create a new HISE project folder
  plugin_export        Compile project as VST/AU/AAX or standalone
  compile_networks     Compile scriptnode C++ networks into DLL
  recompile            Recompile scripts and clear caches
  audio_export         Render audio output to WAV file
  install_package_maker  Create installer payload for distribution

WORKFLOW
  1. Call 'get <id>' to see the merged default state (init handler runs if defined)
  2. Call 'run <id>' to execute with those defaults
  3. Add 'with Key=Value, ...' to override individual fields inline
     (quote values with embedded spaces or commas: Path="/some path/file")

EXAMPLES
  hise-cli -wizard list
  hise-cli -wizard get new_project
  hise-cli -wizard run compile_networks
  hise-cli -wizard run new_project with ProjectName=MyPlugin, Template=0
  hise-cli -wizard run plugin_export with Format=VST3, ExportType=Plugin`,

	run: `hise-cli --run — script runner & test framework

SYNTAX
  hise-cli --run <file.hsc>                      Execute a .hsc script file
  hise-cli --run --inline "<script>"             Execute an inline script string
  hise-cli --run - < script.hsc                  Execute script from stdin
  hise-cli --run <file.hsc> --dry-run            Validate only (no execution)
  hise-cli --run <file.hsc> --verbosity=<level>  Control output detail (default: summary)

VERBOSITY LEVELS
  verbose   Full per-command logs + /expect rows + PASSED N/N footer
  summary   (default) Only /expect rows + PASSED N/N footer per script
  quiet     Single ✓/✗ pass-fail line per script (footer only)

  Aliases: --verbose = --verbosity=verbose, --quiet = --verbosity=quiet

SCRIPT SOURCES
  File:   hise-cli --run test.hsc
  Inline: hise-cli --run --inline "/builder\nadd SineSynth\n/script\n/expect Engine.getSampleRate() is 44100"
  Stdin:  echo "/script" | hise-cli --run -
          hise-cli --run - <<'EOF'
          /builder
          add SineSynth
          EOF

  The --inline flag is designed for LLM tool use where the script is passed
  as a JSON string argument with literal \n newlines — no shell quoting issues.

PATH RESOLUTION
  Absolute path        Used as-is (e.g. /home/u/test.hsc, C:/proj/test.hsc)
  ./ or ../ prefix     Resolved against current working directory
  Bare relative path   Resolved against the HISE project folder
                       Requires HISE to be running with a project open

  Examples:
    hise-cli --run ./test.hsc          # ./test.hsc relative to shell CWD
    hise-cli --run Scripts/test.hsc    # <project>/Scripts/test.hsc
    hise-cli --run /tmp/test.hsc       # absolute, unchanged

  If HISE is not running and the path is bare-relative, --run aborts with
  an error rather than silently falling back to CWD.

.HSC SCRIPT FORMAT
  Each line is a command. Lines starting with # are comments.
  Empty lines are ignored. Leading whitespace is stripped (cosmetic only).
  Mode switches (/builder, /script, etc.) persist across lines.

  Shebang support: add #!/usr/bin/env hise-cli run as the first line
  to make .hsc files directly executable on Unix (chmod +x test.hsc).

TOOL COMMANDS (available in scripts and TUI)
  /wait <duration>                 Pause (e.g., /wait 500ms, /wait 0.5s)
  /expect <cmd> is <value>         Assert a command's return value
  /expect <cmd> matches <file>     Assert output equals a reference file (TUI/CLI)
  /expect <cmd> contains "<pat>"   Substring match on success result
  /expect <cmd> logs <json|scalar> Assert Console.print logs (script mode)
  /expect <cmd> throws "<pat>"     Assert command errors with a substring
  /capture                         Open Console.print buffer (script mode)
  /expect-logs <json>              Assert last log buffer (capture flush, /compile, or REPL)
  /expect-compile throws "<pat>"   Assert collected callbacks fail to compile
  /callback <name>                 In /script, collect raw callback body lines
  /compile                         In /script, compile collected callbacks
  /export                          Enter export mode (build targets)
    Float tolerance: default 0.01, customize with "within <tol>"
    Abort on failure: append "or abort"

LOG / ERROR ASSERTIONS (script mode only)
  Single-line:
    /expect Console.print(1234) logs 1234
    /expect Console.print("hi") logs "hi"
    /expect Console.print(0.5) logs 0.5 within 0.01

  Multi-line (buffer is wrapped in an IIFE — var scope preserved):
    /capture
    var x = 5;
    Console.print(x);
    Console.print(x * 2);
    /expect-logs ["5", "10"]

  After /compile (asserts logs from /api/set_script response):
    /callback onInit
    Console.print("init done");
    /compile
    /expect-logs ["init done"]

  Substring match on success result (any mode):
    /hise /expect status contains "HISE online"
    /expect get Master.Volume contains "-6"

  Error matching (substring on normalized error message):
    /expect undefinedFn() throws "not a function"
    /expect Console.assertEqual(1, 2) throws "Assertion failed"

  Compile-error matching (does NOT abort the script):
    /callback onInit
    var x = undefinedFn();
    /expect-compile throws "not a function"

  Log lines are normalized: leading "Interface: " / "Script Processor: " /
  "ScriptProcessor: " prefixes are stripped before compare. Per-line match
  is exact-string OR float-within-tolerance OR JSON-structural-equal.

ERROR HANDLING
  Parse phase:   Multi-recovery — all syntax errors reported together
  Runtime phase: Fail-fast — aborts on first error
  /expect:       Continues on failure (collects all results)
                 Unless "or abort" is specified

EXAMPLE SCRIPT (test.hsc)
  # Set up a module tree
  /builder
  add SineSynth as MySynth
  set MySynth.Volume -6

  # Verify parameter
  /expect get MySynth.Volume is -6

  # Test script evaluation
  /script
  /expect Engine.getSampleRate() is 44100 within 1

  # Compile callbacks
  /callback onInit
  Content.makeFrontInterface(600, 600);
  /callback onNoteOn
  Console.print(Message.getNoteNumber());
  /compile

OUTPUT FORMAT
  Default: human-readable run report. Use --json for structured payload:
    { "ok": true|false, "value": {
      "linesExecuted": 8,
      "expects": [
        { "line": 7, "command": "...", "expected": "...", "actual": "...", "passed": true }
      ],
      "error": null
    }}

SHEBANG (Unix)
  Make .hsc files directly executable:
    #!/usr/bin/env hise-cli run
    /script
    /expect Engine.getSampleRate() is 44100

  Then: chmod +x test.hsc && ./test.hsc

EXAMPLES
  hise-cli --run test.hsc                        # summary (default)
  hise-cli --run test.hsc --verbose              # full per-command logs
  hise-cli --run test.hsc --quiet                # single pass/fail line
  hise-cli --run Examples/sn.hsc --verbosity=summary
  hise-cli --run test.hsc --dry-run`,

	diagnose: `hise-cli diagnose — HiseScript shadow parser diagnostics

SYNTAX
  hise-cli diagnose <filepath> [--format=pretty|json] [--errors-only]

Runs the HISE shadow parser on a script file and returns diagnostics.
Accepts an absolute file path — the CLI resolves it to a project-relative
path automatically.

The file must be included in a ScriptProcessor and compiled at least once
for diagnostics to be available. If the file is in the scripts folder but
not yet included, a warning is returned.

OPTIONS
  --format=json      JSON output (default)
  --format=pretty    Human-readable file:line:col format on stderr
  --errors-only      Filter to error-severity diagnostics only

EXIT CODES
  0    No errors (or file not in project)
  1    Errors found (JSON mode) or connection failure
  2    Errors found (pretty mode) — Claude Code hook "block" signal

OUTPUT FORMAT (JSON, default)
  { "ok": false, "file": "/path/to/script.js", "diagnostics": [
    { "line": 6, "column": 15, "severity": "error",
      "source": "api-validation",
      "message": "Function / constant not found: Console.prins",
      "suggestions": ["print"] }
  ]}

OUTPUT FORMAT (pretty, --format=pretty)
  /path/to/script.js:6:15: error: Function / constant not found: Console.prins (did you mean: print?)

CLAUDE CODE HOOK
  Create ~/.claude/hise-lsp.sh:
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

  Add to ~/.claude/settings.json (global hook):
    { "hooks": { "PostToolUse": [{ "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
          "command": "bash ~/.claude/hise-lsp.sh" }] }] } }

EXAMPLES
  hise-cli diagnose /path/to/Scripts/ext.js
  hise-cli diagnose /path/to/Scripts/ext.js --format=pretty --errors-only
  hise-cli diagnose --help`,

	hise: `hise-cli -hise — HISE runtime control

SYNTAX
  hise-cli -hise "<command>"

COMMANDS
  launch [debug]                                   Start HISE and wait for connection
  shutdown                                         Gracefully quit HISE
  screenshot [of <id>] [at <scale>] [to <path>]    Capture interface screenshot
  profile [thread audio|ui|scripting] [for <N>ms]  Record performance profile
  playground open|close|enable|disable             Control the snippet browser

LAUNCH
  Finds HISE (or "HISE Debug") on PATH, spawns it, and polls /api/status
  until the server responds (10s timeout). Case-insensitive "debug" flag.

SCREENSHOT
  Captures the full interface or a specific component. Output path is
  resolved relative to the HISE project folder. Defaults to screenshot.png
  in the project root. Scale accepts both percentage (50%) and decimal (0.5).

PROFILE
  Records a performance profile for the given duration (default 1000ms),
  then displays a summary table sorted by peak duration. Thread names
  are case-insensitive: audio, ui, scripting (or script).

PLAYGROUND
  Drives a second HISE instance dedicated to browsing and auditioning
  snippets. While the snippet browser is active, runtime endpoints
  (list_components, repl, recompile, ...) target the snippet, not the
  main project. 'open' creates and switches to the snippet browser;
  'close' destroys it; 'enable'/'disable' switch between the two without
  destroying the snippet (errors if no snippet exists).

EXAMPLES
  hise-cli -hise "launch"
  hise-cli -hise "launch debug"
  hise-cli -hise "screenshot"
  hise-cli -hise "screenshot of Knob1 at 50% to images/knob.png"
  hise-cli -hise "profile thread audio for 2000ms"
  hise-cli -hise "playground open"
  hise-cli -hise "playground disable"
  hise-cli -hise "shutdown"`,

	sequence: `hise-cli -sequence — timed MIDI sequence composer

SYNTAX
  hise-cli -sequence "<command>"

COMMANDS (management)
  create "<name>"               Start defining a named sequence
  flush                         End sequence definition
  show "<name>"                 Show sequence details
  play "<name>"                 Execute sequence (blocking)
  record "<name>" as <path>     Record output to WAV
  stop                          Send all-notes-off
  get <id>                      Retrieve eval result from last playback

EVENT LINES (during define phase)
  <time> play <note> [<vel>] [for <dur>]           MIDI note
  <time> play <signal> [at <freq>] [for <dur>]     Test signal
  <time> play sweep from <start> to <end> for <dur> Frequency sweep
  <time> send CC <ctrl> <val>                       CC message
  <time> send pitchbend <val>                       Pitchbend
  <time> set <Proc.Param> <val>                     Module attribute
  <time> eval <expr> as <id>                        Script eval

UNITS
  Durations:   500ms, 1.2s, 2s
  Frequencies: 440Hz, 1kHz, 20kHz
  Notes:       C3 (=60), C#4, Db3, or raw MIDI 0-127
  Velocity:    0-127 (auto-normalized) or 0.0-1.0
  Signals:     sine, saw, sweep, dirac, noise, silence

EXAMPLES
  hise-cli -sequence "create test"
  hise-cli -sequence "0ms play C3 127 for 500ms"
  hise-cli -sequence "flush"
  hise-cli -sequence "play test"`,

	publish: `hise-cli -publish — build & sign plugin installers

SYNTAX
  hise-cli -publish "<command>"

VERBS
  check system               Run preflight (admin, project_info.xml,
                             discovered binaries, ISCC/pkgbuild,
                             optional certs).
  check binaries <list>      Assert >=1 binary present per CSV target
                             (VST3,AU,AAX,Standalone). Compares versions
                             with project_info.xml.
  build [with K=V, ...]      Run build_installer wizard headlessly with
                             the given prefilled answers.

EXAMPLES
  hise-cli -publish "check system"
  hise-cli -publish "check binaries VST3,AU"
  hise-cli -publish "build with codesign=1, notarize=1"

EQUIVALENT WIZARD
  /wizard build_installer    Same wizard, opens the form-based UI.

RELATED
  /project export project --default     Produces the binaries that /publish
                                        then packages.

NOTES
  - On Windows, AAX signing uses a self-signed PACE keyfile auto-generated
    on first sign (separate from any Authenticode code-signing cert).
  - On macOS, the developer's Developer ID Application identity is used
    for both binary signing and AAX wraptool --signid.
  - HISE_AAX_PASSWORD env var is required when AAX is in the payload.`,

	api: `hise-cli -api — HiseScript API doc browser

SYNTAX
  hise-cli -api "<Class>"
  hise-cli -api "<Class>.<method>()"

Renders HiseScript API docs as markdown. ANSI on a TTY, raw markdown
when piped. Use --json for the structured payload.
Static — no HISE connection required.

QUERIES
  <Class>             Class description + method index
  <Class>.<method>    Method signature, description, parameters, code examples
                      Trailing () is optional.

EXAMPLES
  hise-cli -api "Console"
  hise-cli -api "Console.print()"
  hise-cli -api "Engine.getSampleRate"
  hise-cli -api "Console" --json

OUTPUT
  Default: rendered markdown text. With --json, markdown source is
  returned in the "result.content" field of the structured payload.`,

	assets: `hise-cli -assets — install, manage, and publish asset packages

SYNTAX
  hise-cli -assets "<command>"

VERBS
  list [installed|uninstalled|local|store]   Show packages by category.
  info <name>                                Show details for a package.
  install <name> [version=X.Y.Z] [--dry-run]
                                             Install or update a package.
                                             Looks in your asset library
                                             first, then the HISE store.
  uninstall <name>                           Remove an installed package.
                                             Files you've modified are kept
                                             and flagged for cleanup.
  cleanup <name>                             Finish a previous uninstall by
                                             deleting the files you'd modified.
  local add <path>                           Add a HISE project to your asset
                                             library so you can install it
                                             into other projects.
  local remove <name|path>                   Remove an entry from your asset
                                             library.
  login token=<t>                            Sign in to the HISE store.
  logout                                     Sign out.
  create                                     Open the package-author wizard
                                             for the current project.
  help                                       Show available commands.

EXAMPLES
  hise-cli -assets "list installed"
  hise-cli -assets "info synth_building_blocks"
  hise-cli -assets "install synth_building_blocks version=1.2.0 --dry-run"
  hise-cli -assets "uninstall synth_building_blocks"
  hise-cli -assets "cleanup synth_building_blocks"
  hise-cli -assets "local add /path/to/MyLib"
  hise-cli -assets "login token=abc123"
  hise-cli -assets "create"

NOTES
  - "install <name>" looks in your asset library first, then the HISE store.
  - --dry-run previews the changes without writing anything.
  - If you've modified files installed by a package, uninstall keeps them and
    flags the package for cleanup. Run "cleanup <name>" when you're ready to
    delete them too.
  - Sign in once with "login token=<t>". The HISE_STORE_TOKEN env var
    can also be used to override the saved sign-in for a single command.
  - HISE must be running — the asset commands talk to your live project for
    settings and preprocessor changes.`,
};
