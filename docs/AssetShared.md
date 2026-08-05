# Asset Manager Shared Files

## Goal

Some third-party asset vendors ship multiple asset packs that share a common text-code layer, for example utility headers, script files, or DSP helper code. Users should be able to install several compatible packs without duplicating the common files or hitting false file-conflict errors.

The Asset Manager should support this without introducing dependency packages, version solving, or a mutable global ref-count.

## Core Model

Shared ownership is package-centric and derived from `install_packages_log.json`.

Each installed package keeps its own `File` steps. If two packages use the same shared file, the same `Target` path appears in both package entries. The effective reference count is computed by scanning the log for matching `Target` values.

Do not store an explicit `RefCount` field. A mutable counter can drift if installs fail, logs are edited, cleanup removes steps, or package entries are removed. The package entries are the source of truth.

## Package Identity

Use a compound package identity derived from vendor and package name:

```text
PackageId = Company + "::" + Name
```

The existing package metadata already stores these fields:

- `Name` from the source project's `project_info.xml`
- `Company` from the source project's `user_info.xml`

Use this compound ID for installed-package lookup, shared ownership maps, update/uninstall comparisons, and conflict messages. Treat it as an opaque comparison key and never parse it back into company and name. Keep the friendly display name separate.

For compatibility with old or partially written logs, matching should tolerate an empty `Company` field if the package `Name` matches. New log entries should always write both `Name` and `Company` from the source package metadata.

## SharedWildcard

Add a new optional field to `package_install.json`:

```json
{
  "SharedWildcard": [
    "DspNetworks/ThirdParty/Vendor/Common/*",
    "AdditionalSourceCode/Vendor/Common/*"
  ]
}
```

`SharedWildcard` is a safety marker. It does not install files globally, resolve dependencies, or create a shared registry. It only marks which included files are allowed to be co-owned by multiple packages.

`SharedWildcard` uses the same wildcard matching rules as the normal positive and negative package filters. It is evaluated only after the normal package filters have already included the file. Avoid leading slashes in examples and generated package files.

## Shareable File Eligibility

A file is shareable only if all conditions are true:

```text
included by the normal package filters
AND matches SharedWildcard
AND the incoming source file is text
```

Binary files matched by `SharedWildcard` are simply not marked as shared. This keeps the feature safe without burdening package authors with perfect wildcard precision. If a later package tries to install the same binary target, it hard-fails as a normal file conflict.

Text eligibility should use the same rules as the existing modified-file hash system. For archive installs, classify the archive entry itself, not the target file on disk. The implemented rule is extension allow-list plus a maximum source size. Unknown-size source entries should not be treated as shared.

## Install Log

Store the shared intent per `File` step:

```json
{
  "Type": "File",
  "Target": "DspNetworks/ThirdParty/Vendor/Common/Common.h",
  "Hash": "123456789",
  "Shared": true,
  "Modified": "2026-05-18T12:00:00"
}
```

For non-shared files, omit `Shared`. Readers must treat missing `Shared` as `false`.

The `Hash` field remains the text content hash used for modified-file detection. Shared files are text-only, so the same hash can be used for shared equality checks. Store the hash as a decimal string to avoid 64-bit precision loss in JSON tooling.

Accepted shared duplicates still write their own `File` step to the new package log. This is the package's ownership record even though the physical file was not copied again.

## Install Conflict Rules

When installing a package and a target file already exists:

1. If the existing file is untracked, hard-fail.
2. If the existing file is tracked by another package, but the incoming file is not marked shared, hard-fail.
3. If the existing file is tracked by another package, but any existing owner did not mark that `File` step as shared, hard-fail.
4. If the existing file is tracked by another package, but the file is binary or non-text, hard-fail.
5. If the existing file is tracked by another package, all owners mark it shared, the incoming file is shared, and the text hashes match, accept it. Skip copying the file, but record the `File` step in the new package log.
6. If the existing file is tracked by another package, all owners mark it shared, the incoming file is shared, but the text hashes differ, hard-fail with a shared-file-content-differs message.

This requires mutual consent. Both the existing owner and the incoming package must explicitly mark the file as shared.

Install conflict messages should use short user-facing reasons:

