# HOST_FUNCTIONS.md: WASI Host-Assisted Functions Specification

This document provides the technical specification for all host-assisted functions imported by `busybox-wasi` under the **`env`** WebAssembly import namespace.

Targeting **WASI Preview 1 (`wasm32-wasip1`)**, `busybox-wasi` operates in a single-threaded sandbox without native Linux kernel features (such as `fork()`, `execve()`, BSD sockets, asynchronous POSIX signals, and interactive `termios` ioctl). Host-assisted functions bridge this gap by delegating process execution, in-memory pipelining, terminal dimension queries, and interrupt handling to the host JavaScript runtime.

---

## 1. Host Functions Overview Matrix

| Import Symbol | Function Signature | Calling Mechanism | Description |
| :--- | :--- | :--- | :--- |
| **`__host_pipe`** | `(ptr: i32) -> i32` | `pipe()`, `evalbackcmd()`, `evalpipe()` | Allocates an in-memory bidirectional pipe pair (`readFd`, `writeFd`). |
| **`__host_dup`** | `(fd: i32, minfd: i32) -> i32` | `fcntl(F_DUPFD)`, `evalbackcmd()` | Duplicates a file descriptor to an FD $\ge$ `minfd` with ref-counting. |
| **`__host_dup2`** | `(oldfd: i32, newfd: i32) -> i32` | `dup2()`, `xmove_fd()`, `evalpipe()` | Duplicates `oldfd` onto `newfd`, managing pipe write-reference lifetimes. |
| **`__host_builtin_lookup`** | `(namePtr: i32, len: i32) -> i32` | `ash:find_command()` | Checks if a command is registered by the host as a host builtin (`CMDHOST`). |
| **`__host_builtin_name`** | `(idx: i32, buf: i32, len: i32) -> i32` | `ash:complete()` | Enumerates host builtin names for shell tab-completion. |
| **`__host_builtin_run`** | `(cwd: i32, argc: i32, argv: i32, envp: i32) -> i32` | `ash:evalcommand()` | Dispatches in-process execution of a host builtin command. |
| **`wasi_host_spawn`** | `(cmd: i32, argv: i32, envp: i32) -> i32` | `ash:shellexec()` | Executes an external WebAssembly binary (`clang`, `make`, `./a.out`). |
| **`__host_winsize`** | `(rPtr: i32, cPtr: i32) -> void` | `ioctl(TIOCGWINSZ)`, `stty size` | Populates current terminal rows and columns. |
| **`__host_winch`** | `() -> i32` | `ppoll()`, `SIGWINCH` handler | Detects pending terminal window resize events. |
| **`__host_interrupt`** | `() -> i32` | `bb_intr_tick()`, `Ctrl+C` | Detects host-triggered execution cancellation / interrupt tokens. |
| **`__host_trace`** | `(id: i32) -> void` | `fork()` stub | Diagnostic telemetry for unsupported POSIX call attempts. |
| **`__host_sock_*`** | `(...) -> i32` | `socket()`, `connect()` | Socket fallback stubs (stubbed to `-1`). |

---

## 2. In-Memory Pipes & Descriptor Duplication

Because WASI Preview 1 lacks POSIX pipes, `ash` uses in-memory FIFO buffers (`MemoryPipe`) to support fork-free subshell command substitutions `$(...)` and builtin pipelines `|`.

### 2.1 `__host_pipe(int *fds)`
- **Wasm Import Signature**: `env.__host_pipe(ptr: i32) -> i32`
- **Description**: Allocates a new in-memory byte pipe (`MemoryPipe`). Assigns a reader descriptor (`readFd`) and a writer descriptor (`writeFd`) with initial `writeRefs = 1`. Writes `readFd` (4 bytes, LE) and `writeFd` (4 bytes, LE) to memory at `ptr`.
- **Return Value**: `0` on success, or `-1` on error.
- **Used by Commands & Applets**:
  - `ash`: Subshell command substitution `$(cmd)` in `evalbackcmd()` (`patches/ash-forkfree.patch`).
  - `ash`: Pipelines `cmd1 | cmd2 | cmd3` in `evalpipe()` (`patches/ash-forkfree.patch`).
  - Applets invoking `pipe()` (`libbb/xfuncs_printf.c`).

