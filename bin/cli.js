#!/usr/bin/env node

const { WASI } = require('node:wasi');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const wasmPath = path.join(__dirname, 'busybox.wasm');

if (!fs.existsSync(wasmPath)) {
  console.error(`Error: busybox.wasm not found at ${wasmPath}.`);
  console.error('Please build busybox.wasm first (e.g. npm run build).');
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
let appletArgs = rawArgs.length > 0 ? ['busybox', ...rawArgs] : ['busybox', 'sh'];

// Setup WASI with current working directory mapped
const wasi = new WASI({
  version: 'preview1',
  args: appletArgs,
  env: process.env,
  preopens: {
    '.': process.cwd(),
    '/tmp': '/tmp'
  }
});

const wasmBuffer = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBuffer);

let memory = null;

function readCString(ptr) {
  if (!memory || ptr === 0) return '';
  const bytes = new Uint8Array(memory.buffer, ptr);
  let end = 0;
  while (bytes[end] !== 0 && end < 4096) end++;
  return Buffer.from(bytes.subarray(0, end)).toString('utf-8');
}

function readCStringArray(ptr) {
  if (!memory || ptr === 0) return [];
  const view = new DataView(memory.buffer);
  const result = [];
  let offset = ptr;
  while (true) {
    const strPtr = view.getUint32(offset, true);
    if (strPtr === 0) break;
    result.push(readCString(strPtr));
    offset += 4;
  }
  return result;
}

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

const pipeFiles = new Map();
pipeFiles.set(0, { fd: 0, isStdio: true, stdioFd: 0, canRead: true, canWrite: false });
pipeFiles.set(1, { fd: 1, isStdio: true, stdioFd: 1, canRead: false, canWrite: true });
pipeFiles.set(2, { fd: 2, isStdio: true, stdioFd: 2, canRead: false, canWrite: true });
let nextPipeFd = 500;

const importObject = wasi.getImportObject();
importObject.env = importObject.env || {};

const orig_fd_close = importObject.wasi_snapshot_preview1.fd_close.bind(importObject.wasi_snapshot_preview1);
const orig_fd_read = importObject.wasi_snapshot_preview1.fd_read.bind(importObject.wasi_snapshot_preview1);
const orig_fd_write = importObject.wasi_snapshot_preview1.fd_write.bind(importObject.wasi_snapshot_preview1);
const orig_fd_renumber = importObject.wasi_snapshot_preview1.fd_renumber.bind(importObject.wasi_snapshot_preview1);

importObject.wasi_snapshot_preview1.fd_close = (fd) => {
  if (pipeFiles.has(fd)) {
    const file = pipeFiles.get(fd);
    if (file && file.isPipeWrite && file.pipe) {
      file.pipe.writeRefs--;
      if (file.pipe.writeRefs <= 0) {
        file.pipe.close();
      }
    }
    if (fd > 2) {
      pipeFiles.delete(fd);
    }
    return 0;
  }
  return orig_fd_close(fd);
};

importObject.wasi_snapshot_preview1.fd_read = (fd, iovs, iovs_len, nread_out) => {
  if (pipeFiles.has(fd)) {
    const file = pipeFiles.get(fd);
    if (file.isStdio) {
      return orig_fd_read(file.stdioFd, iovs, iovs_len, nread_out);
    }
    if (file.isPipeRead && file.pipe) {
      const u32 = new Uint32Array(memory.buffer);
      const u8 = new Uint8Array(memory.buffer);
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
      return 0;
    }
  }
  return orig_fd_read(fd, iovs, iovs_len, nread_out);
};

importObject.wasi_snapshot_preview1.fd_write = (fd, iovs, iovs_len, nwritten_out) => {
  if (pipeFiles.has(fd)) {
    const file = pipeFiles.get(fd);
    if (file.isStdio) {
      return orig_fd_write(file.stdioFd, iovs, iovs_len, nwritten_out);
    }
    if (file.isPipeWrite && file.pipe) {
      const u32 = new Uint32Array(memory.buffer);
      const u8 = new Uint8Array(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const ptr = u32[(iovs >> 2) + i * 2];
        const len = u32[(iovs >> 2) + i * 2 + 1];
        if (len <= 0) continue;
        file.pipe.write(u8.subarray(ptr, ptr + len));
        total += len;
      }
      u32[nwritten_out >> 2] = total;
      return 0;
    }
  }
  return orig_fd_write(fd, iovs, iovs_len, nwritten_out);
};

