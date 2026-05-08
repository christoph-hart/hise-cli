import type { CommandEntry } from "../engine/commands/registry.js";

export function renderCliHelp(_commands: CommandEntry[], scope?: string): string {
	if (scope) {
		const section = SCOPED_HELP[scope];
		if (section) return section;
		return `Unknown help topic: "${scope}". Available: ${Object.keys(SCOPED_HELP).join(", ")}`;
	}
	return GLOBAL_HELP;
}

// ── Global help (overview only) ─────────────────────────────────────

const GLOBAL_HELP = `hise-cli — automation frontend for HISE audio plugin framework (connects to HISE at http://127.0.0.1:1900).

USAGE
  hise-cli                                  Open the interactive TUI
  hise-cli -<mode> "<command>"              One-shot mode command
  hise-cli --run <file.hsc> [--dry-run] [--verbosity=<level>]   Run a .hsc script file
  hise-cli --run --inline "<script>"        Run an inline script
  hise-cli --run - < script.hsc             Run script from stdin
  hise-cli -wizard <subcommand>             Wizard operations
  hise-cli diagnose <filepath>              Diagnose HiseScript file
  hise-cli update [--check]                 Self-update to latest GitHub release
  hise-cli -version                         Print the CLI version
  hise-cli -status                          Print CLI + HISE status
  hise-cli --help                           Show this help
  hise-cli -<mode> --help                   Show mode-specific help

OUTPUT FORMAT
  Default: pretty text. Markdown rendered as ANSI on a TTY, plain text
  when piped. ANSI is stripped on non-TTY output.

  --json   Emit structured JSON instead:
             { "ok": true|false, "result": ..., "logs": [...], "errors": [...] }
           Use this in scripts that parse output programmatically.

  Exit code: 0 on success, 1 on error.

MODES
  -builder "<command>"     Module tree editor       (--help for syntax)
  -dsp "<command>"         Scriptnode graph editor  (--help for syntax)
  -ui "<command>"          UI component editor      (--help for syntax)
  -script "<expression>"   HiseScript REPL          (--help for syntax)
  -inspect "<command>"     Runtime monitor           (--help for syntax)
  -undo "<command>"        Undo history & plan groups (--help for syntax)
  -hise "<command>"        Runtime control            (--help for syntax)
  -publish "<command>"     Build & sign installers    (--help for syntax)
  -assets "<command>"      Install, manage, and publish asset packages (--help for syntax)
  -api "<query>"           HiseScript API doc browser (--help for syntax)

  -wizard <subcommand>     Guided workflows          (--help for syntax)

OPTIONS
  --help             Show this help (or mode help with -<mode> --help)
  --json             Emit structured JSON output instead of pretty text
  --target:<path>    Set context path for mode commands`;

// ── Per-mode scoped help ────────────────────────────────────────────

