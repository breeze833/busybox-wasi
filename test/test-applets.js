import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, input = '') {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf-8'
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr
  };
}

console.log('Testing BusyBox applets via wasi...');

// =========================================================================
// 8.1 Text Processing & Stream Utilities
// =========================================================================

// 1. Echo & Printf
{
  const rEcho = run(['echo', 'Hello', 'World']);
  assert.strictEqual(rEcho.status, 0);
  assert.strictEqual(rEcho.stdout.trim(), 'Hello World');
  console.log('  ✓ echo');

  const rPrintf = run(['printf', '%d %s\n', '42', 'test']);
  assert.strictEqual(rPrintf.status, 0);
  assert.strictEqual(rPrintf.stdout, '42 test\n');
  console.log('  ✓ printf');
}

// 2. Grep, Egrep & Fgrep
{
  const rGrep = run(['grep', 'apple'], 'apple\nbanana\ncherry\npineapple\n');
  assert.strictEqual(rGrep.status, 0);
  assert.strictEqual(rGrep.stdout, 'apple\npineapple\n');
  console.log('  ✓ grep');

  const rEgrep = run(['egrep', 'apple|cherry'], 'apple\nbanana\ncherry\n');
  assert.strictEqual(rEgrep.status, 0);
  assert.strictEqual(rEgrep.stdout, 'apple\ncherry\n');
  console.log('  ✓ egrep');

  const rFgrep = run(['fgrep', 'fixed.str'], 'fixed.str\nfixedXstr\n');
  assert.strictEqual(rFgrep.status, 0);
  assert.strictEqual(rFgrep.stdout, 'fixed.str\n');
  console.log('  ✓ fgrep');
}

