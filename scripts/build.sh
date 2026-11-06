#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
CONFIGS_DIR="${ROOT_DIR}/configs"
PATCHES_DIR="${ROOT_DIR}/patches"
SHIM_DIR="${ROOT_DIR}/src/shim"
BIN_DIR="${ROOT_DIR}/bin"

BB_VER="1.38.0"
BB_TARBALL="busybox-${BB_VER}.tar.bz2"
BB_SHA256="34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2"
BB_DIR="${BUILD_DIR}/busybox-${BB_VER}"

mkdir -p "${BUILD_DIR}" "${BIN_DIR}"

echo "=========================================================="
echo " Building busybox-wasi (v${BB_VER}) for wasm32-wasip1"
echo "=========================================================="

# 1. Locate wasi-sdk toolchain
WASI_SDK_VERSION="${WASI_SDK_VERSION:-25.0}"
WASI_SDK_MAJOR="${WASI_SDK_VERSION%%.*}"

if [ -z "${WASI_SDK_PATH:-}" ] || [ ! -x "${WASI_SDK_PATH}/bin/clang" ]; then
  if [ -x "/home/breeze/work/projects/clang-wasi/wasi-sdk/bin/clang" ]; then
    export WASI_SDK_PATH="/home/breeze/work/projects/clang-wasi/wasi-sdk"
  elif [ -x "${BUILD_DIR}/wasi-sdk/bin/clang" ]; then
    export WASI_SDK_PATH="${BUILD_DIR}/wasi-sdk"
  else
    echo "wasi-sdk not found. Downloading wasi-sdk-${WASI_SDK_VERSION}..."
    mkdir -p "${BUILD_DIR}/wasi-sdk-tmp"
    curl -sSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_MAJOR}/wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux.tar.gz" | tar -xz -C "${BUILD_DIR}/wasi-sdk-tmp"
    mv "${BUILD_DIR}"/wasi-sdk-tmp/wasi-sdk-${WASI_SDK_VERSION}* "${BUILD_DIR}/wasi-sdk"
    rm -rf "${BUILD_DIR}/wasi-sdk-tmp"
    export WASI_SDK_PATH="${BUILD_DIR}/wasi-sdk"
  fi
fi

if [ ! -x "${WASI_SDK_PATH}/bin/clang" ]; then
  echo "Error: wasi-sdk clang not found at ${WASI_SDK_PATH}/bin/clang" >&2
  exit 1
fi

echo "Using wasi-sdk: ${WASI_SDK_PATH}"

# 2. Download and verify BusyBox tarball
TARBALL_PATH="${BUILD_DIR}/${BB_TARBALL}"
if [ ! -f "${TARBALL_PATH}" ]; then
  echo "Downloading ${BB_TARBALL}..."
  curl -fsSL "https://busybox.net/downloads/${BB_TARBALL}" -o "${TARBALL_PATH}"
fi

echo "Verifying archive integrity..."
echo "${BB_SHA256}  ${TARBALL_PATH}" | sha256sum -c -

# 3. Clean extraction
echo "Extracting pristine source..."
rm -rf "${BB_DIR}"
tar -C "${BUILD_DIR}" -xjf "${TARBALL_PATH}"

# 4. Source fixes and patches
echo "Applying WASI Preview 1 patches..."

# mode_string.c size hack fix for target libc
perl -0777 -i -pe 's/^#\s*if \(S_IRWXU.*?== 07777\n#\s*undef mode_t\n#\s*define mode_t unsigned short\n#\s*endif\n//ms' "${BB_DIR}/libbb/mode_string.c"

patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-forkfree.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-hostbuiltin.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-shebang.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-nested-shell.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/applet-interrupt.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-shebang-path.patch"
patch -p1 -d "${BB_DIR}" < "${PATCHES_DIR}/ash-complete-hostbuiltin.patch"

# 5. Configuration
echo "Applying wasi_defconfig..."
cp "${CONFIGS_DIR}/wasi_defconfig" "${BB_DIR}/.config"
set +o pipefail
yes "" | make -C "${BB_DIR}" oldconfig HOSTCC=gcc >/dev/null 2>&1 || true
set -o pipefail

# 6. Setup cross-compilation wrappers
# Probe exception handling / sjlj flags across wasi-sdk versions (LLVM 19 vs 20+)
if echo 'int main(void){return 0;}' | "${WASI_SDK_PATH}/bin/clang" -x c - -c -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=true -o /dev/null 2>/dev/null; then
  SJLJ_FLAGS="-mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=true"
else
  SJLJ_FLAGS="-mexception-handling -mllvm -wasm-enable-sjlj"
fi

CFLAGS_WASM="${SJLJ_FLAGS} \
  -fno-sanitize=all \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_GNU_SOURCE -DSOCK_RDM=4 \
  -idirafter ${SHIM_DIR}/musl-compat \
  -include ${SHIM_DIR}/wasi_compat.h -I${SHIM_DIR} \
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-error"

WORK_BIN="${BUILD_DIR}/bin"
mkdir -p "${WORK_BIN}"

