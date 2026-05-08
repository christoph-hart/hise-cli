// ── Help content — mode-specific help text ──────────────────────────

// Generates structured help content for the /help command.
// Content varies based on the current mode.

import type { ModeId } from "../modes/mode.js";
import type { CommandEntry } from "./registry.js";

// ── Help content generation ─────────────────────────────────────────

export interface HelpContent {
	title: string;
	content: string;  // markdown formatted
}

/** Generate help content for the current mode and available commands. */
export function generateHelp(
	modeId: ModeId,
	commands: CommandEntry[],
): HelpContent {
	const sections: string[] = [];

	// Mode-specific header
	const modeHelp = MODE_HELP[modeId];
	if (modeHelp) {
		sections.push(modeHelp);
		sections.push("");
	}

	if(modeId == "root")
	{
		// Slash commands section
		sections.push("## Commands");
		sections.push("");
		sections.push("| Command | Description |");
		sections.push("|---------|-------------|");
		for (const cmd of commands) {
			const name = `**/${cmd.name}**`;
			sections.push(`| ${name} | ${cmd.description} |`);
		}
		sections.push("");

		// Navigation hints
		sections.push("## Navigation");
		sections.push("");
		sections.push("- **Tab**: ....... Complete command or argument");
		sections.push("- **Ctrl+B**: .... Show / hide tree sidebar");
		sections.push("- **Escape**: .... Open / close the autocomplete list");
		sections.push("- **Up/Down**: ... Command history");
		sections.push("- **PgUp/PgDn**: . Scroll output");
		sections.push("- **Shift+Up/Dn**: Scroll one line");
	}

	return {
		title: `Help — ${modeId === "root" ? "HISE CLI" : modeId}`,
		content: sections.join("\n"),
	};
}

// ── Per-mode help text (markdown format) ───────────────────────────

