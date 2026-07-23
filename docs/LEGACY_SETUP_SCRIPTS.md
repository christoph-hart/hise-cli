# Legacy Setup Script Templates

This document preserves the old setup pipeline script templates after removing
`src/setup/` and `src/setup-core/`.

Scope:
- Script phase order and intent
- Dynamic variables and skip rules
- Platform-specific shell snippets worth reusing
- Detection and metadata logic that used to feed the setup flow

This is reference-only material for future wizard pipeline reimplementation.

## Dynamic inputs

Common inputs previously provided by setup config / detection:

- `installPath` - target HISE clone/build directory
- `platform` - `windows` | `macos` | `linux`
- `architecture` - `x64` | `arm64`
- `includeFaust` - include Faust installation + Faust build config
- `includeIPP` - Windows-only optional IPP handling
- `targetCommit` - optional Git SHA to check out
- `faustVersion` - optional Faust release version (default used: `2.83.1`)
- `ctx.hasGit` - skip `git-install` if true
- `ctx.hasFaust` - skip `faust-install` when `includeFaust` and true

Build configuration mapping used by compile/verify/path/test phases:

- Windows/macOS: `Release with Faust` when `includeFaust`, else `Release`
- Linux: `ReleaseWithFaust` when `includeFaust`, else `Release`

## Phase order

1. `git-install`
2. `clone-repo`
3. `build-deps` (Linux only)
4. `faust-install` (conditional)
5. `extract-sdks`
6. `compile`
7. `add-path`
8. `verify`
9. `test`

## Templates by phase

### 1) `git-install`

Windows (PowerShell):

```powershell
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
  winget install Git.Git --accept-package-agreements --accept-source-agreements
} else {
  $gitInstaller = "$env:TEMP\git-installer.exe"
  Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.43.0.windows.1/Git-2.43.0-64-bit.exe" -OutFile $gitInstaller
  Start-Process -FilePath $gitInstaller -Args "/VERYSILENT /NORESTART" -Wait
  Remove-Item $gitInstaller -Force -ErrorAction SilentlyContinue
}
```

macOS (bash):

```bash
if ! command -v git &> /dev/null; then
  echo "ERROR: Git is not installed. Run: xcode-select --install"
  exit 1
fi
```

Linux (bash):

```bash
if ! command -v git &> /dev/null; then
  sudo apt-get update
  sudo apt-get install -y git
fi
```

### 2) `clone-repo`

Core steps:

```bash
if [ ! -d "$HISE_PATH/.git" ]; then
  git clone https://github.com/christophhart/HISE.git "$HISE_PATH"
else
  cd "$HISE_PATH"
  git fetch origin
fi

cd "$HISE_PATH"
# either:
git checkout <targetCommit>
# or:
git checkout develop && git pull origin develop

git submodule update --init
cd JUCE && git checkout juce6 && cd ..
```

Dynamic parts:
- `HISE_PATH` derives from `installPath`
- checkout strategy depends on `targetCommit`

### 3) `build-deps` (Linux only)

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential make llvm clang libfreetype6-dev libx11-dev libxinerama-dev \
  libxrandr-dev libxcursor-dev mesa-common-dev libasound2-dev freeglut3-dev \
  libxcomposite-dev libcurl4-gnutls-dev libgtk-3-dev libjack-jackd2-dev \
  libwebkit2gtk-4.0-dev libpthread-stubs0-dev ladspa-sdk
