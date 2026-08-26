#!/bin/sh
# Compile the syscall validator, bundle the persistence workload before tracing
# (tsx otherwise creates its own temporary transform cache), then assert all
# write-capable pathname syscalls stay in private cache/overflow directories.
set -eu

probe_bin=$(mktemp /tmp/fovea-file-syscall-probe.XXXXXX)
bundle=$(mktemp /tmp/fovea-sqlite-write-probe.XXXXXX.mjs)
root=$(mktemp -d /tmp/fovea-sqlite-syscall-root.XXXXXX)
home=$(mktemp -d /tmp/fovea-sqlite-syscall-cache.XXXXXX)
trace=$(mktemp /tmp/fovea-sqlite-syscalls.XXXXXX)
cleanup() {
  rm -rf "$root" "$home" /tmp/pi-fovea-overflow
  rm -f "$trace" "$probe_bin" "$bundle"
}
trap cleanup EXIT HUP INT TERM

printf 'export function probe() {}\n' > "$root/probe.ts"
cc -O2 -Wall -Wextra -o "$probe_bin" scripts/file-syscall-probe.c
pnpm exec esbuild scripts/sqlite-write-probe.ts --bundle --platform=node --format=esm --outfile="$bundle" >/dev/null
FOVEA_CACHE_DIR="$home" strace -f -qq -e trace=%file -o "$trace" node "$bundle" "$root"
"$probe_bin" "$trace" "$home/pi-fovea" /tmp/pi-fovea-overflow
printf 'SQLite write syscall probe passed\n'
