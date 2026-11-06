# Project Specification: busybox-wasi

## 1. Executive Summary

`busybox-wasi` is a zero-dependency WebAssembly distribution of **BusyBox** targeting the **WASI Preview 1 (`wasm32-wasip1`)** standard.

It delivers a lightweight, standalone multicall WebAssembly binary (`busybox.wasm`) combining the **`ash`** POSIX shell with a curated suite of essential Unix core utilities (text processing, file manipulation, and scripting tools). 

Designed specifically as a companion project for browser-based IDEs (such as [wasm-c-ide](https://github.com/breeze833/wasm-c-ide)) and sandboxed WebAssembly environments, `busybox-wasi` bridges the gap between single-process WASI runtimes and rich Unix terminal/scripting workflows through:
1. An optimized, fork-free in-process execution model for internal applets.
2. A pluggable host-assisted process spawn bridge (`wasi_host_spawn`) allowing `ash` to execute external WASI binaries (e.g. `clang`, `make`, `./a.out`) via the WASI host.
3. Streamlined integration with line-buffered frontend editors (such as `LineEditor` and `xterm.js`).

---

## 2. Goals and Non-Goals

### 2.1 Goals
- **WASI Preview 1 Conformance**: Strictly target `wasm32-wasip1` without requiring POSIX threads, shared memory, or non-standard kernel extensions.
- **Full POSIX Scripting via `ash`**: Support control structures (`if-then-else`, `for`, `while`, `until`, `case`), shell functions, subshells, environment and local variables, and parameter expansions.
- **Curated Pedagogical Coreutils**: Provide essential text-processing (`grep`, `sed`, `awk`, `find`, `sort`, `uniq`, `cut`, `tr`, `wc`, `head`, `tail`, `cat`, `diff`) and file utilities (`ls`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `tar`, `gzip`) while stripping unneeded or unsupported utilities.
- **Standalone Multicall Binary**: Produce a single optimized `busybox.wasm` (< 2.0 MB uncompressed, < 600 KB gzip/brotli) runnable directly via WASI runtimes (Node.js `node:wasi`, `wasmtime`, `wazero`, browser workers).
- **Host-Assisted Process Execution**: Provide a clean, optional WASI host import (`env.wasi_host_spawn` / `wasi_snapshot_preview1`) enabling `ash` to execute external Wasm binaries transparently without native OS `fork()` or `execve()`.
- **Reproducible Build Pipeline**: Automated Makefile and scripts that fetch upstream BusyBox, apply WASI patches, configure `.config`, and compile using standard `wasi-sdk`.
- **Automated Verification**: Headless Node.js unit tests validating applets and `ash` script evaluation.

### 2.2 Non-Goals
- **WASI Preview 2 / Component Model**: The scope is strictly WASI Preview 1.
- **Networking Applets**: Omit all network-dependent tools (`wget`, `ping`, `nc`, `telnet`, `ftp`, `ip`, `route`, etc.) as WASI P1 does not standardize BSD sockets.
- **Linux Kernel / System Administration**: Omit hardware, kernel, daemon, and multi-user utilities (`mount`, `umount`, `fdisk`, `insmod`, `ps`, `top`, `init`, `reboot`, `su`, `login`, `passwd`).
- **Interactive TTY / Termios Raw Mode**: The binary does not assume POSIX `termios` (`tcsetattr`/`ioctl`); interactive line editing is delegated to frontend line editors (e.g., `LineEditor` in `xterm.js`).

---

## 3. Architecture & Repository Layout

### 3.1 Repository Structure

```
busybox-wasi/
├── SPEC.md                    # Technical specification & architectural ground truth
├── AGENTS.md                  # Developer & AI agent operating protocols
├── README.md                  # User-facing documentation, quick start, and applet list
├── LICENSE                    # GPLv2 (upstream BusyBox) + MIT (glue & runtime harness)
├── package.json               # Package metadata and test scripts
├── Makefile                   # Build, test, clean, and release targets
├── configs/
│   └── wasi_defconfig         # Tailored BusyBox Kconfig for wasm32-wasip1
├── patches/                   # Modular WASI Preview 1 patches for upstream BusyBox
│   ├── ash-forkfree.patch
│   ├── ash-hostbuiltin.patch
│   ├── ash-shebang.patch
│   ├── ash-shebang-path.patch
│   ├── ash-nested-shell.patch
│   ├── ash-complete-hostbuiltin.patch
│   └── applet-interrupt.patch
├── src/
│   └── shim/                  # WASI Preview 1 compatibility shims & setjmp runtime
│       ├── wasi_compat.h
│       ├── wasistubs.c
│       ├── ppoll.c
│       ├── rt.c
│       └── musl-compat/       # Vendored musl headers (netdb.h, paths.h, pwd.h, etc.)
├── scripts/
│   └── build.sh               # Fetch, patch, configure, compile, and link via wasi-sdk
├── bin/                       # Generated release artifacts
│   ├── busybox.wasm           # Standalone WebAssembly multicall binary (~453 KB)
│   └── cli.js                 # Zero-dependency Node.js CLI runner
├── dist/                      # Packaged release archives (.tar.gz and .tgz)
├── .github/
│   └── workflows/
│       └── release.yml        # CI/CD workflow with rolling latest tag & releases
└── test/
    ├── test-applets.js        # Automated unit tests for text & file applets
    └── test-ash.js            # Automated unit tests for ash loops, conditions, and scripts
```

---

## 4. Applet Selection & Configuration Specification

The configuration (`configs/wasi_defconfig`) is intentionally curated for programming, build workflows, and educational shell usage:

### 4.1 Shell & Core Interpreter
- `ash`: Primary POSIX shell.
- `CONFIG_FEATURE_SH_STANDALONE=y`: Applets are resolved internally before attempting external process execution.
- `CONFIG_ASH_INTERNAL_GLOB=y`: Internal globbing engine without external libc glob dependencies.
- `CONFIG_ASH_OPTIMIZE_FOR_SIZE=y`: Lean bytecode and memory footprint.
- Builtins: `test`, `[`, `[[`, `echo`, `printf`, `pwd`, `read`, `export`, `set`, `unset`, `source` / `.`, `eval`, `exec`, `exit`, `type`, `kill` (stubbed).

### 4.2 Text Processing & Filtering
- `grep`, `egrep`, `fgrep`
- `sed` (stream editor)
- `awk` (pattern scanning and processing language)
- `cat`, `head`, `tail`, `wc`
- `cut`, `tr`, `sort`, `uniq`, `paste`, `comm`, `cmp`, `diff`
- `tee`, `fold`, `xargs`, `dirname`, `basename`

### 4.3 File & Directory Management
- `ls` (with coloring and formatting options)
- `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`
- `readlink`, `stat`, `du`, `find`
- Archiving: `tar`, `gzip`, `gunzip`

### 4.4 Scripting & Utility
- `expr`, `bc`, `dc`
- `sleep`, `date`
- `time` (shell keyword/builtin)
- `true`, `false`, `yes`, `which`
- `env` (shell builtin avoiding external execve)

### 4.5 Excluded Applets
- All networking (`CONFIG_FEATURE_IPV6`, `wget`, `ping`, `nc`, `telnet`, `ftp`, `ip`, `route`, etc.).
- All process monitoring requiring `/proc` (`ps`, `top`, `killall`, `pgrep`).
- All disk partitioning, filesystem mounting, and block devices (`fdisk`, `mount`, `umount`, `mkfs`).
- All PAM, shadow passwords, and multi-user security (`login`, `passwd`, `su`, `useradd`).
- Linux-specific IPC, signals, and namespaces.

---

## 5. WASI Platform Adaptations & Patches

Because upstream BusyBox assumes a conventional Linux/POSIX kernel, the following adaptations are applied in `patches/busybox-wasi-*.patch`:

### 5.1 Process Model & Fork Emulation
1. **Single-Process In-Memory Applet Invocation**:
   - With `CONFIG_FEATURE_SH_STANDALONE=y`, BusyBox invokes applets by calling their `<applet>_main(argc, argv)` function directly.
   - Global state inside applets is reset or reinitialized between runs (or handled cleanly via BusyBox `run_applet_no_and_exit` / `xfunc` exit handlers).
2. **Host-Assisted Process Execution (`wasi_host_spawn`)**:
   - In `shellexec()` / `find_command()`, when a command is not an internal BusyBox applet:
     - Instead of invoking `fork()` and `execve()`, `ash` calls the host import:
       ```c
       __attribute__((__import_module__("env"), __import_name__("wasi_host_spawn")))
       int wasi_host_spawn(const char *cmd, const char *const *argv, const char *const *envp);
       ```
     - If the host provides this import, the host instantiates and runs the requested Wasm module (`clang.wasm`, `./a.out`), returning the integer exit status to `ash`.
     - If the host does not implement the import, `ash` gracefully prints `ash: <cmd>: command not found` and sets `$? = 127`.

### 5.2 Emulated System Calls
- **Signals**: WASI P1 does not deliver asynchronous signals. Signal handlers (`sigaction`, `signal`) are stubbed as no-ops.
- **Terminal Control (`termios`)**: `tcgetattr`, `tcsetattr`, and terminal `ioctl` are stubbed. Interactive line buffering is handed to the caller.
- **Directory & File Operations**: `chdir`, `getcwd`, `stat`, `open`, `read`, `write`, `close`, `unlink`, `rmdir` map directly to standard WASI Preview 1 syscalls provided by `wasi-libc`.

---

## 6. Build System & Toolchain Specification

### 6.1 Toolchain Requirements
- **Compiler**: Clang from `wasi-sdk >= 24` (recommended: `wasi-sdk >= 26`, default: `29.0`).
- **Target Triple**: `wasm32-wasip1` (`wasm32-unknown-wasi`).
- **Post-Processor**: `wasm-opt` (from Binaryen) with `-O2` or `-Oz`.
- **Host Tools**: `make`, `gcc` (for host kconfig compilation during `make menuconfig`), `curl`, `tar`, `node` (>= 18).

### 6.2 Compilation Flags
- Compiler flags:
  `-target wasm32-wasi -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=true -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS -idirafter src/shim/musl-compat -include src/shim/wasi_compat.h`
- Linker flags:
  `-lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-getpid -lwasi-emulated-process-clocks --stack-first -z stack-size=1048576 --strip-debug --wrap fcntl --wrap exit --wrap ioctl --wrap poll --wrap raise --wrap read --wrap write --wrap readv --wrap writev --wrap __wasilibc_fd_renumber`

---

## 7. Packaging & Distribution

1. **Release Artifacts (`dist/`)**:
   - `busybox.wasm`: Standalone multicall WebAssembly binary (~453 KB uncompressed, ~177 KB gzipped).
   - `busybox-wasi-1.38.0.tar.gz`: Standalone distribution archive containing `bin/busybox.wasm`, `bin/cli.js`, `package.json`, and `README.md`.
   - `busybox-wasi-1.38.0.tgz`: Standard npm package tarball for direct dependency installation.
2. **Distribution & CI/CD Pipeline (`.github/workflows/release.yml`)**:
   - **Push to `main`**: Automatically rebuilds, verifies tests, resets and updates the rolling `latest` git tag, and publishes the `latest` pre-release assets on GitHub Releases.
   - **Versioned Tag (`v*`)**: Automatically builds and publishes a permanent versioned GitHub Release.
   - Downstream consumers (e.g. `wasm-c-ide`) can directly download prebuilt release binaries without compilation overhead.

---

## 8. Acknowledgements

This distribution's WASI Preview 1 port architecture builds upon and adapts the research and implementation by **Alexandre Gaigalas** ([@alganet](https://github.com/alganet)) in [**`alganet/wasi-sh`**](https://github.com/alganet/wasi-sh), notably:
- The fork-free in-memory subshell and pipeline architecture (`ash-forkfree.patch`).
- The host-assisted command dispatch mechanism (`ash-hostbuiltin.patch`).
- The nested shell state preservation logic (`ash-nested-shell.patch`).
- The WASI Preview 1 compatibility shims and signal wrappers (`wasistubs.c`, `wasi_compat.h`, `ppoll.c`).

