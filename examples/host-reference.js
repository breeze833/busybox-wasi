#!/usr/bin/env node
/**
 * Standalone Reference Implementation of WASI Host-Assisted Functions for busybox-wasi.
 *
 * This file provides a complete, production-grade reference implementation of all
 * host-assisted functions required by busybox-wasi under the WebAssembly `env` namespace,
 * powered by the modular browser-safe engine in `src/host.js`:
 *
 *   1. In-Memory Pipes & Ref-Counting:
 *      - MemoryPipe
 *      - __host_pipe(ptr)
 *      - __host_dup(fd, minfd)
 *      - __host_dup2(oldfd, newfd)
 *   2. Host Builtin Command Dispatch:
 *      - __host_builtin_lookup(namePtr, len)
 *      - __host_builtin_name(index, bufPtr, len)
 *      - __host_builtin_run(cwdPtr, argc, argvPtr, envpPtr)
 *   3. Host Process Spawn:
 *      - wasi_host_spawn(cmdPtr, argvPtr, envpPtr)
 *   4. Terminal Control & Geometry:
 *      - __host_winsize(rPtr, cPtr)
 *      - __host_winch()
 *   5. Process Interruption & Signals:
 *      - __host_interrupt()
 *      - __host_trace(id)
 *   6. Socket Stubs:
 *      - __host_sock_*()
 *
 * Usage:
 *   node examples/host-reference.js
 */

import { WASI } from 'node:wasi';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MemoryPipe,
  createBusyboxBridge,
  wrapWasiPipes,
  readCString,
  readCStringArray
} from '../src/host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// BusyBoxHost: Complete Reference WASI Preview 1 Host Bridge
// ============================================================================

export class BusyBoxHost {
  /**
   * @param {Object} options
   * @param {string} [options.cwd] Current working directory (defaults to process.cwd())
   * @param {Object} [options.env] Environment variables map (defaults to process.env)
   * @param {number} [options.rows=24] Terminal row count for __host_winsize
   * @param {number} [options.cols=80] Terminal column count for __host_winsize
   * @param {Function} [options.stdout] Custom stdout callback: (str) => void
   * @param {Function} [options.stderr] Custom stderr callback: (str) => void
   * @param {Object.<string, Function>} [options.builtins] Map of host command handlers:
   *   name -> ({ cwd, argc, argv, envp, host }) => exitCode
   */
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || { ...process.env };
    this.rows = options.rows || 24;
    this.cols = options.cols || 80;
    this.stdout = options.stdout || null;
    this.stderr = options.stderr || null;
    this.interruptSeq = 0;
    this.winchFlag = 0;

    // Descriptors table: maps fd -> { fd, pipe, isPipeRead, isPipeWrite, isStdio, stdioFd }
    this.openFiles = new Map();
    this.nextPipeFd = 500;

    // Initialize standard streams (0: stdin, 1: stdout, 2: stderr)
    this.openFiles.set(0, { fd: 0, isStdio: true, stdioFd: 0, canRead: true, canWrite: false });
    this.openFiles.set(1, { fd: 1, isStdio: true, stdioFd: 1, canRead: false, canWrite: true });
    this.openFiles.set(2, { fd: 2, isStdio: true, stdioFd: 2, canRead: false, canWrite: true });

    // Host builtin command registry
    this.builtins = new Map();

    // Register default reference host builtins
    this.registerBuiltin('host_echo', ({ argv }) => {
      const text = `[host_echo] ${argv.slice(1).join(' ')}\n`;
      if (this.stdout) this.stdout(text);
      else process.stdout.write(text);
      return 0;
    });

    this.registerBuiltin('time', ({ argv, cwd }) => {
      const subArgs = argv.slice(1);
      if (subArgs.length === 0) {
        const out = 'real\t0m0.000s\r\nuser\t0m0.000s\r\nsys\t0m0.000s\r\n';
        if (this.stderr) this.stderr(out);
        else process.stderr.write(out);
        return 0;
      }
      const t0 = performance.now();
      const cliScript = path.join(__dirname, '..', 'bin', 'cli.js');
      const res = spawnSync(process.execPath, [cliScript, ...subArgs], {
        cwd,
        stdio: 'inherit',
        shell: false
      });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
      const statOut = `\r\nreal\t0m${elapsed}s\r\nuser\t0m0.000s\r\nsys\t0m0.000s\r\n`;
      if (this.stderr) this.stderr(statOut);
      else process.stderr.write(statOut);
      return res.status !== null ? res.status : 0;
    });