```text
<Target>: trying to overwrite a user file
<Target>: trying to overwrite a file from another package
<Target>: file conflict with existing package
<Target>: shared file content differs from existing package <Owner> <Version>
```

The final install hint should be:

```text
Shared files can only be installed when every package marks them as shared and the file contents are identical.
```

## Update Rules

The update route must inspect the incoming package before uninstalling the current package. Shared files require a preflight before any mutation.

Before uninstalling the currently installed package, inspect the incoming package file list and compare it against the current install log:

- Ignore normal files that are owned only by the package being updated. These are allowed to change.
- Only perform shared update checks for targets that are also owned by another active package.
- If a shared file would keep the same hash across all other owners, the update may proceed.
- If a shared file would change and another installed package still owns the old shared file, block the update before uninstalling anything.
- If an update would stop marking a file as shared while another package still owns the same target, block the update before uninstalling anything.
- The user must uninstall all affected packs first, then install compatible updated versions.

Example error wording:

```text
Cannot update VendorFilterPack because it changes shared files that are also used by:

- VendorCompressorPack 1.0.0

Shared files must be identical across all installed assets. Uninstall all affected packs first, then install compatible versions.
```

Update conflict messages should use short user-facing reasons:

```text
<Target>: installed package has inconsistent shared file ownership
<Target>: update would stop sharing a file still used by another package
<Target>: file conflict with existing package
<Target>: shared file content differs from existing package <Owner> <Version>
```

The final update hint should be:

```text
Shared files must stay identical across all installed assets. Uninstall all affected packs first, then install compatible versions.
```

Do not add dependency graphs, batch update transactions, or version solving for the first implementation.

## Uninstall Rules

When uninstalling a package:

1. For each `File` step, scan the install log for other active package entries with the same `Target`.
2. If another package still references the same `Target`, skip deleting the file and continue. This applies to any remaining ownership record, not only shared records, so uninstall never deletes a file that another package still claims.
3. If no other package references the target, run the existing deletion and modified-file preservation logic.
4. Entries in `NeedsCleanup` state do not count as active owners because their `Steps` have already been removed.

If a shared file was modified by the user and at least one other package still owns it, leave it in place and do not mark cleanup for the package being uninstalled. If the last owner is uninstalled and the file was modified, the existing `NeedsCleanup` behavior applies.

## Implemented Logic

1. Parse `SharedWildcard` from `package_install.json`.
2. Classify each incoming file after normal payload filtering.
3. Mark an incoming file as shared only if it matches `SharedWildcard` and passes text eligibility.
4. Calculate the incoming text hash before writing the file. This hash is used for shared equality checks and for the install log.
5. Build an ownership map from active install-log package entries. Key it by normalized `Target`. Store owner package ID, display name, version, shared flag, and hash.
6. Ignore `NeedsCleanup` entries in ownership maps because their reversible file steps are no longer active ownership records.
7. During fresh install, preflight every incoming file before writing anything.
8. During update, preflight only files that are also owned by another active package. Do not run the full fresh-install conflict rules against files owned only by the package being updated.
9. If a shared duplicate is accepted, skip copying the physical file but still log the file step for the new package.
10. During uninstall, skip deleting any file still owned by another active package.
11. During creator load/save cleanup, preserve `SharedWildcard` as the same line-list/array shape as the other wildcard fields. The actual UI field can be added separately.

## Runtime Log Behaviour

Accepted shared duplicates should produce an explicit install log line:

```text
> Skip shared file <path>
```

Uninstalling a package while another package still owns the file should produce:

```text
> Keep file owned by another package <path>
```

## Edge Cases

- Missing `Shared` in old logs is treated as not shared.
- Old logs with an empty `Company` can still match a package with the same `Name`.
- If existing shared owners disagree on hash or shared state, fail safe and report inconsistent shared ownership.
- If a package version removes a previously shared file, uninstalling the old package removes only that package's ownership. The file remains if another package still owns it.
- If an install fails after writing files but before writing the log, future installs may see untracked files and fail. This is an existing non-transactional installer limitation.
- The shared-file equality check should use the same text hash mechanism as modified-file detection unless a future implementation deliberately switches to byte-exact hashing.
- Dry-run/test-run mode is for payload filter validation. It should mark shared actions, but it does not need to run shared ownership conflict preflight.
