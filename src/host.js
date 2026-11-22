/**
 * Standalone, zero-dependency host bridge module for busybox-wasi.
 * Compatible with both Node.js and browser environments (Web Workers / Main Thread).
 *
 * Provides:
 *   - MemoryPipe: In-memory byte FIFO with chunk queue and write-reference counting
 *   - createBusyboxBridge(hostOrOptions): Builds WebAssembly `env` imports for BusyBox
 *   - wrapWasiPipes(origWasi, hostOrOptions): Wraps WASI fd_read, fd_write, fd_close, fd_renumber
 *   - attachBusybox(host, options): Attaches BusyBox host state onto any WasiHost instance
 *   - createBusyboxHostOptions(options): Builds composable WasiHost options without subclassing
 *   - readCString, readCStringArray: Fast SAB-safe string reading utilities
 */

const textDecoder = new TextDecoder('utf-8');
const HAS_SAB = typeof SharedArrayBuffer !== 'undefined';

export class MemoryPipe {
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

export function readCString(memory, ptr) {
  if (!memory || ptr === 0) return '';
  const buf = memory.buffer;
  const bytes = new Uint8Array(buf, ptr);
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const slice = bytes.subarray(0, end);
  if (HAS_SAB && buf instanceof SharedArrayBuffer) {
    const unshared = new Uint8Array(end);
    unshared.set(slice);
    return textDecoder.decode(unshared);
  }
  return textDecoder.decode(slice);
}

export function readCStringArray(memory, ptr) {
  if (!memory || ptr === 0) return [];
  const view = new DataView(memory.buffer);
  const result = [];
  let offset = ptr;
  while (true) {
    const strPtr = view.getUint32(offset, true);
    if (strPtr === 0) break;
    result.push(readCString(memory, strPtr));
    offset += 4;
  }
  return result;
}

/**
 * Creates the `env` import namespace for busybox-wasi.
 *
 * @param {Object} host Host instance or options object providing memory and file table access
 * @returns {Object} Environment imports dictionary for WebAssembly instantiation
 */
export function createBusyboxBridge(host = {}) {
  const getMem = () => {
    if (typeof host.mem === 'function') return host.mem();
    if (typeof host.getMemory === 'function') return host.getMemory();
    return host.memory || null;
  };

  const getOpenFiles = () => {
    if (host.openFiles instanceof Map) return host.openFiles;
    if (!host._openFiles) host._openFiles = new Map();
    return host._openFiles;
  };

  const allocateFd = (minfd = 0) => {
    if (typeof host.allocateFd === 'function') {
      return host.allocateFd(minfd);
    }
    const openFiles = getOpenFiles();
    let next = Math.max(minfd || 0, host.nextPipeFd || host.nextFd || 500);
    while (openFiles.has(next)) {
      next++;
    }
    if ('nextPipeFd' in host) host.nextPipeFd = next + 1;
    else if ('nextFd' in host) host.nextFd = next + 1;
    return next;
  };

  return {
    __host_trace: (id) => {
      if (typeof host.onTrace === 'function') host.onTrace(id);
    },

    __host_pipe: (ptr) => {
      const mem = getMem();
      if (!mem) return -1;
      const pipe = new MemoryPipe();
      pipe.writeRefs = 1;
      const readFd = allocateFd();
      const writeFd = allocateFd();
      const openFiles = getOpenFiles();

      openFiles.set(readFd, {
        fd: readFd,
        pipe,
        isPipeRead: true,
        canRead: true,
        canWrite: false,
        isDir: false,
      });
      openFiles.set(writeFd, {
        fd: writeFd,
        pipe,
        isPipeWrite: true,
        canRead: false,
        canWrite: true,
        isDir: false,
      });

      const view = new DataView(mem.buffer);
      view.setInt32(ptr, readFd, true);
      view.setInt32(ptr + 4, writeFd, true);
      return 0;
    },

    __host_dup: (fd, minfd = 0) => {
      const openFiles = getOpenFiles();
      if (!openFiles.has(fd)) return -1;
      const orig = openFiles.get(fd);
      if (orig.isPipeWrite && orig.pipe) {
        orig.pipe.writeRefs++;
      }
      const newFd = allocateFd(minfd);
      openFiles.set(newFd, { ...orig, fd: newFd });
      return newFd;
    },

    __host_dup2: (oldfd, newfd) => {
      const openFiles = getOpenFiles();

      if (openFiles.has(newfd)) {
        const prev = openFiles.get(newfd);
        if (prev && prev.isPipeWrite && prev.pipe) {
          prev.pipe.writeRefs--;
          if (prev.pipe.writeRefs <= 0) {
            prev.pipe.close();
          }
        }
        openFiles.delete(newfd);
      }

      if (openFiles.has(oldfd)) {
        const orig = openFiles.get(oldfd);
        if (orig.isPipeWrite && orig.pipe) {
          orig.pipe.writeRefs++;
        }
        openFiles.set(newfd, { ...orig, fd: newfd });
        return newfd;
      }

      // Delegate underlying filesystem file descriptor movement (e.g. node:wasi)
      const fdRenumber = host.fd_renumber || host.fdRenumber || host.origWasi?.fd_renumber;
      if (typeof fdRenumber === 'function') {
        const ret = fdRenumber(oldfd, newfd);
        if (ret === 0) {
          openFiles.delete(newfd);
          return newfd;
        }
      }

      return -1;
    },

    __host_winsize: (rPtr, cPtr) => {
      if (!rPtr || !cPtr) return 0;
      const mem = getMem();
      if (!mem) return 0;
      const rows = typeof host.getRows === 'function' ? host.getRows() : (host.rows || 24);
      const cols = typeof host.getCols === 'function' ? host.getCols() : (host.cols || 80);
      const view = new DataView(mem.buffer);
      view.setInt32(rPtr, rows, true);
      view.setInt32(cPtr, cols, true);
      return 0;
    },

    __host_winch: () => {
      if (typeof host.isWinch === 'function') {
        return host.isWinch() ? 1 : 0;
      }
      const flag = host.winchFlag || 0;
      host.winchFlag = 0;
      return flag;
    },

    __host_interrupt: () => {
      if (typeof host.isInterrupted === 'function') {
        return host.isInterrupted() ? 1 : 0;
      }
      return host.interrupted ? 1 : (host.interruptSeq || host.interruptToken || 0);
    },

    __host_builtin_lookup: (namePtr, len) => {
      const mem = getMem();
      if (!mem) return 0;
      const name = readCString(mem, namePtr);
      if (typeof host.hostBuiltinLookup === 'function') {
        return host.hostBuiltinLookup(name) ? 1 : 0;
      }
      if (host.builtins) {
        if (host.builtins instanceof Map) return host.builtins.has(name) ? 1 : 0;
        return Object.prototype.hasOwnProperty.call(host.builtins, name) ? 1 : 0;
      }
      return 0;
    },

    __host_builtin_name: (index, bufPtr, len) => {
      const mem = getMem();
      if (!mem) return 0;
      if (typeof host.hostBuiltinName === 'function') {
        const str = host.hostBuiltinName(index);
        if (!str) return 0;
        const bytes = new TextEncoder().encode(str);
        const copyLen = Math.min(bytes.length, len);
        new Uint8Array(mem.buffer, bufPtr, copyLen).set(bytes.subarray(0, copyLen));
        return copyLen;
      }
      if (host.builtins) {
        const names = host.builtins instanceof Map ? Array.from(host.builtins.keys()) : Object.keys(host.builtins);
        if (index >= 0 && index < names.length) {
          const bytes = new TextEncoder().encode(names[index]);
          const copyLen = Math.min(bytes.length, len);
          new Uint8Array(mem.buffer, bufPtr, copyLen).set(bytes.subarray(0, copyLen));
          return copyLen;
        }
      }
      return 0;
    },

    __host_builtin_run: (cwdPtr, argc, argvPtr, envpPtr) => {
      const mem = getMem();
      if (!mem) return 127;
      const cwd = readCString(mem, cwdPtr) || host.cwd || '/';
      const argv = [];
      const view = new DataView(mem.buffer);
      for (let i = 0; i < argc; i++) {
        const strPtr = view.getUint32(argvPtr + i * 4, true);
        argv.push(readCString(mem, strPtr));
      }
      const envp = readCStringArray(mem, envpPtr);

      if (host.builtins && argv.length > 0) {
        const cmd = argv[0];
        const handler = host.builtins instanceof Map ? host.builtins.get(cmd) : host.builtins[cmd];
        if (typeof handler === 'function') {
          try {
            return handler({ cwd, argc, argv, envp, host });
          } catch (err) {
            return 126;
          }
        }
      }

      if (typeof host.hostBuiltinRun === 'function') {
        return host.hostBuiltinRun({ cwd, argc, argv, envp, host });
      }

      return 127;
    },

    wasi_host_spawn: (cmdPtr, argvPtr, envpPtr) => {
      const mem = getMem();
      if (!mem) return 127;
      const cmd = readCString(mem, cmdPtr);
      const argv = readCStringArray(mem, argvPtr);
      const envp = readCStringArray(mem, envpPtr);
      const finalArgv = argv.length > 0 ? argv : [cmd];

      if (typeof host.wasiHostSpawn === 'function') {
        return host.wasiHostSpawn({ cmd, argv: finalArgv, envp, host });
      }
      if (typeof host.hostBuiltinRun === 'function') {
        return host.hostBuiltinRun({ cwd: host.cwd || '/', argc: finalArgv.length, argv: finalArgv, envp, host });
      }
      if (host.builtins) {
        const handler = host.builtins instanceof Map ? host.builtins.get(cmd) : host.builtins[cmd];
        if (typeof handler === 'function') {
          return handler({ cwd: host.cwd || '/', argc: finalArgv.length, argv: finalArgv, envp, host });
        }
      }
      return 127;
    },

    __host_sock_open: () => -1,
    __host_sock_connect: () => -1,
    __host_sock_bind: () => -1,
    __host_sock_listen: () => -1,
    __host_sock_resolve: () => -1,
  };
}

/**
 * Intercepts standard WASI Preview 1 file descriptor syscalls
 * (fd_close, fd_read, fd_write, fd_renumber) to route through MemoryPipe.
 *
 * @param {Object} origWasi Base WASI imports dictionary
 * @param {Object} host Host or options context
 * @returns {Object} Wrapped WASI imports dictionary
 */
export function wrapWasiPipes(origWasi, host = {}) {
  const getMem = () => {
    if (typeof host.mem === 'function') return host.mem();
    if (typeof host.getMemory === 'function') return host.getMemory();
    return host.memory || null;
  };

  const getOpenFiles = () => {
    if (host.openFiles instanceof Map) return host.openFiles;
    if (!host._openFiles) host._openFiles = new Map();
    return host._openFiles;
  };

  const overrides = {
    fd_close: (fd) => {
      const openFiles = getOpenFiles();
      if (openFiles.has(fd)) {
        const file = openFiles.get(fd);
        if (file && file.isPipeWrite && file.pipe) {
          file.pipe.writeRefs--;
          if (file.pipe.writeRefs <= 0) {
            file.pipe.close();
          }
        }
        if (fd > 2) {
          openFiles.delete(fd);
        }
        return 0; // ESUCCESS
      }
      return origWasi.fd_close ? origWasi.fd_close(fd) : 0;
    },

    fd_read: (fd, iovs, iovs_len, nread_out) => {
      const openFiles = getOpenFiles();
      if (openFiles.has(fd)) {
        const file = openFiles.get(fd);
        if (file.isPipeRead && file.pipe) {
          const mem = getMem();
          if (!mem) return 8; // EBADF
          const u32 = new Uint32Array(mem.buffer);
          const u8 = new Uint8Array(mem.buffer);
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
      const openFiles = getOpenFiles();
      if (openFiles.has(fd)) {
        const file = openFiles.get(fd);
        if (file.isPipeWrite && file.pipe) {
          const mem = getMem();
          if (!mem) return 8; // EBADF
          const u32 = new Uint32Array(mem.buffer);
          const u8 = new Uint8Array(mem.buffer);
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

    fd_renumber: (oldfd, newfd) => {
      const openFiles = getOpenFiles();
      if (openFiles.has(oldfd)) {
        const orig = openFiles.get(oldfd);
        openFiles.set(newfd, { ...orig, fd: newfd });
        openFiles.delete(oldfd);
        return 0; // ESUCCESS
      }
      return origWasi.fd_renumber ? origWasi.fd_renumber(oldfd, newfd) : 0;
    },
  };

  return new Proxy(origWasi, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      return target[prop];
    }
  });
}

const BUSYBOX_OPTION_KEYS = [
  'rows',
  'cols',
  'winchFlag',
  'interrupted',
  'isInterrupted',
  'interruptSeq',
  'interruptToken',
  'isWinch',
  'getRows',
  'getCols',
  'hostBuiltinLookup',
  'hostBuiltinRun',
  'hostBuiltinName',
  'wasiHostSpawn',
  'builtins',
  'onTrace',
];

/**
 * Attaches BusyBox shell/runtime properties onto any WasiHost-compatible host instance
 * without requiring a subclass.
 *
 * @param {Object} host Target host instance (e.g. `wasi-host` `WasiHost`)
 * @param {Object} [options={}] BusyBox state and callback configuration
 * @returns {Object} The mutated `host` instance
 */
export function attachBusybox(host, options = {}) {
  if (!host || typeof host !== 'object') {
    throw new TypeError('attachBusybox requires a target host object');
  }

  host.rows = options.rows !== undefined ? options.rows : (host.rows !== undefined ? host.rows : 24);
  host.cols = options.cols !== undefined ? options.cols : (host.cols !== undefined ? host.cols : 80);
  host.winchFlag = options.winchFlag !== undefined ? options.winchFlag : (host.winchFlag !== undefined ? host.winchFlag : 0);
  host.interruptToken = options.interruptToken !== undefined
    ? options.interruptToken
    : (host.interruptToken !== undefined ? host.interruptToken : 0);
  host.interruptSeq = options.interruptSeq !== undefined
    ? options.interruptSeq
    : (host.interruptSeq !== undefined ? host.interruptSeq : 0);

  if (options.interrupted !== undefined) {
    host.interrupted = options.interrupted;
  }

  for (const key of [
    'isInterrupted',
    'isWinch',
    'getRows',
    'getCols',
    'hostBuiltinLookup',
    'hostBuiltinRun',
    'hostBuiltinName',
    'wasiHostSpawn',
    'builtins',
    'onTrace',
  ]) {
    if (options[key] !== undefined) {
      host[key] = options[key];
    } else if (!(key in host)) {
      host[key] = null;
    }
  }

  return host;
}

/**
 * Builds a composable options object for `wasi-host` (`new WasiHost(createBusyboxHostOptions(options))`)
 * wiring BusyBox state, `wrapWasiPipes`, and `createBusyboxBridge` while preserving user hooks.
 *
 * @param {Object} [options={}] Combined WasiHost + BusyBox options
 * @returns {Object} Options object ready for `new WasiHost(...)`
 */
export function createBusyboxHostOptions(options = {}) {
  const baseOptions = {};
  const busyboxOptions = {};

  for (const [key, value] of Object.entries(options)) {
    if (BUSYBOX_OPTION_KEYS.includes(key)) {
      busyboxOptions[key] = value;
    } else {
      baseOptions[key] = value;
    }
  }

  const userWasiWrapper = options.wasiWrapper;
  const userEnvProvider = options.envProvider;

  const ensureAttached = (host) => {
    if (host && !host._busyboxAttached) {
      attachBusybox(host, busyboxOptions);
      host._busyboxAttached = true;
    }
  };

  return {
    ...baseOptions,
    wasiWrapper: (wasi, host) => {
      ensureAttached(host);
      const base = userWasiWrapper ? userWasiWrapper(wasi, host) : wasi;
      if (host && typeof host === 'object') {
        host.origWasi = base;
      }
      return wrapWasiPipes(base, host);
    },
    envProvider: (host) => {
      ensureAttached(host);
      return {
        ...createBusyboxBridge(host),
        ...(userEnvProvider ? userEnvProvider(host) : {}),
      };
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MemoryPipe,
    readCString,
    readCStringArray,
    createBusyboxBridge,
    wrapWasiPipes,
    attachBusybox,
    createBusyboxHostOptions,
  };
}