### 2.2 `__host_dup(int fd, int minfd)`
- **Wasm Import Signature**: `env.__host_dup(fd: i32, minfd: i32) -> i32`
- **Description**: Duplicates file descriptor `fd` to a new descriptor number $\ge$ `minfd`. If `fd` refers to a pipe writer, increments `pipe.writeRefs`.
- **Return Value**: New allocated descriptor integer, or `-1` on error.
- **Used by Commands & Applets**:
  - `ash`: Saving the original `stdout` file descriptor (`save1 = fcntl(1, F_DUPFD, 10)`) prior to pipe redirection in command substitutions `$(...)`.
  - Applets calling `fcntl(fd, F_DUPFD, minfd)` or `fcntl(fd, F_DUPFD_CLOEXEC, minfd)`.

### 2.3 `__host_dup2(int oldfd, int newfd)`
- **Wasm Import Signature**: `env.__host_dup2(oldfd: i32, newfd: i32) -> i32`
- **Description**: Duplicates descriptor `oldfd` onto `newfd`:
  1. If `newfd` was already open and was a pipe writer, decrements its previous `writeRefs` (closing the previous pipe if `writeRefs <= 0`).
  2. If `oldfd` is a pipe writer, increments its `writeRefs`.
  3. If `oldfd` is a WASI Preview 1 filesystem descriptor, delegates to `wasi_snapshot_preview1.fd_renumber` or alias mapping.
- **Return Value**: `newfd` on success, or `-1` on error.
- **Used by Commands & Applets**:
  - `ash`: Redirecting `stdout` into a pipe writer (`dup2(pip[1], 1)`), and restoring saved `stdout` (`dup2(save1, 1)`).
  - `gunzip`, `gzip`, `tar`: File descriptor renumbering via `xmove_fd(from, to)` and `xdup2(from, to)` when streaming compressed data to/from standard descriptors.
  - `awk`, `sed`: Stream redirection and `__wrap___wasilibc_fd_renumber()`.

---

## 3. Host-Assisted Command Execution (`CMDHOST`)

To execute commands that cannot be compiled into BusyBox (such as compilers, custom tools, or execution profilers), `ash` incorporates a host builtin dispatch protocol (`patches/ash-hostbuiltin.patch`).

```
  ash: find_command("time")
           │
           ▼
  __host_builtin_lookup("time") ───(returns 1)───► Marks as CMDHOST
                                                        │
                                                        ▼
                                           __host_builtin_run(cwd, argc, argv, envp)
                                                        │
                                                        ▼
                                           JavaScript Host Execution
```

### 3.1 `__host_builtin_lookup(const char *name, int len)`
- **Wasm Import Signature**: `env.__host_builtin_lookup(namePtr: i32, len: i32) -> i32`
- **Description**: Queries the host to determine whether `name` is a registered host builtin. Invoked during command resolution in `find_command()` *before* path searching.
- **Return Value**: `1` if the host provides the command, `0` otherwise.
- **Used by Commands**:
  - `ash`: Command lookup for any registered host utility (e.g. `time`, `host_echo`, `gcc`, `clang`, `make`, `sqlite3`).
  - `type <cmd>` and `command -v <cmd>`: Identifies command classification (reports `<cmd> is a host builtin`).

### 3.2 `__host_builtin_name(int index, char *buf, int len)`
- **Wasm Import Signature**: `env.__host_builtin_name(index: i32, bufPtr: i32, len: i32) -> i32`
- **Description**: Retrieves the name of the host builtin registered at index `index`. Copies the UTF-8 null-terminated name string into `bufPtr` up to `len` bytes.
- **Return Value**: Length of string written in bytes, or `0` if index is out of bounds.
- **Used by Commands**:
  - `ash`: Interactive tab auto-completion for registered host builtins (`patches/ash-complete-hostbuiltin.patch`).

### 3.3 `__host_builtin_run(const char *cwd, int argc, char **argv, char **envp)`
- **Wasm Import Signature**: `env.__host_builtin_run(cwdPtr: i32, argc: i32, argvPtr: i32, envpPtr: i32) -> i32`
- **Description**: Dispatches in-process execution of a host builtin command:
  - `cwdPtr`: Null-terminated string path of current guest working directory.
  - `argc`: Number of arguments.
  - `argvPtr`: Pointer to array of null-terminated UTF-8 argument strings (`argv[0] ... argv[argc-1]`).
  - `envpPtr`: Pointer to null-terminated array of exported environment strings (`KEY=VALUE`).
  - Inherits the current file descriptors (including redirections and pipes installed on `0`, `1`, `2`).
