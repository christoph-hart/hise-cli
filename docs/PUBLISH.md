# PUBLISH — technical reference

> **Status: in progress.** This document is a long-form technical reference
> intended for review of the `/publish` mode and `build_installer` wizard
> implementation. It will be distilled into a shorter user-facing doc once
> approved.
>
> Sections marked **[TODO PR-N]** are stubs that will be filled in as the
> referenced PR lands. The plan that drove this work lives at
> `~/.claude/plans/i-ve-written-a-github-proud-cray.md`.

---

## 1. Overview

`/publish` is the hise-cli mode that turns already-compiled HISE plugin
binaries into a signed, user-runnable installer. It picks up *after*
`/project export project --default` has produced binaries under
`Binaries/Compiled/...` (Windows) or
`Binaries/Builds/MacOSXMakefile/build/Release/...` (macOS) and:

- packages them into Inno Setup `.exe` (Windows) or `pkgbuild` `.pkg`
  (macOS),
- code-signs the binaries and the installer with the developer's
  Authenticode (Windows) or Developer ID (macOS) cert,
- on macOS, notarizes and staples via `xcrun notarytool`,
- on either platform, optionally signs the AAX bundle via PACE
  `wraptool` against an Avid-issued WCGUID.

Two entry points share one engine:

| Entry point                   | Audience                        |
|-------------------------------|---------------------------------|
| `/publish` mode (REPL)        | Humans running locally          |
| `/wizard build_installer`     | Same wizard, form-based UI      |
| `hise-cli -publish "build …"` | Headless CLI for CI runners     |

The mode adds two preflight verbs (`check system`, `check binaries
<list>`) on top of the wizard.

---

## 2. Quickstart

Minimum end-to-end path on a project that already has `project_info.xml`
and `user_info.xml`:

```sh
hise-cli                                # enter TUI
/hise launch                            # boot HISE
/project switch /path/to/project        # point at the project
/project export project --default       # produce binaries
/publish                                # enter publish mode
check system                            # preflight (admin, ISCC, certs, …)
check binaries VST3,AAX                 # confirm binaries exist
build with codesign=1, notarize=1       # build & sign installer
/exit                                   # back to root
```

Headless CLI equivalent:

```sh
hise-cli -publish "check system"
hise-cli -publish "check binaries VST3,AAX"
hise-cli -publish "build with codesign=1, notarize=1"
```

---

## 3. Preflight (`check system`)

**[TODO PR-3, PR-5]** — full table of checks, expected output, and
remediation per failure once the init handler lands.

Tracked checks (planned):

- both: project folder set, `project_info.xml` parseable, at least one
  binary discovered, version field set
- Windows: admin elevation (only when codesign requested), `iscc` on
  PATH, `signtool` on PATH (only when codesign requested), code-signing
  cert in `Cert:\CurrentUser\My`
- macOS: `pkgbuild` on PATH, Developer ID Application identity in
  keychain, notarize keychain profile (only when notarize requested)

Critical failures (no binaries, missing iscc/pkgbuild, missing project
metadata) abort the wizard via `WizardInitAbortError`. Non-critical
failures (missing cert, missing notary profile) flip the corresponding
toggle off and disable it in the form, but allow the wizard to proceed
producing an unsigned/un-notarized installer.

---

## 4. Wizard fields

**[TODO PR-3]** — table of every field, type, default, init source, and
visibility rule once `data/wizards/build_installer.yaml` lands.

---

## 5. Pipeline tasks

**[TODO PR-3, PR-4]** — for each task in order: inputs, the actual
`spawn()` argv emitted, expected output paths, failure modes.

Planned task sequence (from approved plan):

1. `publishAssertReady` — validate payload + binary versions
2. `publishStagePayload` — copy bundles into `dist/payload/`
3. `publishSignBinaries` — signtool / codesign per binary
4. `publishEnsureAaxKeyfile` — Windows self-signed PFX gen if missing
5. `publishSignAax` — `wraptool sign` + `wraptool verify`
6. `publishBuildInstaller` — `iscc` / `pkgbuild`
7. `publishSignInstaller` — signtool / productsign on the installer
8. `publishNotarize` — `xcrun notarytool submit` + `stapler staple`

---

## 6. Windows signing (Authenticode)

**[TODO PR-4]** — full walkthrough.

Key points (planned):

- Cert detection uses PowerShell:
  ```powershell
  Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object -First 1 Thumbprint, Subject | ConvertTo-Json -Compress
  ```
- `signtool` invocation:
  ```
  signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /sha1 <thumbprint> <file>
  ```
- Authenticode is independent of the PACE keyfile used for AAX (see §8).

---

## 7. macOS signing (Developer ID + notarize)

**[TODO PR-4]** — full walkthrough.

Key points (planned):

- Identity detection uses `security find-identity -v -p codesigning`
  parsed for `Developer ID Application: <Name> (<TeamID>)`.
- `codesign --force --timestamp --options runtime --deep --sign "<id>"
  <bundle>` per binary.
- `pkgbuild --root <staging> --identifier <id> --version <v>
  --install-location /Library/Audio/Plug-Ins/<format> <out.pkg>`.
- One-time notary profile setup:
  ```sh
  xcrun notarytool store-credentials notarize \
    --apple-id <appleid> --team-id <teamid> --password <app-password>
  ```
  (this part hise-cli does NOT automate — documented as user
  responsibility).