CC_CMD="${WASI_SDK_PATH}/bin/clang --target=wasm32-wasi ${CFLAGS_WASM}"
WASM_LD="${WASI_SDK_PATH}/bin/wasm-ld"
AR_CMD="${WASI_SDK_PATH}/bin/llvm-ar"

cat > "${WORK_BIN}/zcc" <<EOF
#!/bin/sh
exec ${CC_CMD} "\$@"
EOF

cat > "${WORK_BIN}/zld" <<EOF
#!/bin/sh
a=""
for x in "\$@"; do
  case "\$x" in
    -r|-nostdlib|-m|elf_*) ;;
    *) a="\$a \$x" ;;
  esac
done
exec ${WASM_LD} --relocatable \$a
EOF

chmod +x "${WORK_BIN}/zcc" "${WORK_BIN}/zld"
export PATH="${WORK_BIN}:${PATH}"

# 7. Compile BusyBox objects
echo "Compiling BusyBox applets..."
CORES=$(nproc 2>/dev/null || echo 4)
make -C "${BB_DIR}" -j"${CORES}" CC=zcc LD=zld HOSTCC=gcc AR="${AR_CMD}" SKIP_STRIP=y > "${BUILD_DIR}/make.log" 2>&1 || true

for need in "${BB_DIR}/libbb/lib.a" "${BB_DIR}/shell/lib.a" "${BB_DIR}/libbb/appletlib.o" "${BB_DIR}/applets/applets.o"; do
  if [ ! -f "${need}" ]; then
    echo "Error: Compilation failed, missing ${need}. See ${BUILD_DIR}/make.log" >&2
    tail -n 40 "${BUILD_DIR}/make.log" >&2
    exit 1
  fi
done

# 8. Compile shims and setjmp runtime
echo "Compiling wasistubs and setjmp runtime..."
zcc -O2 -c "${SHIM_DIR}/wasistubs.c" -o "${BUILD_DIR}/wasistubs.o"
zcc -O2 -c "${SHIM_DIR}/ppoll.c" -o "${BUILD_DIR}/ppoll.o"
zcc -O2 -c "${SHIM_DIR}/rt.c" -o "${BUILD_DIR}/rt.o"

# 9. Sysroot and support libraries
SYSROOT_LIB="${WASI_SDK_PATH}/share/wasi-sysroot/lib/wasm32-wasip1"
[ -d "${SYSROOT_LIB}" ] || SYSROOT_LIB="${WASI_SDK_PATH}/share/wasi-sysroot/lib/wasm32-wasi"

CRT="${SYSROOT_LIB}/crt1-command.o"
LIBC="${SYSROOT_LIB}/libc.a"
EMU_GETPID="${SYSROOT_LIB}/libwasi-emulated-getpid.a"
EMU_SIGNAL="${SYSROOT_LIB}/libwasi-emulated-signal.a"
EMU_MMAN="${SYSROOT_LIB}/libwasi-emulated-mman.a"
EMU_CLOCKS="${SYSROOT_LIB}/libwasi-emulated-process-clocks.a"
RTLIB=$(find "${WASI_SDK_PATH}" -name "libclang_rt.builtins*.a" 2>/dev/null | grep -E "wasm32-unknown-wasi/|wasm32-wasi/|wasm32-unknown-wasip1/|/wasi/" | head -1)
if [ -z "${RTLIB}" ]; then
  RTLIB=$(find "${WASI_SDK_PATH}" -name "libclang_rt.builtins*.a" 2>/dev/null | head -1)
fi
EXTRA_LIBS="${LIBC} ${EMU_GETPID} ${EMU_SIGNAL} ${EMU_MMAN} ${EMU_CLOCKS} ${RTLIB}"

# 10. Final link
echo "Linking busybox.wasm..."
OUTPUT_WASM="${BIN_DIR}/busybox.wasm"

BUILTIN_OBJS=$(find "${BB_DIR}" -name built-in.o | sort)
ARCHIVE_LIBS=$(find "${BB_DIR}" -name lib.a | sort)

${WASM_LD} --stack-first -z stack-size=1048576 \
  --import-undefined --wrap fcntl --wrap exit --wrap ioctl --wrap poll \
  --wrap raise --wrap read --wrap write --wrap readv --wrap writev \
  --wrap __wasilibc_fd_renumber \
  --strip-debug \
  "${CRT}" "${BB_DIR}/libbb/appletlib.o" "${BB_DIR}/applets/applets.o" \
  ${BUILTIN_OBJS} ${ARCHIVE_LIBS} \
  "${BUILD_DIR}/wasistubs.o" "${BUILD_DIR}/ppoll.o" "${BUILD_DIR}/rt.o" \
  ${EXTRA_LIBS} \
  -o "${OUTPUT_WASM}"

# Optional wasm-opt pass
if command -v wasm-opt >/dev/null 2>&1; then
  echo "Optimizing with wasm-opt -O2..."
  wasm-opt -O2 "${OUTPUT_WASM}" -o "${OUTPUT_WASM}.opt"
  mv "${OUTPUT_WASM}.opt" "${OUTPUT_WASM}"
fi

WASM_SIZE=$(wc -c < "${OUTPUT_WASM}")
echo "Successfully generated: ${OUTPUT_WASM} (${WASM_SIZE} bytes)"