- **Return Value**: Process exit code integer (`0`–`255`), or `126`/`127` on error.
- **Used by Commands**:
  - `time <cmd> [args...]`: Profiling host command measuring wall-clock duration and outputting `real 0mX.XXXs`.
  - `host_echo [args...]`: Diagnostic verification of host-bridge argument passing.
  - Toolchain commands (`gcc`, `clang`, `make`) when hosted in integrated developer environments like `wasm-c-ide`.

### 3.4 `wasi_host_spawn(const char *cmd, const char *const *argv, const char *const *envp)`
- **Wasm Import Signature**: `env.wasi_host_spawn(cmdPtr: i32, argvPtr: i32, envpPtr: i32) -> i32`
- **Description**: Host-assisted process execution bridge for standalone WebAssembly binaries (`.wasm`). When `ash` encounters an executable path (e.g. `./a.out`, `/workspace/main`), it delegates instantiation and execution to the host without POSIX `fork()`/`execve()`.
- **Return Value**: Integer exit status of child process, or `127` if executable not found.
- **Used by Commands**:
  - Direct execution of compiled binaries (`./a.out`, `/workspace/app`).

---

## 4. Terminal Control & Window Geometry

WASI Preview 1 has no `ioctl()` subsystem. Applets that format text according to terminal geometry query dimensions through these hooks.

### 4.1 `__host_winsize(int *rows, int *cols)`
- **Wasm Import Signature**: `env.__host_winsize(rPtr: i32, cPtr: i32) -> void`
- **Description**: Populates live terminal window geometry. Writes terminal rows (`int32`, LE) to `*rPtr` and columns (`int32`, LE) to `*cPtr`.
- **Used by Commands & Applets**:
  - `stty size`: Queries terminal dimensions.
  - `ls -C` / `ls`: Formats columnated directory listings matching window width.
  - `fold`, `more`, text pagers: Wrap and pause based on screen height and width.
  - Wrapped `ioctl(0, TIOCGWINSZ, ...)` in `src/shim/wasistubs.c`.

### 4.2 `__host_winch(void)`
- **Wasm Import Signature**: `env.__host_winch() -> i32`
- **Description**: Detects pending window size change events (`SIGWINCH`). Returns `1` if a resize event occurred since the last query, `0` otherwise.
- **Used by Commands & Applets**:
  - `ppoll()` and `poll()` event loops in `src/shim/ppoll.c`.
  - Shell window size change handlers when running interactive sessions.

---

## 5. Signal Emulation & Process Cancellation

WASI Preview 1 does not support asynchronous POSIX signals (`SIGINT`, `SIGTERM`). To enable interactive `Ctrl+C` interruption, `busybox-wasi` uses a polling tick counter.

### 5.1 `__host_interrupt(void)`
- **Wasm Import Signature**: `env.__host_interrupt() -> i32`
- **Description**: Returns an incremental 32-bit counter tracking host cancellation requests. When the host catches a `Ctrl+C` key sequence or user cancellation event, it increments this counter.
- **Used by Commands & Applets**:
  - Long-running applets and infinite loops: `yes`, `tail -f`, `sleep`, `find`, `grep` over large trees.
  - `bb_intr_enter()` and `bb_intr_tick()` in `src/shim/wasistubs.c` and `patches/applet-interrupt.patch`.
  - Interrupts execution safely, raising `SIGINT` exit status (`130`) back to the shell prompt.

---

## 6. Diagnostic Tracing & Socket Stubs

### 6.1 `__host_trace(int id)`
- **Wasm Import Signature**: `env.__host_trace(id: i32) -> void`
- **Description**: Diagnostic telemetry hook. Emits an event to host logs when an unsupported kernel syscall stub is hit (e.g. `fork()` called with `id = 1`).
- **Used by**:
  - `fork()` stub in `src/shim/wasistubs.c`.

### 6.2 Socket Stubs (`__host_sock_*`)
- **Symbols**:
  - `__host_sock_open() -> i32`
  - `__host_sock_connect(fd: i32, addr: u32, port: i32) -> i32`
  - `__host_sock_resolve(namePtr: i32, addrPtr: i32) -> i32`
  - `__host_sock_bind(fd: i32, addr: u32, port: i32) -> i32`
  - `__host_sock_listen(fd: i32) -> i32`
- **Description**: Fallback stubs for networking calls in `wasistubs.c`. In sandboxed WASI environments without WebSocket/TCP bridges, returning `-1` (`ENOSYS` / `EAI_NONAME`) is standard.

---

## 7. Reference JavaScript Host Implementation

