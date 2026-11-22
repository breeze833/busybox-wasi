import assert from 'node:assert';
import {
  MemoryPipe,
  readCString,
  createBusyboxBridge,
  wrapWasiPipes,
  attachBusybox,
  createBusyboxHostOptions,
} from '../src/host.js';

console.log('Testing busybox-wasi host composition & helpers...');

// 1. attachBusybox defaults, custom overrides, and preservation of existing fields
{
  const host = { existingProp: 'keep', rows: 40 };
  const ret = attachBusybox(host, {
    cols: 120,
    hostBuiltinLookup: (name) => name === 'foo',
    hostBuiltinRun: ({ argv }) => argv.length,
    isInterrupted: () => true,
  });

  assert.strictEqual(ret, host);
  assert.strictEqual(host.existingProp, 'keep');
  assert.strictEqual(host.rows, 40);
  assert.strictEqual(host.cols, 120);
  assert.strictEqual(host.winchFlag, 0);
  assert.strictEqual(host.interruptToken, 0);
  assert.strictEqual(host.interruptSeq, 0);
  assert.strictEqual(host.hostBuiltinLookup('foo'), true);
  assert.strictEqual(host.hostBuiltinRun({ argv: ['a', 'b'] }), 2);
  assert.strictEqual(host.isInterrupted(), true);
  assert.strictEqual(host.onTrace, null);

  const defaultHost = attachBusybox({});
  assert.strictEqual(defaultHost.rows, 24);
  assert.strictEqual(defaultHost.cols, 80);
  console.log('  ✓ attachBusybox defaults, overrides, and field preservation');
}

// 2. readCString over SharedArrayBuffer-backed WebAssembly.Memory
{
  const sabMem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const text = 'hello 世界\0';
  const encoded = new TextEncoder().encode(text);
  new Uint8Array(sabMem.buffer, 128, encoded.length).set(encoded);

  assert.strictEqual(readCString(sabMem, 128), 'hello 世界');
  assert.strictEqual(readCString(sabMem, 0), '');
  console.log('  ✓ readCString SharedArrayBuffer UTF-8 decoding');
}

// 3. createBusyboxHostOptions composes wasiWrapper + envProvider without subclassing
{
  const mem = new WebAssembly.Memory({ initial: 1 });
  let userWrapperCalled = 0;
  let userEnvCalled = 0;

  const composed = createBusyboxHostOptions({
    cwd: '/workspace',
    systemDirs: ['/dev', '/usr'],
    rows: 30,
    cols: 100,
    winchFlag: 1,
    interruptToken: 7,
    builtins: {
      ping: ({ argv }) => argv.length,
    },
    wasiWrapper: (wasi) => {
      userWrapperCalled++;
      return { ...wasi, customWrapped: true };
    },
    envProvider: () => {
      userEnvCalled++;
      return { customEnvFn: () => 42 };
    },
  });

  // Base WasiHost options stay separated from BusyBox fields
  assert.strictEqual(composed.cwd, '/workspace');
  assert.deepStrictEqual(composed.systemDirs, ['/dev', '/usr']);
  assert.strictEqual('rows' in composed, false);
  assert.strictEqual('builtins' in composed, false);

  // Simulate WasiHost instance calling wasiWrapper + envProvider
  const mockHost = {
    openFiles: new Map(),
    mem: () => mem,
    allocateFd: (() => {
      let next = 10;
      return () => next++;
    })(),
  };

  let baseReadCalls = 0;
  const wrappedWasi = composed.wasiWrapper(
    {
      fd_read: () => {
        baseReadCalls++;
        return 0;
      },
      fd_write: () => 0,
      fd_close: () => 0,
      fd_renumber: () => 0,
    },
    mockHost
  );
  const envImports = composed.envProvider(mockHost);

  assert.strictEqual(userWrapperCalled, 1);
  assert.strictEqual(userEnvCalled, 1);
  assert.strictEqual(wrappedWasi.customWrapped, true);
  assert.strictEqual(envImports.customEnvFn(), 42);
  assert.strictEqual(mockHost.rows, 30);
  assert.strictEqual(mockHost.cols, 100);

  // Verify __host_winsize / __host_winch / __host_interrupt
  envImports.__host_winsize(64, 68);
  const dv = new DataView(mem.buffer);
  assert.strictEqual(dv.getInt32(64, true), 30);
  assert.strictEqual(dv.getInt32(68, true), 100);
  assert.strictEqual(envImports.__host_winch(), 1);
  assert.strictEqual(envImports.__host_winch(), 0);
  assert.strictEqual(envImports.__host_interrupt(), 7);

  // Verify repeated envProvider/wasiWrapper calls do not clobber runtime winchFlag reset
  composed.envProvider(mockHost);
  assert.strictEqual(mockHost.winchFlag, 0);

  // Verify pipe creation + wrapped fd_write / fd_read / fd_close
  const pipeRet = envImports.__host_pipe(128);
  assert.strictEqual(pipeRet, 0);
  const rfd = dv.getInt32(128, true);
  const wfd = dv.getInt32(132, true);

  const msg = new TextEncoder().encode('pipe-ok');
  new Uint8Array(mem.buffer, 256, msg.length).set(msg);
  dv.setUint32(300, 256, true);
  dv.setUint32(304, msg.length, true);
  assert.strictEqual(wrappedWasi.fd_write(wfd, 300, 1, 320), 0);
  assert.strictEqual(dv.getUint32(320, true), msg.length);
  assert.strictEqual(wrappedWasi.fd_close(wfd), 0);

  dv.setUint32(340, 400, true);
  dv.setUint32(344, 16, true);
  assert.strictEqual(wrappedWasi.fd_read(rfd, 340, 1, 360), 0);
  const bytesRead = dv.getUint32(360, true);
  assert.strictEqual(bytesRead, msg.length);
  assert.strictEqual(new TextDecoder().decode(new Uint8Array(mem.buffer, 400, bytesRead)), 'pipe-ok');
  assert.strictEqual(wrappedWasi.fd_close(rfd), 0);

  // Fallback to wrapped base fd_read on non-pipe fd
  assert.strictEqual(wrappedWasi.fd_read(0, 340, 1, 360), 0);
  assert.strictEqual(baseReadCalls, 1);

  console.log('  ✓ createBusyboxHostOptions wrapper chaining and pipe routing');
}

console.log('All busybox-wasi host composition tests passed!');
