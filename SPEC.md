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
│   ├── host.js                # Browser-safe, zero-dependency host bridge module & MemoryPipe
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
├── docs/                      # Technical documentation & host architecture
│   └── HOST_FUNCTIONS.md      # Specification of WASI host-assisted functions
├── examples/                  # Reference implementations for host embeddings
│   └── host-reference.js      # Complete standalone WASI host & MemoryPipe runner
├── .github/
│   └── workflows/
│       └── release.yml        # CI/CD workflow with rolling latest tag & releases
└── test/
    ├── test-applets.js        # Automated unit tests for text & file applets
    └── test-ash.js            # Automated unit tests for ash loops, conditions, and scripts
```

---

## 4. Command Classification & Configuration Specification

Commands accessible in `busybox-wasi` fall into three distinct architectural categories:
1. **Multicall Applets**: Independent command-line utilities compiled into the binary, callable directly via `bin/cli.js <applet>` or from `ash` via standalone resolution (`CONFIG_FEATURE_SH_STANDALONE=y`).
2. **Internal Shell Builtins**: Commands implemented directly within the `ash` interpreter that manipulate shell state (environment, directory, variables, execution flow) without external dispatch.
3. **Host-Assisted Commands (`CMDHOST`)**: Dynamic JavaScript-backed commands provided by the WASI host embedding through the `env.__host_builtin_*` import interface.

---

### 4.1 Multicall Applets: Text Processing & Filtering
- `grep`, `egrep`, `fgrep`
- `sed` (stream editor)
- `awk` (pattern scanning and processing language)
- `cat`, `head`, `tail`, `wc`
- `cut`, `tr`, `sort`, `uniq`, `paste`, `comm`, `cmp`, `diff`
- `tee`, `fold`, `xargs`, `dirname`, `basename`

### 4.2 Multicall Applets: File & Directory Management
- `ls` (with coloring and formatting options)
- `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`
- `readlink`, `stat`, `du`, `find`
- Archiving: `tar`, `gzip`, `gunzip`

### 4.3 Multicall Applets: Math & Scripting Utilities
- `expr`, `bc`, `dc`
- `sleep`, `date`
- `true`, `false`, `yes`, `which`

### 4.4 Multicall Applets: Checksums & Data Utilities
- Checksums: `md5sum`, `sha1sum`, `sha256sum`, `cksum`, `crc32`
- Stream & Text: `seq`, `tac`, `mktemp`, `realpath`, `unlink`
- System & Inspection: `uname`, `printenv`, `xxd`, `hexdump`

### 4.5 Internal Shell Builtins (`ash`)
These commands execute in-process inside `ash`, modifying or inspecting internal shell state:
- `env`: Dumps current process environment or executes a command with modified environment variables without invoking external `execve`.
- `pwd`: Prints the current working directory from shell state.
- `cd`: Navigates filesystem directories, supporting `-` (previous directory) and `$HOME`.
- `read`: Reads input from stdin into shell variables with delimiter support.
- `export`, `set`, `unset`: Controls shell variables, export flags, and shell runtime options.
- `eval`: Dynamically constructs and executes shell command strings.
- `exec`: Replaces or redirects shell file descriptors.
- `exit`: Exits the current subshell or script with specified status code.
- `type`, `command -v`: Queries command resolution (`builtin`, `applet`, `host builtin`).
- `test`, `[`, `[[`: Evaluates file tests, string comparisons, and arithmetic expressions.
- `times`: Reports process user and system CPU times.
- `source` / `.`: Evaluates shell scripts within the current shell context.
- `kill`: Stubbed process signal builtin.

### 4.6 Host-Assisted Builtins (`CMDHOST`)
Commands registered dynamically by the embedding WASI host (e.g. `bin/cli.js`, `wasm-c-ide`) via the `env.__host_builtin_*` import interface:
- **Registration**: The host registers command names. `ash` resolves them to `CMDHOST` via `__host_builtin_lookup(name, len)` before path search.
- **Execution**: `ash` calls `__host_builtin_run(cwd, argc, argv, envp)`. The host receives the current working directory, command arguments, and current exported shell environment, executing with inherited stdin, stdout, and stderr descriptors.
- **Sample Host Builtins**:
  - `time <cmd> [args...]`: Host-implemented execution timer. Measures high-resolution duration (`performance.now()`), executes the target command, and prints standard timing metrics (`real 0mX.XXXs`).
  - `host_echo [args...]`: Diagnostic host command echoing arguments and environment keys to verify host bridge integrity.
  - `wasi_host_spawn`: Host bridge to execute external WebAssembly binaries (`clang`, `make`, `./a.out`).

### 4.7 Excluded Applets
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
   - **Nested Applet Dispatch (`spawn_and_wait`)**:
     - Parent applets that spawn child utilities (such as `xargs` and `find -exec`) route all applet executions in-process via `run_nofork_applet()`, eliminating reliance on unsupported kernel `vfork()` or `execve()`.
   - **Common Buffer (`bb_common_bufsiz1`) State Preservation**:
     - BusyBox applets (including `xargs`, `grep`, `sed`) store their global state structures (`struct globals G`) inside the shared `bb_common_bufsiz1` buffer.
     - When an applet executes a nested applet through `run_nofork_applet()`, the parent's `bb_common_bufsiz1` memory is preserved inside `nofork_save_area` and restored upon child return, preventing corruption of the parent's argument pointers and option state.
   - **Nesting Depth & Stdio Drainage**:
     - Invocation nesting depth (`nofork_depth`) is tracked across both standalone multicall entry (`run_applet_no_and_exit`) and nested child spawns (`spawn_and_wait`).
     - Stdin drainage (`fflush(stdin)`) occurs exclusively when the outermost applet terminates (`depth == 1`), ensuring multi-batch iterative consumers (such as `xargs -n <N>`) retain buffered input streams across child applet iterations.
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

2. **NPM Package Exports Contract (`package.json`)**:
   The package is published as an ES module supporting direct Node.js execution and browser / Web Worker integration:
   - **`"type": "module"`**
   - **CLI Entry Point (`.` / `"main"`)**: `./bin/cli.js` for command-line execution and shell scripts.
   - **Host Bridge Subpath Export (`./host`)**: `./src/host.js` for downstream embedding in browser IDEs and custom WASI runtimes:
     ```javascript
     import { MemoryPipe, createBusyboxBridge, wrapWasiPipes } from 'busybox-wasi/host';
     ```
   - **Exported Symbols**:
     - `MemoryPipe`: FIFO in-memory byte buffer with chunk queuing, offset tracking, and write-reference counting (`write()`, `read()`, `close()`).
     - `createBusyboxBridge(options)`: Factory function returning the WebAssembly `env` imports (`__host_pipe`, `__host_dup`, `__host_dup2`, `__host_winsize`, `__host_winch`, `__host_interrupt`, `__host_trace`, `__host_builtin_lookup`, `__host_builtin_name`, `__host_builtin_run`, `wasi_host_spawn`, `__host_sock_*`).
     - `wrapWasiPipes(wasiImports, state)`: Interceptor routing standard WASI `fd_read`, `fd_write`, `fd_close`, and `fd_renumber` through `MemoryPipe` descriptors.

3. **Distribution & CI/CD Pipeline (`.github/workflows/release.yml`)**:
   - **Push to `main`**: Automatically rebuilds, verifies tests, resets and updates the rolling `latest` git tag, and publishes the `latest` pre-release assets on GitHub Releases.
   - **Versioned Tag (`v*`)**: Automatically builds and publishes a permanent versioned GitHub Release.
   - Downstream consumers (e.g. `wasm-c-ide`) can directly download prebuilt release binaries without compilation overhead.

---

## 8. Testing & Verification Specification

To ensure robust multicall execution on WASI Preview 1 and prevent regressions across BusyBox upgrades and toolchain changes, automated tests must execute against `bin/busybox.wasm` via `bin/cli.js` (`npm test`) covering the curated applets:

### 8.1 Text Processing & Stream Utilities (`test/test-applets.js`)
- **Output & Formatting**: `echo`, `printf` (string, integer, newline formatting).
- **Pattern Matching & Transformation**:
  - `grep`, `egrep`, `fgrep`: basic, extended regex, and fixed strings matching over stdin and files.
  - `sed`: substitution, global replacements, and regex addressing.
  - `awk`: field splitting, column reordering, pattern expressions.
  - `tr`: character translation, uppercase/lowercase conversions.
- **Slicing, Ordering & Aggregation**:
  - `cat`: stream concatenations and file reads.
  - `head`, `tail`: line limits (`-n`) and offsets.
  - `cut`: delimiter-based column extraction (`-d`, `-f`).
  - `sort`, `uniq`: lexicographical ordering, duplicate deduplication.
  - `paste`, `comm`: column joining and set comparison.
  - `wc`: word, line, and byte counting (`-w`, `-l`, `-c`).
  - `fold`: line wrapping at specified column width (`-w`).
  - `tee`: stdout duplication to file and terminal stream.
  - `xargs`: argument batching (`-n`) across multiple iterations, stdin persistence, and execution both standalone and within `ash` pipelines.
- **Path Transformation**: `dirname`, `basename`.
- **Comparison & Reversal**: `cmp`, `diff -u`, `tac`.

### 8.2 File & Directory Management (`test/test-applets.js`)
- **Lifecycle Sequence**:
  - `mkdir -p`: creating nested subdirectories.
  - `touch`: creating files and updating mtimes.
  - `stat`: querying file and directory attributes.
  - `ls`: directory listing, detailed format (`-la`).
  - `cp`: file copy, recursive directory copy.
  - `mv`: file renaming and moving into subdirectories.
  - `find`: traversing directory tree by name or type (`-name`, `-type`).
  - `du`: directory disk usage reporting.
  - `readlink`, `realpath`: symlink and path canonicalization.
  - `rm`: file and recursive directory deletion (`-rf`).
  - `rmdir`: empty directory removal.
  - `unlink`: single file removal.

### 8.3 Archiving & Compression (`test/test-applets.js`)
- **Gzip & Gunzip**:
  - Compressing stream or file with `gzip`.
  - Decompressing with `gunzip` verifying byte-exact round-trip.
- **Tar Archiving**:
  - Packaging files with `tar -cf` or `tar -czf`.
  - Listing contents with `tar -tf`.
  - Extracting archive with `tar -xf` validating restored hierarchy and content integrity.

### 8.4 Math & Core Scripting Utilities (`test/test-applets.js`)
- **Math**: `expr` (arithmetic expressions), `bc` (multi-precision calculator), `dc` (reverse-polish calculator).
- **Core Utilities**: `true` (exit 0), `false` (exit 1), `yes` (continuous output truncated via pipe), `which` (path resolution), `pwd` (working directory), `date` (timestamp generation), `sleep` (timer delay), `seq` (number sequences), `uname` (system information), `printenv` (environment variables).

### 8.5 Checksums & Encodings (`test/test-applets.js`)
- **Cryptographic & Non-Cryptographic Checksums**:
  - `md5sum`, `sha1sum`, `sha256sum`: verifying known test vectors against string inputs.
  - `cksum`, `crc32`: POSIX checksum and cyclic redundancy checks.
- **Binary Inspection**: `xxd`, `hexdump` formatting of binary streams.

### 8.6 Ash Shell Scripting (`test/test-ash.js`)
- Control flow: `for`, `while`, `until`, `if-then-else`, `case`.
- Variables, parameter expansions, and arithmetic expressions (`$((...))`).
- Shell functions and local variable scoping.
- Command substitution (`$(...)`) and in-memory pipe integration via `__host_pipe`.
- Unknown external command error handling ($? = 127).

### 8.7 Internal Shell Builtins (`test/test-ash.js`)
- `env`: Environment inspection and variable dumping.
- `pwd` and `cd`: Path navigation, directory switching, and working directory querying.
- `read`: Standard input stream parsing into shell variables.
- `export`, `set`, `unset`: Variable propagation across subshells and option toggling.
- `eval`: Dynamic command construction and evaluation.
- `type` and `command -v`: Resolution of builtins (`type echo`), applets (`type sed`), and host builtins (`type time`).
- `test` and `[`: File existence, directory checks, string comparisons, and numeric tests.
- `times`: Process execution time reporting.

### 8.8 Host-Assisted Builtin Execution (`test/test-ash.js`)
- `time`: Host-implemented timing wrapper measuring command elapsed wall time (`real 0mX.XXXs`).
- Sample host command (e.g. `host_echo`): Verification of argument forwarding, environment passing (`envp`), and custom exit code propagation via `__host_builtin_run`.

---

## 9. Acknowledgements

This distribution's WASI Preview 1 port architecture builds upon and adapts the research and implementation by **Alexandre Gaigalas** ([@alganet](https://github.com/alganet)) in [**`alganet/wasi-sh`**](https://github.com/alganet/wasi-sh), notably:
- The fork-free in-memory subshell and pipeline architecture (`ash-forkfree.patch`).
- The host-assisted command dispatch mechanism (`ash-hostbuiltin.patch`).
- The nested shell state preservation logic (`ash-nested-shell.patch`).
- The WASI Preview 1 compatibility shims and signal wrappers (`wasistubs.c`, `wasi_compat.h`, `ppoll.c`).

