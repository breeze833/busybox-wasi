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
- **Curated Unix Applets (~453 KB uncompressed, ~177 KB gzipped)**:
  - **Text Processing**: `grep`, `egrep`, `fgrep`, `sed`, `awk`, `cat`, `head`, `tail`, `wc`, `cut`, `tr`, `sort`, `uniq`, `paste`, `comm`, `cmp`, `diff`, `tee`, `fold`, `xargs`, `dirname`, `basename`.
  - **Files & Directories**: `ls`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `readlink`, `stat`, `du`, `find`, `tar`, `gzip`, `gunzip`.
  - **Math & Utilities**: `expr`, `bc`, `dc`, `sleep`, `date`, `true`, `false`, `yes`, `which`, `time (builtin)`, `env (builtin)`.
- **Host-Assisted Process Execution**:
  - Transparently integrates with host runtimes (e.g. `wasm-c-ide` or Node.js) via host import hooks to execute external WebAssembly modules (`clang`, `make`, `./a.out`) without requiring kernel `fork()`/`exec()`.
- **Zero-Dependency CLI Runner**:
  - Includes `bin/cli.js` runnable out of the box with Node.js `node:wasi`.

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
- Clang targeting `wasm32-wasi` from **`clang-wasi`** (`/home/breeze/work/projects/clang-wasi/wasi-sdk`) or standard `wasi-sdk`.
- Node.js (>= 18) for test verification.

### Build Commands

```bash
# Build binary using clang-wasi toolchain
make build
# (outputs bin/busybox.wasm)

# Run test suite
npm test

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

## Architecture & Specification

For detailed architectural decisions, WASI patch sets, memory layout, and applet configurations, see [SPEC.md](SPEC.md).

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
