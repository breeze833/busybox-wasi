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

const importObject = wasi.getImportObject();
importObject.env = importObject.env || {};

// Wire environment imports expected by wasistubs.c
Object.assign(importObject.env, {
  __host_trace: (id) => {},
  __host_pipe: (ptr) => -1,
  __host_dup: (fd) => -1,
  __host_dup2: (oldfd, newfd) => -1,
  __host_winsize: (rPtr, cPtr) => 0,
  __host_winch: () => 0,
  __host_interrupt: () => 0,
  __host_builtin_lookup: (namePtr, len) => {
    const name = readCString(namePtr);
    // In Node runner, lookup external commands on PATH if needed
    return 0;
  },
  __host_builtin_name: (index, bufPtr, len) => 0,
  __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => {
    const argv = readCStringArray(argvPtr);
    const cwd = readCString(cwdPtr) || process.cwd();
    if (argv.length === 0) return 127;
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
