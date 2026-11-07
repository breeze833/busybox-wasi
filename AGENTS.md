# AGENTS.md: Developer and AI Agent Guidelines for `busybox-wasi`

This document provides architectural context, design invariants, coding conventions, and maintenance procedures for AI agents and human contributors working on `busybox-wasi`.

---

## 1. Project Mission & Architecture

`busybox-wasi` compiles BusyBox to WebAssembly targeting the **WASI Preview 1 (`wasm32-wasip1`)** environment.

It provides a single unified multicall binary (`busybox.wasm`) featuring the `ash` POSIX shell alongside essential Unix text-processing and core utilities, specifically tailored for browser IDEs (like `wasm-c-ide`) and sandboxed WebAssembly environments.

---

## 2. Core Design Invariants

When modifying or extending the codebase, strictly adhere to these fundamental invariants:

1. **Strict Specification Alignment**:
   - `SPEC.md` is the ground truth. Autonomous agents must strictly adhere to the architecture, build pipeline, and WASI host specifications defined in `SPEC.md`. Do not deviate, substitute architectures, or introduce Emscripten wrappers.
2. **Zero-Dependency Runtime**:
   - The compiled `busybox.wasm` binary and accompanying Node.js runner (`bin/cli.js`) must remain zero-dependency standard WebAssembly / WASI.
3. **Single-Threaded WASI Preview 1 (`wasm32-wasip1`)**:
   - Target execution is pure WASI Preview 1. Multithreading must not be enabled; do not require `wasm32-wasi-threads` or shared memory.
4. **Clean Upstream Separation**:
   - Upstream BusyBox source code must be fetched and patched cleanly during the build. All platform adjustments must be formalized in `patches/` and `src/`.
5. **Host-Assisted Process Execution**:
   - When running under `ash`, external commands (e.g. `clang`, `./a.out`) must route through the declared host import (`wasi_host_spawn`) without crashing or assuming kernel `fork()`/`exec()`.
6. **Lean Applet Footprint**:
   - Do not bloat `busybox.wasm` with networking, administrative, or kernel daemon applets. Keep binary size strictly optimized (< 2 MB uncompressed).

---

## 3. Developer Collaboration & Revision Workflow

All agent-assisted development in this repository must strictly adhere to the developer's 4-phase revision workflow:

```
┌──────────────────────────────────────────────────────────────┐
│  Phase 1: Specification Revision & Developer Confirmation     │
│  - Propose/update SPEC.md changes first                      │
│  - Await explicit developer review & approval                │
└──────────────────────────────┬───────────────────────────────┘
                               │ Approved
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 2: Specification-Compliant Implementation             │
│  - Strictly implement according to the confirmed SPEC.md     │
│  - Verify automated tests (npm test) with zero failures      │
└──────────────────────────────┬───────────────────────────────┘
                               │ Verified
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 3: Developer Manual Verification                      │
│  - Prompt developer to perform interactive verification      │
│  - Developer tests applets & ash scripts via bin/cli.js      │
└──────────────────────────────┬───────────────────────────────┘
                               │ Developer Confirmed
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 4: Explicitly Instructed Document Alignment & Commit  │
│  - Await developer's explicit instruction                    │
│  - Align secondary docs (README.md, package.json, etc.)      │
│  - Stage and commit changes to git repository                │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Directory Structure & Key Files

```
busybox-wasi/
├── SPEC.md                    # Technical specification & architectural ground truth
├── AGENTS.md                  # Developer & AI agent operating protocols (this file)
├── README.md                  # User-facing documentation and quick start
├── LICENSE                    # GPLv2 & MIT licenses
├── package.json               # Package metadata and test scripts
├── Makefile                   # Build, test, clean, and release targets
├── configs/
│   └── wasi_defconfig         # Tailored BusyBox Kconfig for wasm32-wasip1
├── patches/
│   └── busybox-wasi-1.37.0.patch # Platform patches for upstream BusyBox
├── src/
│   ├── host.js                # Browser-safe, zero-dependency host bridge module & MemoryPipe
│   └── shim/                  # WASI Preview 1 compatibility shims & setjmp runtime
├── docs/                      # Technical documentation & host architecture
│   └── HOST_FUNCTIONS.md      # Specification of WASI host-assisted functions
├── examples/                  # Reference implementations for host embeddings
│   └── host-reference.js      # Complete standalone WASI host & MemoryPipe runner
├── scripts/
│   └── build.sh               # Fetch, patch, configure, compile, and optimize
├── bin/
│   ├── busybox.wasm           # (Generated) Multicall WebAssembly binary
│   └── cli.js                 # Standalone Node.js CLI runner
├── dist/                      # (Generated) Packaged release archives
└── test/
    ├── test-applets.js        # Automated unit tests for text & file utilities
    └── test-ash.js            # Automated unit tests for ash loops & scripting
```

---

## 5. Development & Testing Commands

```bash
# Build busybox.wasm locally (requires wasi-sdk)
make build
# (or: ./scripts/build.sh)

# Run automated test suite
npm test
# (or: node test/test-applets.js && node test/test-ash.js)

# Package release tarball
make dist

# Clean build artifacts
make clean
```

---

## 6. Verification Checklist Before Committing Changes

Before completing tasks or submitting PRs, verify:

- [ ] Specification updated in `SPEC.md` and confirmed by the developer prior to code changes.
- [ ] Implementation strictly conforms to the confirmed `SPEC.md`.
- [ ] `busybox.wasm` compiles without missing symbols on `wasm32-wasip1`.
- [ ] Automated tests (`npm test`) pass with zero errors using `node:wasi`.
- [ ] Developer has conducted verification via `bin/cli.js` or target application.
- [ ] Binary size is verified and optimized with `wasm-opt -O2`.
- [ ] Secondary documentation (`README.md`, `package.json`, etc.) aligned upon explicit developer instruction.
- [ ] Git commit performed only when explicitly instructed by the developer.