    if (options.builtins) {
      for (const [name, fn] of Object.entries(options.builtins)) {
        this.registerBuiltin(name, fn);
      }
    }

    this.memory = null;
  }

  setMemory(mem) {
    this.memory = mem;
  }

  registerBuiltin(name, handler) {
    this.builtins.set(name, handler);
  }

  triggerInterrupt() {
    this.interruptSeq++;
  }

  setWindowSize(rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.winchFlag = 1;
  }

  readCString(ptr) {
    return readCString(this.memory, ptr);
  }

  readCStringArray(ptr) {
    return readCStringArray(this.memory, ptr);
  }

  /**
   * Builds the complete WebAssembly import object, binding standard WASI Preview 1
   * syscalls alongside the `env` host-assisted functions.
   *
   * @param {Object} wasiInstance Standard WASI instance (e.g. from `node:wasi`)
   * @returns {Object} Complete WebAssembly import object
   */
  createImportObject(wasiInstance) {
    const wasiImports = wasiInstance ? wasiInstance.getImportObject() : { wasi_snapshot_preview1: {} };
    const wrappedWasi = wrapWasiPipes(wasiImports.wasi_snapshot_preview1, this);

    // If custom stdout is set, intercept fd_write for stdout
    if (this.stdout) {
      const origWrite = wrappedWasi.fd_write;
      wrappedWasi.fd_write = (fd, iovs, iovs_len, nwritten_out) => {
        if (this.openFiles.has(fd)) {
          const file = this.openFiles.get(fd);
          if (file.isStdio && (fd === 1 || file.stdioFd === 1)) {
            const u32 = new Uint32Array(this.memory.buffer);
            const u8 = new Uint8Array(this.memory.buffer);
            let total = 0;
            let text = '';
            for (let i = 0; i < iovs_len; i++) {
              const ptr = u32[(iovs >> 2) + i * 2];
              const len = u32[(iovs >> 2) + i * 2 + 1];
              if (len <= 0) continue;
              text += Buffer.from(u8.subarray(ptr, ptr + len)).toString('utf-8');
              total += len;
            }
            u32[nwritten_out >> 2] = total;
            this.stdout(text);
            return 0;
          }
        }
        return origWrite(fd, iovs, iovs_len, nwritten_out);
      };
    }

    const envImports = createBusyboxBridge(this);

    return {
      wasi_snapshot_preview1: wrappedWasi,
      env: envImports,
    };
  }

  /**
   * Convenience helper to run a command or ash script via busybox.wasm.
   *
   * @param {string} wasmPath Path to compiled busybox.wasm
   * @param {string[]} args Command arguments (e.g. ['sh', '-c', 'echo hello'])
   * @returns {number} Exit code
   */
  run(wasmPath, args) {
    const wasi = new WASI({
      version: 'preview1',
      args: ['busybox', ...args],
      env: this.env,
      preopens: {
        '.': this.cwd,
        '/tmp': '/tmp',
      },
    });

    const wasmBuffer = fs.readFileSync(wasmPath);
    const wasmModule = new WebAssembly.Module(wasmBuffer);
    const importObject = this.createImportObject(wasi);

    const instance = new WebAssembly.Instance(wasmModule, importObject);
    if (instance.exports.memory) {
      this.setMemory(instance.exports.memory);
    }

    try {
      const exitCode = wasi.start(instance);
      return typeof exitCode === 'number' ? exitCode : 0;
    } catch (err) {
      if (err && typeof err.code === 'number') {
        return err.code;
      }
      throw err;
    }
  }
}

// ============================================================================
// Self-Verification Test Suite
// ============================================================================

