#!/usr/bin/env node
/**
 * Standalone Reference Implementation of WASI Host-Assisted Functions for busybox-wasi.
 *
 * This file provides a complete, production-grade reference implementation of all
 * host-assisted functions required by busybox-wasi under the WebAssembly `env` namespace:
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
 * It also demonstrates how to wrap standard WASI Preview 1 descriptor syscalls
 * (fd_read, fd_write, fd_close, fd_renumber) to seamlessly route between in-memory
 * pipe buffers and underlying filesystem descriptors.
 *
 * Usage:
 *   node examples/host-reference.js
 */

const { WASI } = require('node:wasi');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

// ============================================================================
// 1. MemoryPipe: FIFO In-Memory Byte Buffer with Write-Reference Counting
// ============================================================================

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
    if (this.totalLen === 0) {
      return new Uint8Array(0);
    }
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

// ============================================================================
// 2. BusyBoxHost: Complete Reference WASI Preview 1 Host Bridge
// ============================================================================

class BusyBoxHost {
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
    if (!this.memory || ptr === 0) return '';
    const bytes = new Uint8Array(this.memory.buffer, ptr);
    let end = 0;
    while (bytes[end] !== 0 && end < 4096) end++;
    return Buffer.from(bytes.subarray(0, end)).toString('utf-8');
  }

  readCStringArray(ptr) {
    if (!this.memory || ptr === 0) return [];
    const view = new DataView(this.memory.buffer);
    const result = [];
    let offset = ptr;
    while (true) {
      const strPtr = view.getUint32(offset, true);
      if (strPtr === 0) break;
      result.push(this.readCString(strPtr));
      offset += 4;
    }
    return result;
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
    const origWasi = wasiImports.wasi_snapshot_preview1;

    // Wrap WASI file descriptor operations to support MemoryPipe routing
    const wrappedWasi = {
      ...origWasi,

      fd_close: (fd) => {
        if (this.openFiles.has(fd)) {
          const file = this.openFiles.get(fd);
          if (file && file.isPipeWrite && file.pipe) {
            file.pipe.writeRefs--;
            if (file.pipe.writeRefs <= 0) {
              file.pipe.close();
            }
          }
          if (fd > 2) {
            this.openFiles.delete(fd);
          }
          return 0; // ESUCCESS
        }
        return origWasi.fd_close ? origWasi.fd_close(fd) : 0;
      },

      fd_read: (fd, iovs, iovs_len, nread_out) => {
        if (this.openFiles.has(fd)) {
          const file = this.openFiles.get(fd);
          if (file.isStdio) {
            return origWasi.fd_read ? origWasi.fd_read(file.stdioFd, iovs, iovs_len, nread_out) : 0;
          }
          if (file.isPipeRead && file.pipe) {
            const u32 = new Uint32Array(this.memory.buffer);
            const u8 = new Uint8Array(this.memory.buffer);
            let total = 0;
            for (let i = 0; i < iovs_len; i++) {
              const ptr = u32[(iovs >> 2) + i * 2];
              const len = u32[(iovs >> 2) + i * 2 + 1];
              if (len <= 0) continue;
              const data = file.pipe.read(len);
              if (data.length === 0) break;
              u8.set(data, ptr);
              total += data.length;
              if (data.length < len) break;
            }
            u32[nread_out >> 2] = total;
            return 0; // ESUCCESS
          }
        }
        return origWasi.fd_read ? origWasi.fd_read(fd, iovs, iovs_len, nread_out) : 0;
      },

      fd_write: (fd, iovs, iovs_len, nwritten_out) => {
        if (this.openFiles.has(fd)) {
          const file = this.openFiles.get(fd);
          if (file.isStdio) {
            if (this.stdout && (fd === 1 || file.stdioFd === 1)) {
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
            return origWasi.fd_write ? origWasi.fd_write(file.stdioFd, iovs, iovs_len, nwritten_out) : 0;
          }
          if (file.isPipeWrite && file.pipe) {
            const u32 = new Uint32Array(this.memory.buffer);
            const u8 = new Uint8Array(this.memory.buffer);
            let total = 0;
            for (let i = 0; i < iovs_len; i++) {
              const ptr = u32[(iovs >> 2) + i * 2];
              const len = u32[(iovs >> 2) + i * 2 + 1];
              if (len <= 0) continue;
              file.pipe.write(u8.subarray(ptr, ptr + len));
              total += len;
            }
            u32[nwritten_out >> 2] = total;
            return 0; // ESUCCESS
          }
        }
        return origWasi.fd_write ? origWasi.fd_write(fd, iovs, iovs_len, nwritten_out) : 0;
      },
    };

    // Environment imports required by wasistubs.c
    const envImports = {
      __host_trace: (id) => {},

      __host_pipe: (ptr) => {
        const pipe = new MemoryPipe();
        pipe.writeRefs = 1;
        const readFd = this.nextPipeFd++;
        const writeFd = this.nextPipeFd++;
        this.openFiles.set(readFd, { fd: readFd, pipe, isPipeRead: true, canRead: true, canWrite: false });
        this.openFiles.set(writeFd, { fd: writeFd, pipe, isPipeWrite: true, canRead: false, canWrite: true });
        const view = new DataView(this.memory.buffer);
        view.setInt32(ptr, readFd, true);
        view.setInt32(ptr + 4, writeFd, true);
        return 0;
      },

      __host_dup: (fd, minfd) => {
        if (!this.openFiles.has(fd)) return -1;
        const orig = this.openFiles.get(fd);
        if (orig.isPipeWrite && orig.pipe) {
          orig.pipe.writeRefs++;
        }
        const startFd = typeof minfd === 'number' && minfd > this.nextPipeFd ? minfd : this.nextPipeFd;
        const newFd = startFd;
        this.nextPipeFd = startFd + 1;
        this.openFiles.set(newFd, { ...orig, fd: newFd });
        return newFd;
      },

      __host_dup2: (oldfd, newfd) => {
        if (this.openFiles.has(newfd)) {
          const prev = this.openFiles.get(newfd);
          if (prev && prev.isPipeWrite && prev.pipe) {
            prev.pipe.writeRefs--;
            if (prev.pipe.writeRefs <= 0) {
              prev.pipe.close();
            }
          }
          this.openFiles.delete(newfd);
        }

        if (this.openFiles.has(oldfd)) {
          const orig = this.openFiles.get(oldfd);
          if (orig.isPipeWrite && orig.pipe) {
            orig.pipe.writeRefs++;
          }
          this.openFiles.set(newfd, { ...orig, fd: newfd });
          return newfd;
        }

        // Delegate underlying filesystem file descriptor movement
        if (origWasi.fd_renumber) {
          const ret = origWasi.fd_renumber(oldfd, newfd);
          if (ret === 0) {
            this.openFiles.delete(newfd);
            return newfd;
          }
        }
        return -1;
      },

      __host_winsize: (rPtr, cPtr) => {
        const view = new DataView(this.memory.buffer);
        view.setInt32(rPtr, this.rows, true);
        view.setInt32(cPtr, this.cols, true);
      },

      __host_winch: () => {
        const flag = this.winchFlag;
        this.winchFlag = 0;
        return flag;
      },

      __host_interrupt: () => {
        return this.interruptSeq;
      },

      __host_builtin_lookup: (namePtr, len) => {
        const name = this.readCString(namePtr);
        return this.builtins.has(name) ? 1 : 0;
      },

      __host_builtin_name: (index, bufPtr, len) => {
        const names = Array.from(this.builtins.keys());
        if (index >= 0 && index < names.length) {
          const bytes = Buffer.from(names[index]);
          const copyLen = Math.min(bytes.length, len);
          new Uint8Array(this.memory.buffer, bufPtr, copyLen).set(bytes.subarray(0, copyLen));
          return copyLen;
        }
        return 0;
      },

      __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => {
        const cwd = this.readCString(cwdPtr) || this.cwd;
        const argv = this.readCStringArray(argvPtr);
        const envp = this.readCStringArray(envpPtr);
        if (argv.length === 0) return 127;

        const cmd = argv[0];
        if (this.builtins.has(cmd)) {
          const handler = this.builtins.get(cmd);
          try {
            return handler({ cwd, argc, argv, envp, host: this });
          } catch (err) {
            console.error(`Host builtin '${cmd}' failed:`, err);
            return 126;
          }
        }

        // Fallback: spawn command on host system if available
        try {
          const res = spawnSync(cmd, argv.slice(1), {
            cwd,
            stdio: 'inherit',
            shell: false
          });
          return res.status !== null ? res.status : (res.error ? 127 : 0);
        } catch {
          return 127;
        }
      },

      wasi_host_spawn: (cmdPtr, argvPtr, envpPtr) => {
        const cmd = this.readCString(cmdPtr);
        const argv = this.readCStringArray(argvPtr);
        const envp = this.readCStringArray(envpPtr);
        if (this.builtins.has(cmd)) {
          return this.builtins.get(cmd)({ cwd: this.cwd, argc: argv.length, argv, envp, host: this });
        }
        return 127;
      },

      __host_sock_open: () => -1,
      __host_sock_connect: () => -1,
      __host_sock_bind: () => -1,
      __host_sock_listen: () => -1,
      __host_sock_resolve: () => -1,
    };

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
  run(wasmPath, args = ['sh']) {
    const wasmBuffer = fs.readFileSync(wasmPath);
    const wasmModule = new WebAssembly.Module(wasmBuffer);

    const wasi = new WASI({
      version: 'preview1',
      args: ['busybox', ...args],
      env: this.env,
      preopens: {
        '.': this.cwd,
        '/tmp': '/tmp'
      }
    });

    const imports = this.createImportObject(wasi);
    const instance = new WebAssembly.Instance(wasmModule, imports);

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
// 3. Self-Test & Interactive Demonstration
// ============================================================================

function main() {
  const wasmPath = path.resolve(__dirname, '..', 'bin', 'busybox.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`Error: busybox.wasm not found at ${wasmPath}. Please build it first.`);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('   busybox-wasi Reference Host Implementation Verification      ');
  console.log('================================================================');

  // Test 1: In-Memory Pipe Unit Test
  console.log('1. Verifying MemoryPipe slicing & boundary handling...');
  const pipe = new MemoryPipe();
  pipe.writeRefs = 1;
  pipe.write(new Uint8Array([1, 2, 3]));
  pipe.write(new Uint8Array([4, 5, 6, 7]));
  assert.strictEqual(pipe.totalLen, 7);

  const chunk1 = pipe.read(2);
  assert.deepStrictEqual(Array.from(chunk1), [1, 2]);

  // Read across chunk boundary (element 3 from chunk 0, elements 4 & 5 from chunk 1)
  const chunk2 = pipe.read(3);
  assert.deepStrictEqual(Array.from(chunk2), [3, 4, 5]);

  const chunk3 = pipe.read(10);
  assert.deepStrictEqual(Array.from(chunk3), [6, 7]);
  assert.strictEqual(pipe.totalLen, 0);
  console.log('  [PASS] MemoryPipe boundary slicing verified.');

  // Test 2: Standard Multicall Applet Execution via Host
  console.log('2. Verifying multicall execution via BusyBoxHost...');
  let capturedOut = '';
  const host = new BusyBoxHost({
    stdout: (str) => { capturedOut += str; }
  });
  const rc1 = host.run(wasmPath, ['printf', '%s %d\\n', 'test_arg', '123']);
  assert.strictEqual(rc1, 0);
  assert.strictEqual(capturedOut.trim(), 'test_arg 123');
  console.log('  [PASS] Applet printf output captured via host stdout bridge.');

  // Test 3: Ash Scripting, In-Process Command Substitution & Pipelines
  console.log('3. Verifying fork-free command substitution $(...) & pipelines...');
  capturedOut = '';
  const rc2 = host.run(wasmPath, [
    'sh',
    '-c',
    'OUT=$(printf "banana\\napple\\ncherry\\n" | sort); echo "SORTED: $OUT"'
  ]);
  assert.strictEqual(rc2, 0);
  assert.ok(capturedOut.includes('SORTED: apple\nbanana\ncherry'));
  console.log('  [PASS] Fork-free subshell $(...) with MemoryPipe ref-counting verified.');

  // Test 4: Custom Host Builtins (host_echo & custom callback)
  console.log('4. Verifying host builtin dispatch (__host_builtin_lookup / run)...');
  capturedOut = '';
  host.registerBuiltin('custom_cmd', ({ argv }) => {
    capturedOut += `[custom_cmd_invoked: ${argv.slice(1).join(',')}]\n`;
    return 42;
  });

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

// Export classes for external consumer projects
module.exports = {
  MemoryPipe,
  BusyBoxHost,
};

// Execute self-test if run directly
if (require.main === module) {
  main();
}