const SCOPED_HELP: Record<string, string> = {
	builder: `hise-cli -builder — module tree editor

SYNTAX
  hise-cli -builder "<command>"
  hise-cli -builder --target:<path> "<command>"

QUICK START
  hise-cli -builder "list tree"                       inspect current modules
  hise-cli -builder "add SimpleGain as \"Drive\""        add at root (auto-picked chain)
  hise-cli -builder "add LFO as \"Shape\" to MyGain"     add under an existing module
  hise-cli -builder "list types script"               filter types by substring

  Notes:
    - "as <name>" is mandatory on add — every module gets an explicit alias.
    - Without "to", add lands at the current cd context (root by default).
    - Chain (.fx/.gain/...) is auto-resolved from the module's category;
      only Modulators require explicit chain (e.g. "to Master.gain").

MODULE TREE CONCEPTS
  HISE organises audio processing as a tree of modules. Every project has
  a root SoundGenerator (typically "Master Chain") with child modules
  nested inside typed slots called chains:

    children   Sound generators and containers (the main signal path)
    fx         Effect processors (filters, reverbs, delays)
    midi       MIDI processors (arpeggiators, scripts, transposes)
    gain       Gain modulators (LFOs, envelopes on volume)
    pitch      Pitch modulators (vibrato, glide)

  Each module type can only be added to a compatible chain. The builder
  validates this locally using constrainer rules from the module database.

GRAMMAR
  - Paths: bare ID (looked up project-wide) or dotted "A.B.C".
  - Quoted segments preserve names with spaces or reserved words:
    "Master Chain", "Script FX1".
  - Numeric values: int/float (-6, 0.5), percent (50% → 0.5), strict 8-digit
    hex (0xAARRGGBB). Shorter hex forms are parse errors.
  - Booleans: true / false.
  - Arrays: [0, 1, -1, -1] for routing matrices.
  - Comma chaining: every clause provides its full path. Verb inheritance
    is gone. "set Lead.Volume -6, Lead.Pan 10" — note the repeated target.

COMMANDS
  add <type> as "<name>" [to <parent>[.<chain>]]
    Add a module. "as <name>" is mandatory.
    Chain is auto-resolved from the module category:
      SoundGenerator types  → parent.children
      Effect types          → parent.fx
      MidiProcessor types   → parent.midi
      Modulator types       → requires explicit .chain (e.g. .gain, .pitch)
    Modules are appended to the end of the chain. Reordering is not
    supported via builder yet (set X.index is a stub — see PROPERTY WRITES).
    Name collisions are auto-suffixed (e.g. "LFO", "LFO2", "LFO3").
    Chained add disallows "to" — every clause lands at the cwd:
      "add SineSynth as \"L\", add SineSynth as \"R\""

  remove <target> [, <target>...]
    Remove modules and all their children. Chained — every clause is a
    full path.

  clone <target> <count>
    Duplicate a module (with children and parameters) <count> times.
    Plain integer count (no x-prefix). "clone Lead 3" creates 3 copies.

  rename <target> as "<name>"
    Change a module's display name. Note: "as", not "to".

  set <target>.<param> <value>
    Set a parameter or property. <target> is the module instance name
    (resolved project-wide). <param> is the parameter or property tail.
    No "to" preposition — value follows the path directly.

  set <target>.bypassed <bool>
    Property write — toggles bypass via /api/builder/apply set_bypassed.

  set <target>.routing <value>
    Routing matrix surface (/api/builder/apply set_routing). <value> is
    one of:
      - integer array: [0, 1, -1, -1] (length must match module's source
        channel count; each entry is a destination channel index or -1)
      - preset string: "stereo", "stereo_2", "stereo_3", "all", "all_to_stereo"

  set <target>.routing.send <array>
    Send-channel matrix (set_routing with "send" body field).

  set <target>.network "<name>"
    Initialize a DspNetwork on a script-network host (ScriptFX, ScriptSynth,
    ScriptModulator). Maps to POST /api/dsp/init:
      - bare name      → mode=create — fails if <name>.xml already exists
      - "<name>.xml"   → mode=load   — fails if <name>.xml is missing
    Use the .xml form when you want to attach an existing network without
    accidentally overwriting it.

  set <target>.parent <path>
    Reparent a module — emits {op:"move", target, parent, chain?} on
    /api/builder/apply. <path> is a module ID, dotted path (Master.fx),
    or quoted string. Chain index is auto-resolved from the path tail.

  set <target>.index <n>
    Reorder within the current parent — emits {op:"move", target, index}.
    HISE keeps the existing parent/chain when only index is specified.

  set <target>.<assetField> "<value>"
    samplemap, effect — string asset references applied via set_attributes.

  get <target>.<param> [, ...]
    Read a parameter or property value. Chainable.

  show <target>
    Show one module instance with parameters, current values, ranges,
    bypass state, and routing.

  list types [<filter>]
    List all available module types. Optional filter is a case-insensitive
    substring match against the Module ID, Type, and Subtype columns.

  list tree
    Print the full module tree with types, IDs, and chain structure.

  reset
    Wipe the entire module tree and clear undo history. Irreversible.

  cd <path> / ls / pwd
    Navigate the tree. "cd Master Chain" sets context so subsequent
    commands target that module. "cd .." steps out, "cd /" jumps to root.
    "ls" lists children. "pwd" shows current path.

PROPERTY WRITES vs PARAMETER WRITES
  Both use "set <path> <value>". The translator dispatches by path tail:
    *.bypassed         → set_bypassed (boolean)
    *.parent / *.index → move (reparent / reorder)
    *.samplemap        → set_attributes { samplemap }
    *.effect           → set_effect
    *.network          → POST /api/dsp/init (different endpoint)
    *.routing          → set_routing (matrix array or preset string)
    *.routing.send     → set_routing (send subfield)
    anything else      → set_attributes { <param>: <coerced value> }

CONTEXT TARGET
  --target sets an implicit parent without entering the mode:
    hise-cli -builder --target:Master "add LFO as \"Shape\" to gain"

UNDO
  All tree mutations (add, remove, set, clone, rename) are undoable via
  the undo mode. See: hise-cli -undo --help. Plan groups batch multiple
  operations into a single undo step.

RESPONSE FORMAT
  Successful mutations return a diff summary: { ok: true, result: "+ModuleId" }
  for add, "-ModuleId" for remove, "*ModuleId.Param" for set.

ERROR HANDLING
  Invalid type names, nonexistent targets, and chain constraint violations
  return JSON with ok:false and an error message. Reserved-word collisions
  on bare paths surface as parse errors — quote the segment to bypass.

MODULE TYPE IDS
  Common types (partial — run "list types" for the full list):
  SoundGenerators: SineSynth, WaveSynth, Noise, StreamingSampler,
    SynthGroup, GlobalModulatorContainer, SilentSynth
  Effects: SimpleGain, SimpleReverb, HardcodedMasterFX, PolyphonicFilter,
    Convolution, StereoFX, Dynamics, Saturator, Delay, ShapeFX,
    ScriptFX (hosts a DspNetwork — pair with set X.network "<name>")
  MidiProcessors: ScriptProcessor, Transposer, Arpeggiator, MidiPlayer
  Modulators: LFO, AHDSR, Velocity, TableEnvelope, Constant, Random,
    SimpleEnvelope, MidiController, KeyNumber

CHAIN TYPES (exhaustive list)
  children   Main signal path (sound generators, containers)
  fx         Effect processors
  midi       MIDI processors
  gain       Gain/volume modulators
  pitch      Pitch modulators

RECOMMENDED WORKFLOW (complex module trees)
  Use undo plan groups to batch operations into a single undoable unit:
    1. hise-cli -undo 'plan "Add synth layer"'
    2. hise-cli -builder "add SineSynth as \"Lead\" to Master Chain"
    3. hise-cli -builder "add SimpleGain as \"Drive\" to Lead"
    4. hise-cli -builder "add AHDSR as \"VolEnv\" to Lead.gain"
    5. hise-cli -builder "set Lead.Volume -6, Lead.bypassed false"
    6. hise-cli -builder "list tree"
    7. hise-cli -undo "apply"            (or "discard" to rollback all)

EXAMPLES
  hise-cli -builder "list tree"
  hise-cli -builder "list types"
  hise-cli -builder "list types Envelope"
  hise-cli -builder "add SimpleGain as \"Drive\" to Master Chain"
  hise-cli -builder "add AHDSR as \"VolEnv\" to Drive.gain"
  hise-cli -builder "set \"Master Chain\".Volume -6"
  hise-cli -builder "set Drive.bypassed true"
  hise-cli -builder "set \"Script FX1\".network \"my_dsp\""
  hise-cli -builder "set Synth1.routing [0, 1, -1, -1]"
  hise-cli -builder "set Synth1.routing \"stereo\""
  hise-cli -builder "clone Drive 2"
  hise-cli -builder "remove Drive2, Drive3"
  hise-cli -builder "show \"Master Chain\""
  hise-cli -builder --target:Master "add LFO as \"Shape\" to gain, set Shape.Frequency 4.0"
  hise-cli -builder "reset"`,

	dsp: `hise-cli -dsp — scriptnode graph editor

SYNTAX
  hise-cli -dsp "<command>"
  hise-cli -dsp --target:<moduleId> "<command>"

MODULE CONTEXT
  Every DSP command is scoped to a "moduleId" — the script processor that
  hosts the DspNetwork. Each host carries at most one active network.

  TUI entry forms:
    /dsp.ScriptFX1             (dot-context, bare moduleId)
    /dsp."Script FX"           (dot-context, quoted)
    /dsp ScriptFX1             (space form, PascalCase host id)
    /dsp "Script FX"           (space form, quoted)
    /dsp                       (enter without host, select via builder)

  Verbs are lowercase by convention, so /dsp save runs the save one-shot
  rather than entering a host called "save".

  CLI: pass the host via --target:
    hise-cli -dsp --target:"Script FX" "<command>"

NETWORK PROVISIONING (now from builder mode)
  Networks are created or loaded from builder mode:

    hise-cli -builder "set \"Script FX1\".network \"my_dsp\""
        # mode=create — fails if my_dsp.xml exists (suggest .xml form)

    hise-cli -builder "set \"Script FX1\".network \"my_dsp.xml\""
        # mode=load — fails if my_dsp.xml is missing

  Once a network is attached to a host, enter DSP mode against that host
  to edit nodes / connections.

  If you enter /dsp on a host with no network attached, the mode prints an
  error pointing back to "set X.network" in builder, then auto-pops back to
  root mode (does not require an explicit /exit).

NETWORK LIFECYCLE
  list networks                  List .xml files under DspNetworks/
  list modules                   List DspNetwork-capable script processors
  show <nodeId>                  Inspect one node: header, properties,
                                 parameter values with range/default, and
                                 incoming/outgoing modulation edges.
  save                           Persist the loaded network to its .xml
  reset                          Empty the loaded network in memory

GRAMMAR
  - Paths: bare ID or dotted "node.param.field". Quoted segments allow
    spaces or reserved words.
  - Comma chaining: every clause provides full args. Verb inheritance is
    gone: "set A.Freq 440, set B.Freq 880" — note the repeated verb.
  - Numeric values: int/float, percent (50% → 0.5), strict 8-digit hex
    (0xAARRGGBB).

GRAPH EDITING
  add <factory>.<node> as "<id>" [to <parent>]
    Add a node. Factory paths use dot notation (core.oscillator, filters.svf,
    control.pma). "as <id>" is mandatory. Without "to", adds to the current
    cd path. Chained add lands all clauses at the cwd:
      add core.gain as "L", add core.gain as "R"

  remove <nodeId> [, ...]
    Remove nodes. Chained — every clause is a full path.

  rename <target> as "<name>"
    Rename a node (set_id-equivalent op).

  connect <src>[.<output>] to <target>.<param> [matched]
    <output> defaults to the first modulation output when omitted.
    "matched" copies the target parameter's range onto the source after
    wiring (mirrors the IDE normalize button). Chainable across commas.

  disconnect <node>.<param> [, ...]
    Disconnect a modulation. Target-only payload — HISE resolves source.
    Path must have ≥2 segments (node.param).

  set <node>.<param> <value>
    Parameter value-write. Range is pre-validated against scriptnodeList.json.

  set <node>.<param>.<field> <number>
    Range sub-field write. <field> is one of:
      stepSize, middlePosition, skewFactor, default
    Reads the existing range from the cached tree, updates the named field,
    and emits a full range-write payload.

  set <node>.bypassed <bool>
    Bypass via property write — emits a "move" / "bypass" op.

  set <node>.parent <path>
    Reparent a node (real "move" op on /api/dsp/apply).

  set <node>.index <n>
    Reorder within the current parent. Translator looks up the current
    parent from rawTree and emits "move" with new index.

  set <root>.<NetworkProp> <value>
    Network-level property write (root node only). Recognized props:
      AllowCompilation, AllowPolyphonic, HasTail, SuspendOnSilence (bool),
      CompileChannelAmount (int), ModulationBlockSize (power-of-two int or 0).

  create_parameter <container>.<name> [<min>, <max>] [default <d>] [stepSize <s>] [middlePosition <m> | skewFactor <s>]
    Create a dynamic parameter on a container node. Range is a 2-element
    array. middlePosition and skewFactor are mutually exclusive.

PROPERTY IDS (long-form canonical)
  stepSize          range step
  middlePosition    skew anchor (skew center)
  skewFactor        log/exp skew exponent
  default           default value
  matched           post-connect range copy on "connect"

  Short-form aliases (step, mid, skew, interval, normalize) are no longer
  accepted. Use the long form everywhere.

LOCAL QUERIES (no API round-trip)
  get <nodeId>                   -> factory path
  get <node>.<param>             -> current parameter value
  get <node>.<param>.source      -> connected source id (or "(not connected)")
  get <node>.<param>.parent      -> parent container id

NAVIGATION
  cd <container>                 Step into a container
  cd .. / cd /                   Step out / jump to root
  ls                             List children at the current path
  pwd                            Print the current path

SCREENSHOT
  screenshot scale <s> file "<path>"
    Render the current host's DspNetwork graph to a PNG. Both clauses are
    required. Path resolves relative to the project's Images/ folder (or
    absolute) and must end in .png. Scale accepts percentage (50%) or
    decimal (0.5); valid values are 0.5, 1.0, 2.0. Requires the HISE IDE
    UI to be open (returns 503 otherwise).

EXAMPLES
  hise-cli -dsp --target:"Script FX1" "list networks"
  hise-cli -dsp --target:"Script FX1" "show root"
  hise-cli -dsp --target:"Script FX1" "add core.oscillator as \"Osc1\", set Osc1.Frequency 440"
  hise-cli -dsp --target:"Script FX1" "add filters.svf as \"F1\""
  hise-cli -dsp --target:"Script FX1" "add control.pma as \"LFO1\", connect LFO1 to F1.Frequency matched"
  hise-cli -dsp --target:"Script FX1" "disconnect F1.Frequency"
  hise-cli -dsp --target:"Script FX1" "create_parameter root.Cutoff [20, 20000] default 1000 skewFactor 0.3"
  hise-cli -dsp --target:"Script FX1" "set Osc1.Frequency.stepSize 1"
  hise-cli -dsp --target:"Script FX1" "get F1.Frequency.source"
  hise-cli -dsp --target:"Script FX1" "screenshot scale 100% file \"graph.png\""
  hise-cli -dsp --target:"Script FX1" "save"`,

	script: `hise-cli -script — HiseScript REPL

SYNTAX
  hise-cli -script "<expression>"

Evaluates any HiseScript expression against the running HISE instance.
Output includes return value, type, console logs, and errors.

COMPLETION (TUI)
  Tab completes API namespaces and methods:
  Engine., Synth., Console., Content., Math., Array., String.

EXAMPLES
  hise-cli -script "Engine.getSampleRate()"
  hise-cli -script "Console.print(123)"
  hise-cli -script "Synth.addNoteOn(1, 64, 127, 0)"
  hise-cli -script "Content.getComponent('Knob1').getValue()"`,

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

	ui: `hise-cli -ui — UI component editor

SYNTAX
  hise-cli -ui "<command>"
  hise-cli -ui --target:<component> "<command>"

GRAMMAR
  - "as <name>" is mandatory on add (no positional names).
  - Reparent / reorder via property writes: set X.parent <path>,
    set X.index <n>. Both are real /api/ui/apply move ops.
  - Position / size as numeric arrays, not bare numbers:
      bounds   → Array4: [x, y, w, h]
      position → Array2: [x, y]
      size     → Array2: [w, h]
  - Component value writes go through /api/set_component_value:
      set Knob.value 0.5
  - Comma chaining: full clause per comma. Verb inheritance is gone.

COMMANDS
  add <type> as "<name>" [to <parent>]         Add a component
  remove <target> [, ...]                       Remove components
  rename <target> as "<name>"                   Rename a component
  set <target>.<prop> <value>                   Set a property
  set <target>.value <v>                        Component value (set_component_value)
  set <target>.bounds [x, y, w, h]              Position + size (Array4)
  set <target>.position [x, y]                  Array2 form
  set <target>.size [w, h]                      Array2 form
  set <target>.parent <path>                    Reparent (move op)
  set <target>.index <n>                        Reorder within current parent
  set <target>.bypassed <bool>                  Property toggle
  set <target>.visible <bool>                   Property toggle
  get <target>.<prop> [, ...]                   Read a property value
  show <target>                                 Show all properties
  list tree                                     Component tree view
  reset                                         Reset the component tree
  cd <path> / ls / pwd                          Navigate the component tree

COMPONENT TYPES
  ScriptButton, ScriptSlider, ScriptPanel, ScriptComboBox, ScriptLabel,
  ScriptImage, ScriptTable, ScriptSliderPack, ScriptAudioWaveform,
  ScriptFloatingTile, ScriptDynamicContainer, ScriptedViewport,
  ScriptMultipageDialog, ScriptWebView

EXAMPLES
  hise-cli -ui "add ScriptButton as \\"PlayButton\\""
  hise-cli -ui "set PlayButton.bounds [100, 200, 128, 32]"
  hise-cli -ui "set PlayButton.visible false"
  hise-cli -ui "set PlayButton.parent MainPanel"
  hise-cli -ui "set PlayButton.index 0"
  hise-cli -ui "rename PlayButton as \\"StartButton\\""
  hise-cli -ui "add ScriptPanel as \\"Header\\", add ScriptButton as \\"Logo\\" to Header"
  hise-cli -ui "set Logo.bounds [10, 5, 40, 40]"
  hise-cli -ui --target:MainPanel "add ScriptSlider as \\"VolumeKnob\\""
  hise-cli -ui "set VolumeKnob.value 0.5"
  hise-cli -ui "show PlayButton"`,

	undo: `hise-cli -undo — undo history and plan groups

SYNTAX
  hise-cli -undo "<command>"

COMMANDS
  back             Undo last action
  forward          Redo last undone action
  clear            Clear undo history
  plan "<name>"    Start a named plan group (batches operations)
  apply            Apply the current plan group
  discard          Discard the current plan group
  diff             Show diff of current plan group
  history          Show undo history

Plan groups batch multiple builder operations into a single undoable unit.

EXAMPLES
  hise-cli -undo "back"
  hise-cli -undo "history"
  hise-cli -undo 'plan "My Refactor"'`,

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
