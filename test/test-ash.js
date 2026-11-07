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

// 9. Command Substitution $(...) & In-Memory Pipelines
{
  const r1 = runSh('X=$(echo "hello_subshell"); echo "GOT: $X"');
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r1.stdout.trim(), 'GOT: hello_subshell');

  const r2 = runSh('X=$(printf "3\\n1\\n2\\n" | sort); echo "$X"');
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout.trim(), '1\n2\n3');
  console.log('  ✓ command substitution $(...) and pipelines');
}

// 10. Internal Shell Builtin: env
{
  const r = runSh('TEST_ENV_VAR=wasi_val env | grep TEST_ENV_VAR');
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('TEST_ENV_VAR=wasi_val'));
  console.log('  ✓ builtin: env');
}

// 11. Internal Shell Builtins: pwd, cd
{
  const r = runSh('cd /tmp && pwd');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '/tmp');
  console.log('  ✓ builtin: pwd & cd');
}

// 12. Internal Shell Builtin: read
{
  const r = runSh('printf "alpha beta\\n" | { read w1 w2; echo "w1=$w1 w2=$w2"; }');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'w1=alpha w2=beta');
  console.log('  ✓ builtin: read');
}

// 13. Internal Shell Builtins: export & unset
{
  const r = runSh('export MY_EXP="exported"; echo "$MY_EXP"; unset MY_EXP; echo "empty=${MY_EXP:-empty}"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'exported\nempty=empty');
  console.log('  ✓ builtin: export & unset');
}

// 14. Internal Shell Builtin: eval
{
  const r = runSh('CMD="VAL=123"; eval "$CMD"; echo "$VAL"');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '123');
  console.log('  ✓ builtin: eval');
}

// 15. Internal Shell Builtins: type and command -v
{
  const r1 = runSh('type echo');
  assert.strictEqual(r1.status, 0);
  assert.ok(r1.stdout.includes('is a shell builtin'));

  const r2 = runSh('type sed');
  assert.strictEqual(r2.status, 0);
  assert.ok(r2.stdout.includes('is a shell builtin') || r2.stdout.includes('is sed'));

  const r3 = runSh('type time');
  assert.strictEqual(r3.status, 0);
  assert.ok(r3.stdout.includes('is a host builtin'));
  console.log('  ✓ builtin: type');
}

// 16. Internal Shell Builtins: test and [
{
  const r1 = runSh('if test -d /tmp; then echo "DIR"; fi');
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r1.stdout.trim(), 'DIR');

  const r2 = runSh('if [ "abc" != "def" ] && [ 10 -gt 5 ]; then echo "MATCH"; fi');
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout.trim(), 'MATCH');
  console.log('  ✓ builtin: test & [');
}

// 17. Internal Shell Builtin: times
{
  const r = runSh('times');
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('0m'));
  console.log('  ✓ builtin: times');
}

// 18. Host-Assisted Builtins: host_echo and time
{
  const rEcho = runSh('host_echo "hello from host"');
  assert.strictEqual(rEcho.status, 0);
  assert.strictEqual(rEcho.stdout.trim(), '[host_echo] hello from host');
  console.log('  ✓ host builtin: host_echo');

  const rTime = runSh('time echo "timed"');
  assert.strictEqual(rTime.status, 0);
  assert.strictEqual(rTime.stdout.trim(), 'timed');
  assert.ok(rTime.stderr.includes('real\t0m'));
  console.log('  ✓ host builtin: time');
}

console.log('All ash scripting and builtin tests passed successfully!\n');