A complete, production-grade reference implementation with built-in self-tests is provided in [**`examples/host-reference.js`**](file:///home/breeze/projects/busybox-wasi/examples/host-reference.js).

External projects (such as `wasm-c-ide`, browser web workers, or custom Node.js execution harnesses) can import `BusyBoxHost` and `MemoryPipe` directly:

```javascript
const { BusyBoxHost, MemoryPipe } = require('../examples/host-reference.js');

// 1. Create host instance with terminal dimensions and custom callbacks
const host = new BusyBoxHost({
  cwd: '/workspace',
  rows: 30,
  cols: 100,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  builtins: {
    // Custom host-assisted commands accessible from ash
    host_time: ({ argv }) => {
      console.log('Running custom host profiler on:', argv);
      return 0;
    }
  }
});

// 2. Execute BusyBox commands or ash scripts
const exitCode = host.run('bin/busybox.wasm', [
  'sh',
  '-c',
  'VAR=$(printf "3\\n1\\n2\\n" | sort); echo "Sorted: $VAR"'
]);
```

### Reference Implementation Code Summary

```javascript
class MemoryPipe {
  constructor() {
    this.chunks = [];
    this.totalLen = 0;
    this.closed = false;
    this.writeRefs = 0;
  }
  write(data) {
    if (this.closed || !data || data.length === 0) return 0;
    this.chunks.push(new Uint8Array(data));
    this.totalLen += data.length;
    return data.length;
  }
  read(maxLen) {
    if (this.totalLen === 0) return new Uint8Array(0);
    const toRead = Math.min(maxLen, this.totalLen);
    const result = new Uint8Array(toRead);
    let offset = 0;
    while (offset < toRead && this.chunks.length > 0) {
      const head = this.chunks[0];
      const needed = toRead - offset;
      if (head.length <= needed) {
        result.set(head, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        result.set(head.subarray(0, needed), offset);
        offset += needed;
        this.chunks[0] = head.subarray(needed);
      }
    }
    this.totalLen -= toRead;
    return result;
  }
  close() {
    this.closed = true;
  }
}

export function createBusyBoxEnv(memoryGetter) {
  const pipeFiles = new Map();
  let nextPipeFd = 500;
  let interruptSeq = 0;

  return {
    __host_trace: (id) => {},
    __host_pipe: (ptr) => {
      const memory = memoryGetter();
      const pipe = new MemoryPipe();
      pipe.writeRefs = 1;
      const readFd = nextPipeFd++;
      const writeFd = nextPipeFd++;
      pipeFiles.set(readFd, { fd: readFd, pipe, isPipeRead: true });
      pipeFiles.set(writeFd, { fd: writeFd, pipe, isPipeWrite: true });
      const view = new DataView(memory.buffer);
      view.setInt32(ptr, readFd, true);
      view.setInt32(ptr + 4, writeFd, true);
      return 0;
    },
    __host_dup: (fd, minfd) => {
      if (!pipeFiles.has(fd)) return -1;
      const orig = pipeFiles.get(fd);
      if (orig.isPipeWrite && orig.pipe) orig.pipe.writeRefs++;
      const startFd = typeof minfd === 'number' && minfd > nextPipeFd ? minfd : nextPipeFd;
      const newFd = startFd;
      nextPipeFd = startFd + 1;
      pipeFiles.set(newFd, { ...orig, fd: newFd });
      return newFd;
    },
    __host_dup2: (oldfd, newfd) => {
      if (pipeFiles.has(newfd)) {
        const prev = pipeFiles.get(newfd);
        if (prev && prev.isPipeWrite && prev.pipe) {
          prev.pipe.writeRefs--;
          if (prev.pipe.writeRefs <= 0) prev.pipe.close();
        }
        pipeFiles.delete(newfd);
      }
      if (pipeFiles.has(oldfd)) {
        const orig = pipeFiles.get(oldfd);
        if (orig.isPipeWrite && orig.pipe) orig.pipe.writeRefs++;
        pipeFiles.set(newfd, { ...orig, fd: newfd });
        return newfd;
      }
      return newfd;
    },
    __host_winsize: (rPtr, cPtr) => {
      const memory = memoryGetter();
      const view = new DataView(memory.buffer);
      view.setInt32(rPtr, 24, true); // 24 rows
      view.setInt32(cPtr, 80, true); // 80 columns
    },
    __host_winch: () => 0,
    __host_interrupt: () => interruptSeq,
    __host_builtin_lookup: (namePtr, len) => 0,
    __host_builtin_name: (index, bufPtr, len) => 0,
    __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => 127,
    wasi_host_spawn: (cmdPtr, argvPtr, envpPtr) => 127,
  };
}
```
