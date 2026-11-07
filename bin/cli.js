#!/usr/bin/env node

import { WASI } from 'node:wasi';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBusyboxBridge, wrapWasiPipes } from '../src/host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
const openFiles = new Map();
openFiles.set(0, { fd: 0, isStdio: true, stdioFd: 0, canRead: true, canWrite: false });
openFiles.set(1, { fd: 1, isStdio: true, stdioFd: 1, canRead: false, canWrite: true });
openFiles.set(2, { fd: 2, isStdio: true, stdioFd: 2, canRead: false, canWrite: true });

const hostContext = {
  getMemory: () => memory,
  openFiles,
  nextPipeFd: 500,
  cwd: process.cwd(),
  getRows: () => process.stdout.rows || 24,
  getCols: () => process.stdout.columns || 80,
  builtins: {
    host_echo: ({ argv }) => {
      const out = argv.slice(1).join(' ');
      process.stdout.write(`[host_echo] ${out}\n`);
      return 0;
    },
    time: ({ argv, cwd }) => {
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
  },
  hostBuiltinRun: ({ argv, cwd }) => {
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
  }
};

const rawImports = wasi.getImportObject();
hostContext.origWasi = rawImports.wasi_snapshot_preview1;
const wrappedWasi = wrapWasiPipes(rawImports.wasi_snapshot_preview1, hostContext);
const envImports = createBusyboxBridge(hostContext);

const importObject = {
  wasi_snapshot_preview1: wrappedWasi,
  env: envImports
};

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
