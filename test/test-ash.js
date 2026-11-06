const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

function runSh(script) {
  const res = spawnSync(process.execPath, [cliPath, 'sh', '-c', script], {
    encoding: 'utf-8'
  });
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr
  };
}

console.log('Testing BusyBox ash shell scripting in WASI...');

// 1. Variable Assignment & Substitution
{
  const r = runSh('NAME="Alice"; echo "Hello, $NAME"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'Hello, Alice');
  console.log('  ✓ variables');
}

// 2. Arithmetic Expansion
{
  const r = runSh('A=5; B=7; echo $((A * B + 2))');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '37');
  console.log('  ✓ arithmetic expansion $((...))');
}

// 3. For Loop
{
  const r = runSh('out=""; for x in a b c; do out="${out}${x}"; done; echo "$out"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'abc');
  console.log('  ✓ for loop');
}

// 4. While Loop
{
  const r = runSh('i=1; out=""; while [ $i -le 3 ]; do out="${out}${i} "; i=$((i + 1)); done; echo "$out"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '1 2 3');
  console.log('  ✓ while loop');
}

// 5. If-Then-Else
{
  const r1 = runSh('val=10; if [ $val -gt 5 ]; then echo "HIGH"; else echo "LOW"; fi');
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r1.stdout.trim(), 'HIGH');

  const r2 = runSh('val=2; if [ $val -gt 5 ]; then echo "HIGH"; else echo "LOW"; fi');
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout.trim(), 'LOW');
  console.log('  ✓ if-then-else');
}

// 6. Shell Functions
{
  const r = runSh('greet() { echo "Greeting: $1"; }; greet "Student"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'Greeting: Student');
  console.log('  ✓ functions');
}

// 7. Case Statements
{
  const r = runSh('fruit="banana"; case "$fruit" in apple) echo "red";; banana) echo "yellow";; *) echo "unknown";; esac');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'yellow');
  console.log('  ✓ case statements');
}

// 8. Unknown external command produces 127
{
  const r = runSh('nonexistent_command_12345; echo "exit=$?"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'exit=127');
  console.log('  ✓ unknown command returns 127');
}

console.log('All ash scripting tests passed successfully!\n');
