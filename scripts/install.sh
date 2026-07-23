#!/bin/sh
set -eu

repository="https://github.com/christophhart/hise-cli"
install_dir="${HISE_CLI_INSTALL_DIR:-${HOME}/.local/bin}"

case "$(uname -s)" in
	Linux) ;;
	*)
		printf '%s\n' "hise-cli: this installer supports Linux only" >&2
		exit 1
		;;
esac

case "$(uname -m)" in
	x86_64|amd64) binary_name="hise-cli-linux-x64" ;;
	aarch64|arm64)
		printf '%s\n' "hise-cli: Linux ARM64 is not currently supported" >&2
		exit 1
		;;
	*)
		printf 'hise-cli: unsupported Linux architecture: %s\n' "$(uname -m)" >&2
		exit 1
		;;
esac

if command -v curl >/dev/null 2>&1; then
	download() { curl -fL --progress-bar "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
	download() { wget -O "$2" "$1"; }
else
	printf '%s\n' "hise-cli: curl or wget is required" >&2
	exit 1
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

release_url="$repository/releases/latest/download"
asset="$binary_name.tar.gz"
archive="$tmp_dir/$asset"
binary="$tmp_dir/$binary_name"
checksums="$tmp_dir/SHA256SUMS"

printf 'Downloading %s...\n' "$asset"
download "$release_url/$asset" "$archive"
download "$release_url/SHA256SUMS" "$checksums"

expected=$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' "$checksums")
if [ -z "$expected" ]; then
	printf 'hise-cli: checksum for %s is missing\n' "$asset" >&2
	exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
	actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
else
	printf '%s\n' "hise-cli: sha256sum or shasum is required" >&2
	exit 1
fi

if [ "$actual" != "$expected" ]; then
	printf '%s\n' "hise-cli: checksum verification failed" >&2
	exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
	printf '%s\n' "hise-cli: tar is required" >&2
	exit 1
fi
tar -xzf "$archive" -C "$tmp_dir"

mkdir -p "$install_dir"
install -m 0755 "$binary" "$install_dir/hise-cli"
printf 'Installed hise-cli to %s/hise-cli\n' "$install_dir"

case ":${PATH:-}:" in
	*":$install_dir:"*) ;;
	*) printf 'Add %s to PATH to run hise-cli from any shell.\n' "$install_dir" ;;
esac