- Notarize:
  ```sh
  xcrun notarytool submit <pkg> --keychain-profile notarize --wait
  xcrun stapler staple <pkg>
  ```

---

## 8. AAX / PACE

**[TODO PR-4]** — exhaustive walkthrough.

Pinned facts:

- WCGUID is per-plugin, Avid-issued via the developer portal.
- iLok account email + `HISE_AAX_PASSWORD` env var are the credentials.
- PACE keyfile (Windows `.pfx`/`.p12`) is independent of the
  Authenticode code-signing cert. They are different worlds:
  - Authenticode → CA-validated → SmartScreen / Defender
  - PACE keyfile → Avid backend matches the registered public key by
    WCGUID, ignoring CA chain → self-signed is fine and recommended
- macOS uses `--signid "<Developer ID Application: …>"` instead of a
  separate keyfile.
- After any keyfile change (including initial self-signed generation),
  the public key MUST be uploaded to Avid via `wraptool dump --account
  <email> --password <pwd> --wcguid <wcguid>` before the next sign
  succeeds. hise-cli does NOT automate this step.
- Self-signed certs auto-generated by hise-cli use a 20-year
  `NotAfter`, sidestepping cert rotation in any practical project
  lifecycle. Existing signed AAX bundles continue to work past cert
  expiry — only *new* signs require an unexpired, registered cert.

Windows self-signed keyfile generation (planned):

```powershell
$cert = New-SelfSignedCertificate `
    -Subject "CN=HiseCli AAX Sign - <PluginName>" `
    -Type CodeSigningCert `
    -KeyExportPolicy Exportable `
    -KeySpec Signature `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\CurrentUser\My `
    -NotAfter (Get-Date).AddYears(20)
$pwd = ConvertTo-SecureString "<random-32>" -Force -AsPlainText
Export-PfxCertificate -Cert $cert `
  -FilePath "<project>\.publish\aax-selfsigned.pfx" -Password $pwd
```

Wraptool sign invocation (planned):

```
wraptool sign --verbose --account <email> --password <env:HISE_AAX_PASSWORD> \
  --keyfile <pfx> --keypassword <generated> --wcguid <wcguid> \
  --in <input.aaxplugin> --out <output.aaxplugin>
wraptool verify --in <output.aaxplugin>
```

macOS variant — drops `--keyfile`/`--keypassword`, uses `--signid <id>`.

---

## 9. Per-project `.publish/aax.json`

**[TODO PR-4]** — schema, gitignore handling, env-var precedence.

Pinned schema:

```json
{
  "wcguid": "B2E480D0-E78F-11E9-90D1-005056928F3B",
  "accountEmail": "dev@example.com",
  "keyfile": "C:\\path\\to\\selfsigned.pfx",
  "keyPassword": "<32-char random>"
}
```

Resolution order at sign time (highest wins):

1. Env var (`HISE_AAX_*`) — for CI runners
2. Wizard answer (typed-in or carried from prior submit)
3. `.publish/aax.json`

`.publish/` is appended to project `.gitignore` idempotently when the
file is first written.

---

## 10. Environment variables

**[TODO PR-4]** — full table with required-vs-optional, where each is
read, CI vs local conventions.

Planned vars:

| Var                     | Where read                          | Required when                        |
|-------------------------|-------------------------------------|--------------------------------------|
| `HISE_AAX_PASSWORD`     | `publishSignAax`                    | AAX in payload                       |
| `HISE_AAX_WCGUID`       | init handler (overlay)              | optional override                    |
| `HISE_AAX_ACCOUNT`      | init handler (overlay)              | optional override                    |
| `HISE_AAX_KEYFILE`      | init handler (overlay, Windows)     | optional override                    |
| `HISE_AAX_KEYPASSWORD`  | init handler (overlay, Windows)     | optional override                    |

---

## 11. CI integration

**[TODO PR-5]** — collapse `develop-build.yml` to `hise-cli -publish
"build with …"` calls. Self-hosted runner setup notes (keychain,
profile, cert store).

---

## 12. Troubleshooting

**[TODO PR-5]** — common errors verbatim + fix.

Planned entries: ISCC missing; cert missing; `signtool error
0x80092004`; notarize keychain profile not found; `wraptool: account
credentials invalid`; `wraptool sign: keyfile expired`.

---

## 13. Architecture

**[TODO PR-5]** — how `/publish` mode + `build_installer` wizard fit
into the existing engine/tui/cli split. How to extend with new payload
targets or new installer formats.

Pinned facts:

- Mode lives in `src/engine/modes/publish.ts`, registered in
  `src/session-bootstrap.ts`.
- Wizard YAML at `data/wizards/build_installer.yaml`, init handler at
  `src/tui/wizard-handlers/publish-detect.ts`, task handlers at
  `src/tui/wizard-handlers/publish-tasks.ts`.
- Pure modules (no `node:` imports):
  - `src/engine/project/project-info-xml.ts` (parser)
  - `src/engine/project/binary-discovery.ts` (path probing)
  - `src/engine/project/aax-config.ts` (`.publish/aax.json` schema)
  - `src/engine/modes/publish-parse.ts` (CSV payload parser)
- Filesystem and shell access through `DataLoader` and `PhaseExecutor`
  wrappers per the engine-layer rule (see `CLAUDE.md`).