// Wire environment imports expected by wasistubs.c
Object.assign(importObject.env, {
  __host_trace: (id) => {},
  __host_pipe: (ptr) => {
    const pipe = new MemoryPipe();
    pipe.writeRefs = 1;
    const readFd = nextPipeFd++;
    const writeFd = nextPipeFd++;
    pipeFiles.set(readFd, { fd: readFd, pipe, isPipeRead: true, canRead: true, canWrite: false });
    pipeFiles.set(writeFd, { fd: writeFd, pipe, isPipeWrite: true, canRead: false, canWrite: true });
    const view = new DataView(memory.buffer);
    view.setInt32(ptr, readFd, true);
    view.setInt32(ptr + 4, writeFd, true);
    return 0;
  },
  __host_dup: (fd, minfd) => {
    if (!pipeFiles.has(fd)) return -1;
    const orig = pipeFiles.get(fd);
    if (orig.isPipeWrite && orig.pipe) {
      orig.pipe.writeRefs++;
    }
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
        if (prev.pipe.writeRefs <= 0) {
          prev.pipe.close();
        }
      }
      pipeFiles.delete(newfd);
    }
    if (pipeFiles.has(oldfd)) {
      const orig = pipeFiles.get(oldfd);
      if (orig.isPipeWrite && orig.pipe) {
        orig.pipe.writeRefs++;
      }
      pipeFiles.set(newfd, { ...orig, fd: newfd });
      return newfd;
    }
    const ret = orig_fd_renumber(oldfd, newfd);
    if (ret === 0) {
      pipeFiles.delete(newfd);
      return newfd;
    }
    return -1;
  },
  __host_winsize: (rPtr, cPtr) => 0,
  __host_winch: () => 0,
  __host_interrupt: () => 0,
  __host_builtin_lookup: (namePtr, len) => {
    const name = readCString(namePtr);
    if (name === 'time' || name === 'host_echo') {
      return 1;
    }
    return 0;
  },
  __host_builtin_name: (index, bufPtr, len) => {
    const builtins = ['time', 'host_echo'];
    if (index >= 0 && index < builtins.length) {
      const bytes = Buffer.from(builtins[index]);
      const copyLen = Math.min(bytes.length, len);
      new Uint8Array(memory.buffer, bufPtr, copyLen).set(bytes.subarray(0, copyLen));
      return copyLen;
    }
    return 0;
  },
  __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => {
    const argv = readCStringArray(argvPtr);
    const cwd = readCString(cwdPtr) || process.cwd();
    if (argv.length === 0) return 127;
    const cmd = argv[0];

    if (cmd === 'host_echo') {
      const out = argv.slice(1).join(' ');
      process.stdout.write(`[host_echo] ${out}\n`);
      return 0;
    }

    if (cmd === 'time') {
      const subArgs = argv.slice(1);
      if (subArgs.length === 0) {
        process.stderr.write('real\t0m0.000s\r\nuser\t0m0.000s\r\nsys\t0m0.000s\r\n');
        return 0;
      }
      const t0 = performance.now();
      const res = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...subArgs], {
        cwd,
        stdio: 'inherit',
        shell: false
      });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
      process.stderr.write(`\r\nreal\t0m${elapsed}s\r\nuser\t0m0.000s\r\nsys\t0m0.000s\r\n`);
      return res.status !== null ? res.status : 0;
    }

    try {
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd,
        stdio: 'inherit',
        shell: false
      });
      return res.status !== null ? res.status : (res.error ? 127 : 0);
    } catch {
      return 127;
    }
  },
  __host_sock_open: () => -1,
  __host_sock_connect: () => -1,
  __host_sock_bind: () => -1,
  __host_sock_listen: () => -1,
  __host_sock_resolve: () => -1,
});

const instance = new WebAssembly.Instance(wasmModule, importObject);
if (instance.exports.memory) {
  memory = instance.exports.memory;
}

try {
  const exitCode = wasi.start(instance);
  if (typeof exitCode === 'number') {
    process.exit(exitCode);
  }
} catch (err) {
  if (err && typeof err.code === 'number') {
    process.exit(err.code);
  }
  throw err;
}
