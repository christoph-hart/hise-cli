# Self-hosted runner setup

One-time bootstrap for each macOS / Windows runner that powers the release
pipeline (`.github/workflows/release.yml`). Without these prerequisites, the
codesign, notarize, or Inno Setup steps will fail.

The macOS runner also cross-compiles the unsigned Linux x64 baseline standalone
binary. Bun provides the target runtime, so no Linux SDK or Apple signing step
is required for that artifact.

The runner labels expected by the workflow are the GitHub defaults
(`self-hosted` + `macOS` / `Windows`).

## macOS runner

### Toolchain

```bash
brew install bun           # or: curl -fsSL https://bun.sh/install | bash
brew install node          # or any Node 18+
```

Verify `bun --version` and `node --version` print versions in a fresh shell.
If you installed bun manually after the runner service was started, restart
the runner so it inherits the updated `PATH`.

### Code signing certs

Two distinct Developer ID certs from the Apple Developer portal:

- **Developer ID Application** — signs the Mach-O binary
- **Developer ID Installer** — signs the `.pkg`

Both go into the runner user's login keychain. After importing, run a
test `codesign --sign "Developer ID Application: ..."` and a test
`pkgbuild --sign "Developer ID Installer: ..."` interactively, and click
**Always Allow** on the keychain prompt for each. That ACL is what lets the
non-interactive workflow bypass the password dialog.

### Notarization profile

```bash
xcrun notarytool store-credentials notarize \
  --apple-id "you@example.com" \
  --team-id "PF9H8PK77F" \
  --password "xxxx-xxxx-xxxx-xxxx"   # app-specific password
```

The profile name (`notarize`) is what the workflow's
`--keychain-profile notarize` flag references. App-specific passwords are
generated at appleid.apple.com.

Verify with `xcrun notarytool history --keychain-profile notarize`.

### Login keychain

The login keychain must be **unlocked** when the workflow runs. If the runner
machine sleeps or you log out, the keychain locks and codesign starts
prompting again. Options: keep the runner machine awake + logged in, or
unlock in the workflow:

```yaml
- run: security unlock-keychain -p "$KEYCHAIN_PWD" ~/Library/Keychains/login.keychain-db
```

(Adds a `KEYCHAIN_PWD` repo secret. Only worth it if interactive sessions
aren't viable.)

## Windows runner

### Toolchain

```powershell
# Bun
irm bun.sh/install.ps1 | iex

# Node + npm
winget install OpenJS.NodeJS.LTS

# Inno Setup (per-user install — note path)
winget install JRSoftware.InnoSetup
```

Verify `bun --version`, `node --version`, `npm --version`, and `iscc /?` all
work in a fresh PowerShell session.

### PowerShell execution policy

`npm.ps1` won't load under the default `Restricted` policy:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### PATH for `iscc`

`winget install JRSoftware.InnoSetup` installs to
`%LOCALAPPDATA%\Programs\Inno Setup 6` and does **not** add it to `PATH`.
Two options:

1. Permanent (preferred — no per-workflow boilerplate):
   ```powershell
   [Environment]::SetEnvironmentVariable(
     "PATH",
     "$([Environment]::GetEnvironmentVariable('PATH','User'));$env:LOCALAPPDATA\Programs\Inno Setup 6",
     "User"
   )
   ```
   Restart the runner so it inherits the updated `PATH`.

2. Per-workflow (already wired in `release.yml`):
   ```yaml
   - run: echo "$env:LOCALAPPDATA\Programs\Inno Setup 6" >> $env:GITHUB_PATH
   ```

### Restart after PATH changes

Self-hosted runners cache the environment they were launched with. Any time
you install something new (bun, node, Inno Setup) or change `PATH`, restart
the runner service:

```powershell
.\svc.cmd stop
.\svc.cmd start
```

(Or kill `Runner.Listener` and re-launch `run.cmd`.)

## Both platforms

### Persistent state

The workflow uses `npm install --prefer-offline --no-audit --no-fund` (not
`npm ci`). On a fresh checkout the first install is full; subsequent runs
are near-instant because `node_modules/` persists between jobs on
self-hosted runners.

### Upgrading the runner

Single self-hosted runner version per machine — keep it current with GitHub
periodically (`./config.sh remove`, re-download tarball, re-register). The
release pipeline doesn't depend on any specific runner version.