const MODE_HELP: Partial<Record<ModeId, string>> = {
	root: `# HISE CLI

Interactive shell for the HISE audio plugin framework.
Enter a mode to start working, or use /wizard for guided workflows.

- **/builder** — Module tree editor (add, remove, configure modules)
- **/ui** — UI component editor (add, remove, set properties, reparent)
- **/script** — HiseScript REPL (evaluate expressions live)
- **/inspect** — Runtime monitor (version, project info)
- **/api** — HiseScript API doc browser (\`/api Console\`, \`/api Console.print()\`)
- **/assets** — Install, manage, and publish HISE asset packages
- **/export** — Build targets and export settings
- **/undo** — Undo history and plan groups
- **/hise** — Runtime control (launch, shutdown, screenshot, profile, playground)
- **/wizard** — Guided workflows (setup, export, project creation)
- **/setup** — Install and build HISE from source (wizard alias)
- **/update** — Pull latest CI-green develop commit and rebuild HISE (wizard alias)
- **/resume** — Resume the most recently paused wizard from the failed task

One-shot syntax: \`/builder add SimpleGain\` executes without entering the mode.
Dot-context: \`/builder.Master add LFO\` sets the context path first.

## Script Runner & Testing

- **/run** \`<file.hsc>\` — Execute a .hsc script (multiline recipes & tests)
- **/parse** \`<file.hsc>\` — Validate a script without executing (dry run)
- **/wait** \`<duration>\` — Pause execution (e.g., \`/wait 500ms\`, \`/wait 0.5s\`)
- **/expect** \`<cmd> is|matches|logs|throws|contains <value>\` — Assert a command result
- **/capture** — In script mode, open a Console.print buffer (end with \`/expect-logs\`)
- **/expect-logs** \`<json>\` — Assert last log buffer (filled by \`/capture\` flush, \`/compile\`, or REPL)
- **/expect-compile** \`throws "<pattern>"\` — Assert callback compile fails with a substring
- **/callback** \`<name>\` — In script mode, collect raw callback body lines for compilation
- **/compile** — In script mode, compile collected callbacks with \`/api/set_script\`
  - \`/expect getValue() is 0.5 within 0.001\` — custom tolerance
  - \`/expect isDefined(Knob1) is 1 or abort\` — abort script on failure
  - \`/expect Console.print(1234) logs 1234\` — single-line log assertion
  - \`/expect undefinedFn() throws "not a function"\` — error substring match
  - \`/expect status contains "HISE online"\` — substring match on success result`,

	script: `# Script Mode

HiseScript REPL — evaluate expressions live against the running HISE instance.

## Usage

Type any HiseScript expression to evaluate it. Results show the return value,
type, and any console output.

\`\`\`hisescript
Engine.getSampleRate()
Synth.addNoteOn(1, 64, 127, 0)
Console.print("hello")
Content.getComponent("Knob1").getValue()
\`\`\`

## Completion

**Tab** completes API namespaces and methods. Type \`Namespace.\` to browse:

- \`Engine.\` — global engine functions (sample rate, latency, etc.)
- \`Synth.\` — sound generator control (note on/off, modulators)
- \`Console.\` — debug output
- \`Content.\` — UI component access
- \`Math.\`, \`Array.\`, \`String.\` — utility classes

## Callback Compiler

- \`/callback onInit\` — start collecting raw \`onInit\` body lines
- \`/callback onNoteOn\` — start collecting a callback body, then wrap it on compile
- \`/compile\` — send collected callbacks to \`/api/set_script\` with \`compile: true\`
- entering or exiting script mode clears all pending callback buffers

## Test Verbs (script mode)

- \`/capture\` — open a Console.print buffer; following lines silently buffer
- \`/expect-logs <json>\` — assert the last log buffer:
  - after \`/capture\`: flushes buffered code via IIFE, asserts the response logs
  - after \`/compile\`: asserts logs returned from \`/api/set_script\`
  - after a REPL line: asserts that line's Console output
  - buffer is cleared after the assert
- \`/expect-compile throws "<pat>"\` — assert collected callbacks fail to compile
- \`/expect <expr> logs <json|scalar>\` — inline log assertion (one-liner shortcut)
- \`/expect <expr> throws "<pat>"\` — substring match on error
- All verbs accept \`or abort\` and (where meaningful) \`within <tol>\``,

	builder: `# Builder Mode

Module tree editor — add, configure, and inspect the HISE module tree.

## Commands

| Command | Description |
|---------|-------------|
| \`add <type> as "<name>" [to <parent>[.<chain>]]\` | Add a module (alias mandatory) |
| \`remove <target> [, <target>...]\` | Remove modules |
| \`clone <target> <count>\` | Duplicate a module N times |
| \`rename <target> as "<name>"\` | Rename a module |
| \`set <target>.<param> <value>\` | Set a parameter or property |
| \`set <target>.bypassed <bool>\` | Toggle bypass via property write |
| \`set <target>.routing <value>\` | Routing matrix (array, send subfield, or preset) |
| \`set <target>.network "<name>[.xml]"\` | Init DSP network on the module |
| \`set <target>.parent <path>\` | Reparent (stub — pending HISE C++) |
| \`set <target>.index <n>\` | Reorder (stub — pending HISE C++) |
| \`get <target>.<param> [, ...]\` | Read a parameter value |
| \`show <target>\` | Show a module instance with live values |
| \`list types [<filter>]\` | List module types (substring filter on id/type/subtype) |
| \`list tree\` | Display the full module tree |
| \`reset\` | Wipe the module tree and clear undo history |
| \`cd <path>\` / \`ls\` / \`pwd\` | Navigate the module tree |

## Values

- **Numbers**: \`-6\`, \`0.5\`, \`50%\` (percent → 0.5), \`0xAARRGGBB\` (strict 8-digit hex)
- **Booleans**: \`true\` / \`false\`
- **Arrays**: \`[0, 1, -1, -1]\` for routing matrices
- **Routing presets**: \`"stereo"\`, \`"stereo_2"\`, \`"stereo_3"\`, \`"all"\`, \`"all_to_stereo"\`

## Features

- **Comma chaining**: \`set Lead.Volume -6, Lead.Pan 10\` (every clause gives its full path)
- **Chain auto-resolution**: SoundGenerators→children, Effects→fx, Midi→midi
- **Tab completion**: module types, instance IDs, parameter names, value enums
- **Tree sidebar**: Ctrl+B to toggle visual module tree`,

	inspect: `# Inspect Mode

Runtime monitor — query the live HISE status payload.

## Commands

| Command | Description |
|---------|-------------|
| \`version\` | HISE server version and compile timeout |
| \`project\` | Current project paths and script processors |
| \`help\` | Show available commands |`,

	assets: `# Assets Mode

Install and manage HISE asset packages — the same kind of packages you'd find
in the HISE store. You can also publish your current project as a package
that other HISE users can install.

## Commands

| Command | Description |
|---------|-------------|
| \`list [installed\\|uninstalled\\|local\\|store]\` | Show packages by category |
| \`info <name>\` | Show details for a package |
| \`install <name> [version=X.Y.Z] [--dry-run]\` | Install or update |
| \`uninstall <name>\` | Remove an installed package |
| \`cleanup <name>\` | Finish a previous uninstall (delete files you'd modified) |
| \`local add <path>\` | Add a HISE project to your asset library |
| \`local remove <name\\|path>\` | Remove an entry from your asset library |
| \`login token=<t>\` | Sign in to the HISE store |
| \`logout\` | Sign out |
| \`create\` | Open the package-author wizard for the current project |

## Notes

- \`install <name>\` looks in your asset library first, then the HISE store.
- \`--dry-run\` previews the changes without writing anything.
- If you've modified files installed by a package, uninstall keeps them and
  flags the package for cleanup. Run \`cleanup <name>\` to delete them later.
- HISE must be running — your project's settings and preprocessors are read
  and written live.`,

	undo: `# Undo Mode

Undo history and plan groups — batch and revert module tree changes.

## Commands

| Command | Description |
|---------|-------------|
| \`back\` | Undo the last action |
| \`forward\` | Redo the last undone action |
| \`clear\` | Clear the undo history |
| \`plan "<name>"\` | Start a named plan group (batches operations) |
| \`apply\` | Apply the current plan group |
| \`discard\` | Discard the current plan group |
| \`diff\` | Show diff of the current plan group |
| \`history\` | Show the full undo history |

## Plan Groups

Plan groups batch multiple builder operations into a single undoable unit.
Start a plan with \`plan "My Changes"\`, execute builder commands, then
\`apply\` to commit or \`discard\` to revert all at once.`,

	dsp: `# DSP Mode

Scriptnode graph editor. Connect and configure nodes inside a \`DspNetwork\`.
The mode's context is a **moduleId** — the script processor hosting the
network. Each host has at most one active network.

## Entering

- \`/dsp <moduleId>\` — enter with a host pre-selected (\`/dsp "Script FX1"\`)
- \`/dsp\` — enter without a host. Selecting a host happens from builder.

## Network lifecycle

Networks are now provisioned from **builder mode**:

\`\`\`
/builder
set "Script FX1".network "my_dsp"          # mode: create — fails if my_dsp.xml exists
set "Script FX1".network "my_dsp.xml"      # mode: load   — fails if missing
\`\`\`

Once a network is loaded on a host, enter DSP mode against that host:

| Command | Description |
|---------|-------------|
| \`list networks\` | List \`.xml\` files in the project's \`DspNetworks/\` |
| \`list modules\` | List \`DspNetwork\`-capable script processors |
| \`show <nodeId>\` | Header, properties, parameters (with range/default), modulation edges |
| \`save\` | Save the loaded network to its \`.xml\` file |
| \`reset\` | Empty the loaded network (no nodes, no connections) |

## Graph editing

| Command | Description |
|---------|-------------|
| \`add <factory>.<node> as "<id>" [to <parent>]\` | Add a node (alias required, defaults to CWD) |
| \`remove <nodeId> [, ...]\` | Remove nodes |
| \`rename <target> as "<name>"\` | Rename a node |
| \`connect <src>[.<output>] to <target>.<param> [matched]\` | Connect modulation |
| \`disconnect <node>.<param> [, ...]\` | Disconnect modulation (target-only) |
| \`set <node>.<param> <value>\` | Set a parameter |
| \`set <node>.<param>.<field> <number>\` | Range sub-field write (stepSize, middlePosition, skewFactor, default) |
| \`set <node>.bypassed <bool>\` | Toggle bypass via property write |
| \`set <node>.parent <path>\` / \`set <node>.index <n>\` | Reparent / reorder (move op) |
| \`set <root>.<NetworkProp> <value>\` | Network-level property write (root only) |
| \`create_parameter <container>.<name> [<min>, <max>] [default N] [stepSize N] [middlePosition N | skewFactor N]\` | Dynamic parameter on a container |
| \`screenshot scale <s> file "<path>"\` | Render the DspNetwork graph to a PNG |

## Property IDs

Long-form HISE property IDs are canonical:

- **stepSize** (range step), **middlePosition** (skew anchor), **skewFactor**
- **default** (default value), **matched** (post-connect range copy on \`connect\`)
- Network-root: \`AllowCompilation\`, \`AllowPolyphonic\`, \`HasTail\`,
  \`SuspendOnSilence\`, \`CompileChannelAmount\`, \`ModulationBlockSize\`

## Screenshot

\`screenshot scale 50% file "patch.png"\`. Path resolves relative to the
project's \`Images/\` folder (or absolute) and must end in \`.png\`. Scale
accepts percentage (\`50%\`) or decimal (\`0.5\`); valid values are \`0.5\`,
\`1.0\`, \`2.0\`. Requires the HISE IDE UI to be open (returns 503 otherwise).

## Local queries

| Command | Returns |
|---------|---------|
| \`get <nodeId>\` | Factory path of the node |
| \`get <node>.<param>\` | Current parameter value |
| \`get <node>.<param>.source\` | Connected source id, or \`(not connected)\` |
| \`get <node>.<param>.parent\` | Id of the parent container |

## Navigation

\`cd <container>\` to step into a container, \`cd ..\` / \`cd /\` to step out.
\`ls\` lists children at the current path. \`add\` defaults its parent to the
current path.

## Grammar notes

- Factory paths use \`factory.node\` dot notation (\`core.oscillator\`,
  \`filters.svf\`).
- \`sourceOutput\` can be defaulted (\`connect lfo1 to F.Freq\`) or explicit
  (\`connect env1.Value to F.Cutoff\`).
- Comma chaining: every clause provides full args. \`set A.Freq 440, B.Freq 880\`.`,

	sampler: `# Sampler Mode

Sample map editor.

*(Not yet implemented — Phase 6)*`,

	project: `# Project Mode

Project lifecycle — list, switch, save/load, settings, preprocessor defines,
file tree, and HISE snippet I/O.

## Commands

| Command | Description |
|---------|-------------|
| \`info\` | Project name + folder + scripts folder |
| \`show projects\` | Available HISE projects (active marked) |
| \`show settings\` | Project settings table (use \`describe\` for details) |
| \`show files\` | XML + HIP files saved under the project root |
| \`show preprocessors [for <target>] [on <os>]\` | Macros grouped by scope |
| \`show tree\` | Project file tree (referenced files highlighted) |
| \`describe <key>\` | Full description + options for one setting |
| \`switch <name\\|path\\|./...>\` | Switch active project (./ or ../ resolves against CWD) |
| \`save xml [as <filename>]\` | Save state as XML preset |
| \`save hip [as <filename>]\` | Save state as HIP archive |
| \`load <name\\|relative-path>\` | Load XML or HIP file (bare name resolves to .xml > .hip) |
| \`get <key>\` | Read a single setting value |
| \`set <key> <value>\` | Update a project setting (lenient bool norm) |
| \`set preprocessor <name> <value> [on <os>] [for <target>]\` | Upsert a macro |
| \`clear preprocessor <name> [on <os>] [for <target>]\` | Remove a macro override |
| \`snippet export\` | Export snippet to clipboard |
| \`snippet load [<string>]\` | Import a snippet (clipboard if empty) |
| \`create\` | Alias for \`/wizard new_project\` |
| \`export dll\` | Alias for \`/wizard compile_networks\` |
| \`export project\` | Alias for \`/wizard plugin_export\` |

## Notes

- \`switch <name>\` resolves names against \`/api/project/list\` then sends the
  resolved absolute path. Pass an absolute path to bypass resolution.
- \`save xml as Foo\` and \`save hip as Foo\` will rename the master chain when
  the filename differs from the current chain id (HISE behaviour).
- Preprocessor OS aliases: windows/win/x64, macos/mac/osx/macosx/apple/darwin,
  linux. Target aliases: project/plugin, dll, all/*. iOS is not supported.
- Snippets are memory-first: \`snippet export\` copies to clipboard and renders
  the first 50 chars as a preview. \`snippet load\` accepts an inline string or
  reads from the clipboard if no argument is given.`,

	compile: `# Export Mode

Build targets and export settings.

*(Not yet implemented — Phase 6)*`,

	ui: `# UI Mode

UI component editor — add, remove, configure, reparent, and reorder
interface components.

## Commands

| Command | Description |
|---------|-------------|
| \`add <type> as "<name>" [to <parent>]\` | Add a component (alias mandatory) |
| \`remove <target> [, ...]\` | Remove components |
| \`set <target>.<prop> <value>\` | Set a property |
| \`set <target>.bounds [x, y, w, h]\` | Position + size as Array4 |
| \`set <target>.position [x, y]\` / \`set <target>.size [w, h]\` | Array2 forms |
| \`set <target>.value <v>\` | Component value (\`/api/set_component_value\`) |
| \`set <target>.parent <path>\` | Reparent (real \`move\` op) |
| \`set <target>.index <n>\` | Reorder within current parent |
| \`set <target>.bypassed <bool>\` / \`set <target>.visible <bool>\` | Property toggles |
| \`get <target>.<prop> [, ...]\` | Read a property value |
| \`rename <target> as "<name>"\` | Rename a component |
| \`show <target>\` | Show all properties with current values |
| \`list tree\` | Display the full component tree |
| \`reset\` | Reset the component tree |
| \`cd <path>\` / \`ls\` / \`pwd\` | Navigate the component tree |

## Component Types

ScriptButton, ScriptSlider, ScriptPanel, ScriptComboBox, ScriptLabel,
ScriptImage, ScriptTable, ScriptSliderPack, ScriptAudioWaveform,
ScriptFloatingTile, ScriptDynamicContainer, ScriptedViewport,
ScriptMultipageDialog, ScriptWebView

## Features

- **Comma chaining**: \`add ScriptButton as "A", add ScriptSlider as "B"\`
  (full clause per comma — verb inheritance is gone)
- **Tab completion**: component types, IDs, property names
- **Tree sidebar**: shows component hierarchy, dims invisible components, ★ for saveInPreset`,

	sequence: `# Sequence Mode

Compose and execute timed MIDI sequences via HISE's inject_midi endpoint.

## Defining a Sequence

| Command | Description |
|---------|-------------|
| \`create "<name>"\` | Start defining a named sequence |
| \`<time> play <note> [<vel>] [for <dur>]\` | Schedule a MIDI note |
| \`<time> play <signal> [at <freq>] [for <dur>]\` | Schedule a test signal |
| \`<time> play sweep from <start> to <end> for <dur>\` | Schedule a sweep |
| \`<time> send CC <ctrl> <val>\` | Schedule a CC message |
| \`<time> send pitchbend <val>\` | Schedule a pitchbend |
| \`<time> set <Proc.Param> <val>\` | Schedule an attribute change |
| \`<time> eval <expr> as <id>\` | Schedule a script eval |
| \`flush\` | End the sequence definition |

## Managing Sequences

| Command | Description |
|---------|-------------|
| \`show "<name>"\` | Show sequence details |
| \`play "<name>"\` | Execute a sequence (blocking) |
| \`record "<name>" as <path>\` | Record output to WAV |
| \`stop\` | Send all-notes-off |
| \`get <id>\` | Retrieve eval result from last playback |

## Timestamps & Units

- Durations: \`500ms\`, \`1.2s\`, \`2s\`
- Frequencies: \`440Hz\`, \`1kHz\`, \`20kHz\`
- Notes: \`C3\` (=60), \`C#4\`, \`Db3\`, or raw MIDI numbers
- Velocity: 0-127 (auto-normalized to 0.0-1.0)
- Signals: sine, saw, sweep, dirac, noise, silence`,

	api: `# API Mode

HiseScript API doc browser — render class and method documentation as
markdown. Static; no HISE connection needed.

## Commands

| Command | Description |
|---------|-------------|
| \`<Class>\` | Show class description and method index |
| \`<Class>.<method>()\` | Show method signature, description, parameters, examples |
| \`help\` | Show the class index |

## Examples

- \`Console\` — class-level docs for the \`Console\` namespace
- \`Console.print()\` — full doc for \`Console.print\`, with code examples
- \`Engine.getSampleRate\` — trailing \`()\` is optional

## Completion

**Tab** completes class names; after the dot, completes method names.`,

	hise: `# HISE Control Mode

Runtime control — launch, shut down, screenshot, and profile HISE.

## Commands

| Command | Description |
|---------|-------------|
| \`launch [debug]\` | Start HISE and wait for connection (10s timeout) |
| \`shutdown\` | Gracefully quit HISE |
| \`screenshot [of <id>] [at <scale>] [to <path>]\` | Capture interface screenshot |
| \`profile [thread audio\\|ui\\|scripting] [for <N>ms]\` | Record and display performance profile |

## Screenshot Examples

- \`screenshot\` — full interface to \`screenshot.png\` in project root
- \`screenshot of Knob1\` — single component
- \`screenshot at 50%\` — half scale (also accepts \`at 0.5\`)
- \`screenshot of Panel to images/ui.png\` — component to specific path

## Profile Examples

- \`profile\` — all threads, 1000ms
- \`profile thread audio for 2000ms\` — audio thread only, 2 seconds
- \`profile thread scripting\` — scripting thread, default duration`,
};