// 3. Sed
{
  const r = run(['sed', 's/foo/bar/g'], 'foo and foo\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'bar and bar\n');
  console.log('  ✓ sed');
}

// 4. Awk
{
  const r = run(['awk', '{ print $2, $1 }'], 'hello world\nfoo bar\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'world hello\nbar foo\n');
  console.log('  ✓ awk');
}

// 5. WC
{
  const r = run(['wc', '-w'], 'one two three four five\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '5');
  console.log('  ✓ wc');
}

// 6. Sort & Uniq
{
  const rSort = run(['sort'], 'c\na\nb\n');
  assert.strictEqual(rSort.status, 0);
  assert.strictEqual(rSort.stdout, 'a\nb\nc\n');
  console.log('  ✓ sort');

  const rUniq = run(['uniq'], 'a\na\nb\nb\nc\n');
  assert.strictEqual(rUniq.status, 0);
  assert.strictEqual(rUniq.stdout, 'a\nb\nc\n');
  console.log('  ✓ uniq');
}

// 7. Cut & Tr
{
  const rCut = run(['cut', '-d,', '-f2'], 'a,b,c\n1,2,3\n');
  assert.strictEqual(rCut.status, 0);
  assert.strictEqual(rCut.stdout, 'b\n2\n');
  console.log('  ✓ cut');

  const rTr = run(['tr', 'a-z', 'A-Z'], 'hello world\n');
  assert.strictEqual(rTr.status, 0);
  assert.strictEqual(rTr.stdout, 'HELLO WORLD\n');
  console.log('  ✓ tr');
}

// 8. Cat, Head, Tail, Fold & Tac
{
  const rCat = run(['cat'], 'first line\nsecond line\n');
  assert.strictEqual(rCat.status, 0);
  assert.strictEqual(rCat.stdout, 'first line\nsecond line\n');
  console.log('  ✓ cat');

  const rHead = run(['head', '-n', '2'], '1\n2\n3\n4\n');
  assert.strictEqual(rHead.status, 0);
  assert.strictEqual(rHead.stdout, '1\n2\n');
  console.log('  ✓ head');

  const rTail = run(['tail', '-n', '2'], '1\n2\n3\n4\n');
  assert.strictEqual(rTail.status, 0);
  assert.strictEqual(rTail.stdout, '3\n4\n');
  console.log('  ✓ tail');

  const rFold = run(['fold', '-w', '4'], '12345678\n');
  assert.strictEqual(rFold.status, 0);
  assert.strictEqual(rFold.stdout.trim(), '1234\n5678');
  console.log('  ✓ fold');

  const rTac = run(['tac'], 'line1\nline2\n');
  assert.strictEqual(rTac.status, 0);
  assert.strictEqual(rTac.stdout, 'line2\nline1\n');
  console.log('  ✓ tac');
}

// 9. Path Transformation: Dirname & Basename
{
  const rDir = run(['dirname', '/foo/bar/baz.txt']);
  assert.strictEqual(rDir.status, 0);
  assert.strictEqual(rDir.stdout.trim(), '/foo/bar');
  console.log('  ✓ dirname');

  const rBase = run(['basename', '/foo/bar/baz.txt']);
  assert.strictEqual(rBase.status, 0);
  assert.strictEqual(rBase.stdout.trim(), 'baz.txt');

  const rBaseSuffix = run(['basename', '/foo/bar/baz.txt', '.txt']);
  assert.strictEqual(rBaseSuffix.status, 0);
  assert.strictEqual(rBaseSuffix.stdout.trim(), 'baz');
  console.log('  ✓ basename');
}

// 10. Multi-Stream: Paste, Comm & Xargs
{
  const tmpDir = '/tmp/bb_test_paste_comm';
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmpDir, 'p1'), 'a\nb\n');
    fs.writeFileSync(path.join(tmpDir, 'p2'), '1\n2\n');
    const rPaste = run(['paste', '-d,', path.join(tmpDir, 'p1'), path.join(tmpDir, 'p2')]);
    assert.strictEqual(rPaste.status, 0);
    assert.strictEqual(rPaste.stdout, 'a,1\nb,2\n');
    console.log('  ✓ paste');

    fs.writeFileSync(path.join(tmpDir, 'c1'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(tmpDir, 'c2'), 'b\nc\nd\n');
    const rComm = run(['comm', '-12', path.join(tmpDir, 'c1'), path.join(tmpDir, 'c2')]);
    assert.strictEqual(rComm.status, 0);
    assert.strictEqual(rComm.stdout, 'b\nc\n');
    console.log('  ✓ comm');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const rXargs = run(['xargs', 'echo'], 'item1 item2 item3');
  assert.strictEqual(rXargs.status, 0);
  assert.strictEqual(rXargs.stdout.trim(), 'item1 item2 item3');

  const rXargsBatch = run(['xargs', '-n', '2'], '1 2 3 4');
  assert.strictEqual(rXargsBatch.status, 0);
  assert.strictEqual(rXargsBatch.stdout.trim(), '1 2\n3 4');

  const rXargsPrintf = run(['xargs', '-n', '2', 'printf', 'val:%s %s\n'], '1 2 3 4');
  assert.strictEqual(rXargsPrintf.status, 0);
  assert.strictEqual(rXargsPrintf.stdout.trim(), 'val:1 2\nval:3 4');
  console.log('  ✓ xargs');
}

// 11. Comparison: Diff & CMP
{
  const f1 = '/tmp/bb_t_c1';
  const f2 = '/tmp/bb_t_c2';
  try {
    fs.writeFileSync(f1, 'hello world\n');
    fs.writeFileSync(f2, 'hello world\n');
    const rCmp = run(['cmp', f1, f2]);
    assert.strictEqual(rCmp.status, 0);
    console.log('  ✓ cmp');

    fs.writeFileSync(f2, 'hello wasi\n');
    const rDiff = run(['diff', '-u', f1, f2]);
    assert.strictEqual(rDiff.status, 1);
    assert.ok(rDiff.stdout.includes('-hello world'));
    assert.ok(rDiff.stdout.includes('+hello wasi'));
    console.log('  ✓ diff');
  } finally {
    if (fs.existsSync(f1)) fs.unlinkSync(f1);
    if (fs.existsSync(f2)) fs.unlinkSync(f2);
  }
}

// 12. Tee
{
  const r = run(['tee'], 'stream test\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'stream test\n');
  console.log('  ✓ tee');
}

// =========================================================================
// 8.2 File & Directory Management
// =========================================================================
{
  const fsDir = '/tmp/bb_test_fs_lifecycle';
  fs.rmSync(fsDir, { recursive: true, force: true });
  fs.mkdirSync(fsDir, { recursive: true });

  try {
    // mkdir -p
    const rMkdir = run(['mkdir', '-p', path.join(fsDir, 'sub/nested')]);
    assert.strictEqual(rMkdir.status, 0);
    console.log('  ✓ mkdir');

    // touch
    const testFile = path.join(fsDir, 'sub/nested/file.txt');
    const rTouch = run(['touch', testFile]);
    assert.strictEqual(rTouch.status, 0);
    assert.ok(fs.existsSync(testFile));
    console.log('  ✓ touch');

    // stat
    const rStat = run(['stat', testFile]);
    assert.strictEqual(rStat.status, 0);
    assert.ok(rStat.stdout.includes('File:'));
    console.log('  ✓ stat');

    // ls
    const rLs = run(['ls', path.join(fsDir, 'sub/nested')]);
    assert.strictEqual(rLs.status, 0);
    assert.strictEqual(rLs.stdout.trim(), 'file.txt');
    console.log('  ✓ ls');

    // cp
    const copyFile = path.join(fsDir, 'copy.txt');
    const rCp = run(['cp', testFile, copyFile]);
    assert.strictEqual(rCp.status, 0);
    assert.ok(fs.existsSync(copyFile));
    console.log('  ✓ cp');

    // mv
    const movedFile = path.join(fsDir, 'moved.txt');
    const rMv = run(['mv', copyFile, movedFile]);
    assert.strictEqual(rMv.status, 0);
    assert.ok(!fs.existsSync(copyFile));
    assert.ok(fs.existsSync(movedFile));
    console.log('  ✓ mv');

    // find
    const rFind = run(['find', fsDir, '-name', 'moved.txt']);
    assert.strictEqual(rFind.status, 0);
    assert.ok(rFind.stdout.includes('moved.txt'));
    console.log('  ✓ find');

    // du
    const rDu = run(['du', '-s', fsDir]);
    assert.strictEqual(rDu.status, 0);
    assert.ok(rDu.stdout.includes(fsDir));
    console.log('  ✓ du');

    // realpath
    const rReal = run(['realpath', movedFile]);
    assert.strictEqual(rReal.status, 0);
    assert.ok(rReal.stdout.includes('moved.txt'));
    console.log('  ✓ realpath');

    // symlink & readlink
    const linkFile = path.join(fsDir, 'symlink.txt');
    fs.symlinkSync('moved.txt', linkFile);
    const rLink = run(['readlink', linkFile]);
    assert.strictEqual(rLink.status, 0);
    assert.strictEqual(rLink.stdout.trim(), 'moved.txt');
    console.log('  ✓ readlink');

    // rm
    const rRm = run(['rm', movedFile, linkFile]);
    assert.strictEqual(rRm.status, 0);
    assert.ok(!fs.existsSync(movedFile));
    console.log('  ✓ rm');

    // unlink
    const rUnlink = run(['unlink', testFile]);
    assert.strictEqual(rUnlink.status, 0);
    assert.ok(!fs.existsSync(testFile));
    console.log('  ✓ unlink');

    // rmdir
    const rRmdir = run(['rmdir', path.join(fsDir, 'sub/nested')]);
    assert.strictEqual(rRmdir.status, 0);
    console.log('  ✓ rmdir');
  } finally {
    fs.rmSync(fsDir, { recursive: true, force: true });
  }
}

// =========================================================================
// 8.3 Archiving & Compression
// =========================================================================
{
  const archDir = '/tmp/bb_test_archiving';
  fs.rmSync(archDir, { recursive: true, force: true });
  fs.mkdirSync(archDir, { recursive: true });

  try {
    const srcDir = path.join(archDir, 'src');
    const destDir = path.join(archDir, 'dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'content A\n');
    fs.writeFileSync(path.join(srcDir, 'b.txt'), 'content B\n');

    // tar creation
    const tarFile = path.join(archDir, 'archive.tar');
    const rTarC = run(['tar', '-cf', tarFile, '-C', srcDir, 'a.txt', 'b.txt']);
    assert.strictEqual(rTarC.status, 0);
    assert.ok(fs.existsSync(tarFile));

    // tar table listing
    const rTarT = run(['tar', '-tf', tarFile]);
    assert.strictEqual(rTarT.status, 0);
    assert.ok(rTarT.stdout.includes('a.txt'));
    assert.ok(rTarT.stdout.includes('b.txt'));

    // tar extraction
    const rTarX = run(['tar', '-xf', tarFile, '-C', destDir]);
    assert.strictEqual(rTarX.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf-8'), 'content A\n');
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'b.txt'), 'utf-8'), 'content B\n');
    console.log('  ✓ tar');

    // gzip & gunzip file round-trip
    const plainFile = path.join(archDir, 'test.txt');
    fs.writeFileSync(plainFile, 'hello gzip compression\n');

    const gzRes = run(['gzip', plainFile]);
    assert.strictEqual(gzRes.status, 0);
    assert.ok(fs.existsSync(`${plainFile}.gz`));

    const gunzipRes = run(['gunzip', `${plainFile}.gz`]);
    assert.strictEqual(gunzipRes.status, 0);
    assert.strictEqual(fs.readFileSync(plainFile, 'utf-8'), 'hello gzip compression\n');
    console.log('  ✓ gzip & gunzip');
  } finally {
    fs.rmSync(archDir, { recursive: true, force: true });
  }
}

// =========================================================================
// 8.4 Math & Core Scripting Utilities
// =========================================================================
{
  // expr
  const rExpr = run(['expr', '10', '+', '25']);
  assert.strictEqual(rExpr.status, 0);
  assert.strictEqual(rExpr.stdout.trim(), '35');
  console.log('  ✓ expr');

  // bc
  const rBc = run(['bc'], '2^8\n');
  assert.strictEqual(rBc.status, 0);
  assert.strictEqual(rBc.stdout.trim(), '256');
  console.log('  ✓ bc');

  // dc
  const rDc = run(['dc'], '6 7 * p\n');
  assert.strictEqual(rDc.status, 0);
  assert.strictEqual(rDc.stdout.trim(), '42');
  console.log('  ✓ dc');

  // true & false
  assert.strictEqual(run(['true']).status, 0);
  console.log('  ✓ true');
  assert.strictEqual(run(['false']).status, 1);
  console.log('  ✓ false');

  // which
  const whichDir = '/tmp/bb_test_which';
  fs.mkdirSync(whichDir, { recursive: true });
  try {
    const whichFile = path.join(whichDir, 'mycmd');
    fs.writeFileSync(whichFile, '#!/bin/sh\n');
    fs.chmodSync(whichFile, 0o755);
    const rWhich = run(['sh', '-c', `PATH=${whichDir} which mycmd`]);
    assert.strictEqual(rWhich.status, 0);
    assert.ok(rWhich.stdout.includes('mycmd'));
    console.log('  ✓ which');
  } finally {
    fs.rmSync(whichDir, { recursive: true, force: true });
  }

  // pwd
  const rPwd = run(['pwd']);
  assert.strictEqual(rPwd.status, 0);
  console.log('  ✓ pwd');

  // date
  const rDate = run(['date', '+%Y']);
  assert.strictEqual(rDate.status, 0);
  assert.ok(/^\d{4}$/.test(rDate.stdout.trim()));
  console.log('  ✓ date');

  // sleep
  const rSleep = run(['sleep', '1']);
  assert.strictEqual(rSleep.status, 0);
  console.log('  ✓ sleep');

  // seq
  const rSeq = run(['seq', '1', '3']);
  assert.strictEqual(rSeq.status, 0);
  assert.strictEqual(rSeq.stdout, '1\n2\n3\n');
  console.log('  ✓ seq');

  // uname
  const rUname = run(['uname', '-s']);
  assert.strictEqual(rUname.status, 0);
  assert.strictEqual(rUname.stdout.trim(), 'wasi');
  console.log('  ✓ uname');

  // printenv
  const rPrintenv = run(['printenv', 'PATH']);
  assert.strictEqual(rPrintenv.status, 0);
  console.log('  ✓ printenv');

  // mktemp
  const rMktemp = run(['mktemp', '/tmp/bb_test_temp.XXXXXX']);
  assert.strictEqual(rMktemp.status, 0);
  const createdTmp = rMktemp.stdout.trim();
  assert.ok(fs.existsSync(createdTmp));
  fs.unlinkSync(createdTmp);
  console.log('  ✓ mktemp');
}

// =========================================================================
// 8.5 Checksums & Encodings
// =========================================================================
{
  // md5sum (known vector for "hello\n": b1946ac92492d2347c6235b4d2611184)
  const rMd5 = run(['md5sum'], 'hello\n');
  assert.strictEqual(rMd5.status, 0);
  assert.ok(rMd5.stdout.startsWith('b1946ac92492d2347c6235b4d2611184'));
  console.log('  ✓ md5sum');

  // sha1sum (known vector for "hello\n": f572d396fae9206628714fb2ce00f72e94f2258f)
  const rSha1 = run(['sha1sum'], 'hello\n');
  assert.strictEqual(rSha1.status, 0);
  assert.ok(rSha1.stdout.startsWith('f572d396fae9206628714fb2ce00f72e94f2258f'));
  console.log('  ✓ sha1sum');

  // sha256sum (known vector for "hello\n": 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03)
  const rSha256 = run(['sha256sum'], 'hello\n');
  assert.strictEqual(rSha256.status, 0);
  assert.ok(rSha256.stdout.startsWith('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'));
  console.log('  ✓ sha256sum');

  // cksum
  const rCksum = run(['cksum'], 'hello\n');
  assert.strictEqual(rCksum.status, 0);
  assert.ok(/\d+\s+\d+/.test(rCksum.stdout.trim()));
  console.log('  ✓ cksum');

  // crc32
  const rCrc32 = run(['crc32'], 'hello\n');
  assert.strictEqual(rCrc32.status, 0);
  console.log('  ✓ crc32');

  // xxd
  const rXxd = run(['xxd'], 'ABC');
  assert.strictEqual(rXxd.status, 0);
  assert.ok(rXxd.stdout.includes('4142 43'));
  console.log('  ✓ xxd');

  // hexdump
  const rHex = run(['hexdump', '-C'], 'ABC');
  assert.strictEqual(rHex.status, 0);
  assert.ok(rHex.stdout.includes('41 42 43'));
  console.log('  ✓ hexdump');
}

console.log('All applet tests passed successfully!\n');