```

### 4) `faust-install`

Skip when:
- `includeFaust` is false
- detected `ctx.hasFaust` is true

Windows:

```powershell
$faustUrl = "https://github.com/grame-cncm/faust/releases/download/<faustVersion>/Faust-<faustVersion>-win64.exe"
Invoke-WebRequest -Uri $faustUrl -OutFile $faustInstaller
Start-Process -FilePath $faustInstaller -Args '/S /D=C:\Program Files\Faust' -Wait
```

macOS:

```bash
FAUST_DMG="Faust-<faustVersion>-<archSuffix>.dmg"   # arm64 | x64
curl -L -o "$DOWNLOAD_PATH" "$FAUST_URL"
hdiutil attach "$DOWNLOAD_PATH" -readonly -nobrowse -mountpoint /tmp/faust-mount
mkdir -p "$HISE_PATH/tools/faust"
cp -R /tmp/faust-mount/* "$HISE_PATH/tools/faust/"
xattr -cr "$HISE_PATH/tools/faust"
hdiutil detach /tmp/faust-mount 2>/dev/null || true
```

Linux:

```bash
sudo apt-get install -y faust || {
  echo "Install manually from source"; exit 1;
}
```

### 5) `extract-sdks`

```bash
cd "$HISE_PATH/tools/SDK"
if [ ! -d "ASIOSDK2.3" ]; then
  tar -xf sdk.zip
fi
test -d "ASIOSDK2.3" && test -d "VST3 SDK"
```

### 6) `compile`

Common idea:
- Run Projucer `--resave` for `projects/standalone/HISE Standalone.jucer`
- Build with platform toolchain

Windows:

```powershell
& "$HISE_PATH\JUCE\Projucer\Projucer.exe" --resave "$HISE_PATH\projects\standalone\HISE Standalone.jucer"
# detect solution in VisualStudio2026 or VisualStudio2022
& "<MSBuild.exe>" "<HISE Standalone.sln>" /p:Configuration="<buildConfig>" /p:Platform=x64 /verbosity:minimal
```

macOS:

```bash
"$HISE_PATH/JUCE/Projucer/Projucer.app/Contents/MacOS/Projucer" --resave "HISE Standalone.jucer"
xcodebuild -project "Builds/MacOSX/HISE Standalone.xcodeproj" -configuration "$BUILD_CONFIG" -jobs "$(sysctl -n hw.ncpu)"
```

Linux:

```bash
"$HISE_PATH/JUCE/Projucer/Projucer" --resave "HISE Standalone.jucer"
cd Builds/LinuxMakefile
make CONFIG="$BUILD_CONFIG" AR=gcc-ar -j"$(nproc --ignore=2)"
cd build && ln -sf "HISE Standalone" HISE
```

### 7) `add-path`

Windows:

```powershell
$hiseBinPath = "<...>\Builds\VisualStudio2022\x64\<buildConfig>\App"
if (-not (Test-Path $hiseBinPath)) {
  $hiseBinPath = "<...>\Builds\VisualStudio2026\x64\<buildConfig>\App"
}
[Environment]::SetEnvironmentVariable("Path", "$currentPath;$hiseBinPath", "User")
```

macOS/Linux append shell config export:

```bash
echo "export PATH=\"\$PATH:$HISE_BIN\"" >> "$SHELL_CONFIG"
```

### 8) `verify`

Windows:

```powershell
if (-not (Test-Path "$hiseBinPath\HISE.exe")) { exit 1 }
if ((Get-Item "$hiseBinPath\HISE.exe").Length -lt 10MB) { exit 1 }
& "$hiseBinPath\HISE.exe" get_build_flags
```

macOS/Linux:

```bash
test -f "$HISE_BIN" || exit 1
"$HISE_BIN" get_build_flags || echo "Warning"
```

### 9) `test`

Core commands:

```bash
"$HISE_BIN" set_hise_settings -hisepath:"$HISE_PATH" [optional faust/ipp args]
"$HISE_BIN" set_project_folder -p:"$HISE_PATH/extras/demo_project"
"$HISE_BIN" export "$HISE_PATH/extras/demo_project/XmlPresetBackups/Demo.xml" -t:instrument -p:VST3 -nolto
```

Windows-specific extra step attempted:

```powershell
& "$HISE_PATH\extras\demo_project\Binaries\batchCompile.bat"
```

## Legacy environment detection notes

The removed setup flow used these heuristics:

- Platform from `process.platform` -> `windows|macos|linux`
- Architecture from `process.arch` -> `arm64` else `x64`
- Git detection: `where git` (Windows) or `command -v git`
- Compiler detection:
  - Windows: `vswhere` display name or MSBuild path existence
  - macOS: `xcodebuild -version` fallback `clang --version`
  - Linux: `gcc --version` fallback `g++`
- Faust detection:
  - Windows: `C:\Program Files\Faust\lib\faust.dll`
  - macOS/Linux: `faust` on PATH
- IPP detection (Windows): `C:\Program Files (x86)\Intel\oneAPI\ipp\latest`
- Existing install scan candidates:
  - Windows: `C:\HISE`, `~/HISE`, `D:\HISE`, `~/Documents/HISE`, `~/Desktop/HISE`
  - macOS: `~/HISE`, `/Users/Shared/HISE`, `~/Documents/HISE`, `~/Desktop/HISE`
  - Linux: `~/HISE`, `/opt/HISE`, `~/Documents/HISE`

Detected install signature:
- `projects/standalone/HISE Standalone.jucer` must exist
- `isGitRepo`: `.git` exists
- `commitHash`: `git -C <path> rev-parse HEAD` if repo

## Legacy online metadata notes

The removed setup flow fetched:

- Latest passing HISE CI commit from GitHub Actions workflow `39324714`
  on `christophhart/HISE` `develop`
- Latest Faust release from `grame-cncm/faust` releases API

Main endpoints:

- `GET https://api.github.com/repos/christophhart/HISE/actions/workflows/39324714/runs?branch=develop&per_page=50`
- `GET https://api.github.com/repos/grame-cncm/faust/releases/latest`
