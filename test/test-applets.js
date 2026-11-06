const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

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

// 1. Echo & Printf
{
  const r = run(['echo', 'Hello', 'World']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'Hello World');
  console.log('  ✓ echo');
}

{
  const r = run(['printf', '%d %s\n', '42', 'test']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '42 test\n');
  console.log('  ✓ printf');
}

// 2. Grep
{
  const r = run(['grep', 'apple'], 'apple\nbanana\ncherry\npineapple\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'apple\npineapple\n');
  console.log('  ✓ grep');
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
  const r = run(['sort'], 'c\na\nb\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'a\nb\nc\n');
  console.log('  ✓ sort');
}

{
  const r = run(['uniq'], 'a\na\nb\nb\nc\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'a\nb\nc\n');
  console.log('  ✓ uniq');
}

// 7. Cut & Tr
{
  const r = run(['cut', '-d,', '-f2'], 'a,b,c\n1,2,3\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'b\n2\n');
  console.log('  ✓ cut');
}

{
  const r = run(['tr', 'a-z', 'A-Z'], 'hello world\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'HELLO WORLD\n');
  console.log('  ✓ tr');
}

// 8. Expr & BC
{
  const r = run(['expr', '10', '+', '25']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '35');
  console.log('  ✓ expr');
}

{
  const r = run(['bc'], '2^8\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '256');
  console.log('  ✓ bc');
}

// 9. Diff & CMP
{
  const fs = require('node:fs');
  fs.writeFileSync('/tmp/t_c1', 'hello world\n');
  fs.writeFileSync('/tmp/t_c2', 'hello world\n');
  const r = run(['cmp', '/tmp/t_c1', '/tmp/t_c2']);
  assert.strictEqual(r.status, 0);
  console.log('  ✓ cmp');

  fs.writeFileSync('/tmp/t_c2', 'hello wasi\n');
  const rDiff = run(['diff', '-u', '/tmp/t_c1', '/tmp/t_c2']);
  assert.strictEqual(rDiff.status, 1);
  assert.ok(rDiff.stdout.includes('-hello world'));
  assert.ok(rDiff.stdout.includes('+hello wasi'));
  console.log('  ✓ diff');

  fs.unlinkSync('/tmp/t_c1');
  fs.unlinkSync('/tmp/t_c2');
}

// 10. Tee
{
  const r = run(['tee'], 'stream test\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'stream test\n');
  console.log('  ✓ tee');
}

console.log('All applet tests passed successfully!\n');