export function main() {
  console.log('================================================================');
  console.log('   busybox-wasi Host-Assisted Functions Reference Runner        ');
  console.log('================================================================');

  const wasmPath = path.join(__dirname, '..', 'bin', 'busybox.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`[-] Error: busybox.wasm not found at ${wasmPath}. Run 'make build' first.`);
    process.exit(1);
  }

  const host = new BusyBoxHost({
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
  });

  // Test 1: MemoryPipe Basic FIFO Read/Write
  console.log('1. Verifying MemoryPipe FIFO and write-ref lifecycle...');
  const pipe = new MemoryPipe();
  pipe.writeRefs = 1;
  assert.strictEqual(pipe.write(new TextEncoder().encode('Hello ')), 6);
  assert.strictEqual(pipe.write(new TextEncoder().encode('Pipe!')), 5);
  assert.strictEqual(pipe.totalLen, 11);

  const chunk1 = pipe.read(6);
  assert.strictEqual(new TextDecoder().decode(chunk1), 'Hello ');
  assert.strictEqual(pipe.totalLen, 5);

  const chunk2 = pipe.read(10);
  assert.strictEqual(new TextDecoder().decode(chunk2), 'Pipe!');
  assert.strictEqual(pipe.totalLen, 0);

  pipe.writeRefs--;
  if (pipe.writeRefs <= 0) pipe.close();
  assert.strictEqual(pipe.closed, true);
  console.log('  [PASS] MemoryPipe read/write and ref-counting verified.');

  // Test 2: In-Memory Pipe Command Substitution in ash ($(...))
  console.log('2. Verifying in-memory command substitution via __host_pipe & dup...');
  let capturedOut = '';
  host.stdout = (str) => { capturedOut += str; };

  const rc1 = host.run(wasmPath, ['sh', '-c', 'MSG=$(echo "hello from subshell"); echo "SUB: $MSG"']);
  assert.strictEqual(rc1, 0);
  assert.strictEqual(capturedOut.trim(), 'SUB: hello from subshell');
  console.log('  [PASS] In-memory pipe command substitution $(...) verified.');

  // Test 3: Pipelines across applets (cmd1 | cmd2)
  console.log('3. Verifying pipelines via __host_pipe (echo | grep)...');
  capturedOut = '';
  const rc2 = host.run(wasmPath, ['sh', '-c', 'printf "banana\\napple\\ncherry\\n" | grep "app"']);
  assert.strictEqual(rc2, 0);
  assert.strictEqual(capturedOut.trim(), 'apple');
  console.log('  [PASS] Pipeline execution via MemoryPipe verified.');

  // Test 4: Host Builtin Dispatch (__host_builtin_run)
  console.log('4. Verifying host builtin command execution and dispatch...');
  host.registerBuiltin('custom_cmd', ({ argv }) => {
    capturedOut += `[custom_cmd_invoked: ${argv.slice(1).join(',')}]\n`;
    return 42;
  });

  capturedOut = '';
  const rc3 = host.run(wasmPath, ['sh', '-c', 'custom_cmd a b c; echo "exit=$?"']);
  assert.strictEqual(rc3, 0);
  assert.ok(capturedOut.includes('[custom_cmd_invoked: a,b,c]'));
  assert.ok(capturedOut.includes('exit=42'));
  console.log('  [PASS] Host builtin registration, parameter forwarding, and exit code propagation verified.');

  // Test 5: Builtin Type Resolution
  console.log('5. Verifying host builtin classification in ash...');
  capturedOut = '';
  const rc4 = host.run(wasmPath, ['sh', '-c', 'type custom_cmd; type time; type echo']);
  assert.strictEqual(rc4, 0);
  assert.ok(capturedOut.includes('custom_cmd is a host builtin'));
  assert.ok(capturedOut.includes('time is a host builtin'));
  assert.ok(capturedOut.includes('echo is a shell builtin'));
  console.log('  [PASS] Host builtin classification via `type` verified.');

  // Test 6: Terminal Window Size Bridge (__host_winsize)
  console.log('6. Verifying terminal geometry bridge (__host_winsize)...');
  host.setWindowSize(40, 120);
  capturedOut = '';
  const rc5 = host.run(wasmPath, ['stty', 'size']);
  assert.strictEqual(rc5, 0);
  assert.strictEqual(capturedOut.trim(), '40 120');
  console.log('  [PASS] Terminal dimensions 40x120 correctly returned by stty size.');

  console.log('================================================================');
  console.log('   All Reference Host Implementation Tests PASSED Successfully! ');
  console.log('================================================================');
}

export { MemoryPipe };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
