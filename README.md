# busybox-wasi

A zero-dependency distribution of **BusyBox** and the **`ash`** POSIX shell compiled for **WASI Preview 1 (`wasm32-wasip1`)**.

Designed as a lightweight, sandboxed Unix utility suite and scripting engine for browser-based IDEs (such as [wasm-c-ide](https://github.com/breeze833/wasm-c-ide)), WebAssembly workers, and edge runtimes.

---

## Features

- **Pure WASI Preview 1 (`wasm32-wasip1`)**: Single-threaded, zero POSIX thread dependencies, standards compliant.
- **Full `ash` POSIX Scripting**:
  - Control flow: `for`, `while`, `until`, `if-then-else`, `case`.
  - Shell variables, parameter expansions, and arithmetic expressions (`$((...))`).
  - Shell functions and local variables.
  - In-process command substitution `$(...)` and pipelines.
- **Curated Unix Applets & Shell (~374 KB uncompressed, ~150 KB gzipped)**:
  - **Text Processing**: `grep`, `egrep`, `fgrep`, `sed`, `awk`, `cat`, `head`, `tail`, `wc`, `cut`, `tr`, `sort`, `uniq`, `paste`, `comm`, `cmp`, `diff`, `tee`, `fold`, `xargs`, `dirname`, `basename`.
  - **Files & Directories**: `ls`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `readlink`, `stat`, `du`, `find`, `tar`, `gzip`, `gunzip`.
  - **Math & Utilities**: `expr`, `bc`, `dc`, `sleep`, `date`, `true`, `false`, `yes`, `which`.
  - **Checksums & Inspection**: `md5sum`, `sha1sum`, `sha256sum`, `cksum`, `crc32`, `seq`, `tac`, `mktemp`, `realpath`, `unlink`, `uname`, `printenv`, `xxd`, `hexdump`.
  - **Internal Shell Builtins**: `env`, `pwd`, `cd`, `read`, `export`, `set`, `unset`, `eval`, `type`, `test` / `[`, `times`.
  - **Host-Assisted Commands**: `time` (wall-clock profiler), `host_echo`, and `wasi_host_spawn` for external Wasm execution.
- **Host-Assisted Process Execution**:
  - Transparently integrates with host runtimes (e.g. `wasm-c-ide` or Node.js) via host import hooks to execute external WebAssembly modules (`clang`, `make`, `./a.out`) without requiring kernel `fork()`/`exec()`.
- **Zero-Dependency CLI Runner & Reference Host**:
  - Includes `bin/cli.js` runnable out of the box with Node.js `node:wasi`.
  - Includes `examples/host-reference.js` providing a standalone reference implementation for external embedding.

---

## Quick Start

### Running with Node.js

```bash
# Run BusyBox ash shell command
node bin/cli.js sh -c "for i in 1 2 3; do echo count=\$i; done"

# Run a specific applet
node bin/cli.js grep "hello" file.txt
node bin/cli.js awk '{ print $1 }' file.txt
node bin/cli.js sed 's/foo/bar/g' file.txt
```

---

## Building from Source

### Prerequisites
- Clang targeting `wasm32-wasi` from standard `wasi-sdk` (recommended: `wasi-sdk >= 26`, default: `29.0`) or `clang-wasi`.
- Node.js (>= 18) for test verification.

### Build Commands

```bash
# Build binary using wasi-sdk toolchain
make build
# (outputs bin/busybox.wasm)

# Run test suite
npm test

# Run standalone host reference implementation
node examples/host-reference.js

# Create release packages (.tar.gz and .tgz in dist/)
make dist
```

---

## CI/CD & Automated Releases

A GitHub Actions workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) is configured to:
- Automatically rebuild and run the full test suite on each push to `main` and on Pull Requests.
- Reset and force-update the rolling **`latest`** git tag so GitHub's automatic source zip archive always matches the latest commit on `main`.
- Publish precompiled release artifacts (`busybox.wasm`, `cli.js`, `busybox-wasi-1.38.0.tar.gz`, `busybox-wasi-1.38.0.tgz`) to the **`latest`** GitHub release.
- Automatically publish versioned GitHub releases when pushing a version tag (e.g., `v1.38.0`).

---

## Architecture & Documentation

- [**`SPEC.md`**](SPEC.md): Technical specification, architectural decisions, and verification matrix.
- [**`docs/HOST_FUNCTIONS.md`**](docs/HOST_FUNCTIONS.md): Specification of all WASI host-assisted functions (`__host_pipe`, `__host_dup`, `__host_dup2`, `__host_builtin_*`, `__host_winsize`, `__host_interrupt`).
- [**`examples/host-reference.js`**](examples/host-reference.js): Complete standalone reference implementation of `BusyBoxHost` and `MemoryPipe` with interactive self-tests.

---

## Acknowledgements

This project's WASI Preview 1 port builds upon and adapts the pioneering work of **Alexandre Gaigalas** ([@alganet](https://github.com/alganet)) in [**`alganet/wasi-sh`**](https://github.com/alganet/wasi-sh). Specifically:
- The fork-free in-process subshell and command substitution (`$(...)`) engine (`ash-forkfree.patch`).
- The host-assisted command dispatch mechanism (`ash-hostbuiltin.patch`).
- The nested shell state preservation logic (`ash-nested-shell.patch`).
- The WASI Preview 1 compatibility shims and signal wrappers (`wasistubs.c`, `wasi_compat.h`, `ppoll.c`).

We express our sincere gratitude to the upstream BusyBox project authors and to Alexandre Gaigalas for establishing these foundational WebAssembly techniques.

---

## License

GPL-2.0-only (upstream BusyBox) with MIT-licensed glue shims and test harnesses.
