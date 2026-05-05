set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
	@just --list

install:
	npm install

build:
	npm run build

bun:
	npm run build:binary:{{ if os() == "macos" { "mac" } else if os() == "windows" { "windows" } else { "linux" } }}

bun-mac:
	npm run build:binary:mac

bun-mac-x64:
	npm run build && node scripts/build-binary.mjs --target bun-darwin-x64

# Sync src/engine/highlight/ → highlight-export/ for docs website consumption
export-highlight:
	npm run export-highlight

# Bump version in package.json + lockfile, commit, tag v<version>, push tag (CI builds binaries), publish to npm.
# Requires `npm login` first. The `prepack` script auto-runs `npm run build` so dist/ is fresh on publish.
bump version:
	npm version {{version}} --no-git-tag-version
	git add package.json package-lock.json
	git commit -m "bump version to {{version}}"
	git tag v{{version}}
	git push
	git push origin v{{version}}
	npm publish

# Build the docs-site embed bundle and copy into the HISE website's public/embed/
[unix]
embed website_root="/Users/christophhart/Development/hise_website_v2":
	npm run build:embed
	rm -rf "{{ website_root }}/public/embed"
	mkdir -p "{{ website_root }}/public/embed"
	cp -R dist/embed/. "{{ website_root }}/public/embed/"
	@echo "[embed] copied → {{ website_root }}/public/embed"

[windows]
embed website_root='D:\Development\Projekte\hise_website_v2':
	npm run build:embed
	if (Test-Path "{{ website_root }}\public\embed") { Remove-Item -Recurse -Force "{{ website_root }}\public\embed" }
	New-Item -ItemType Directory -Force -Path "{{ website_root }}\public\embed" | Out-Null
	Copy-Item -Recurse -Force "dist\embed\*" "{{ website_root }}\public\embed"
	Write-Host "[embed] copied -> {{ website_root }}\public\embed"
