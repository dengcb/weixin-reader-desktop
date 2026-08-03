const allowed = new Set([
  "src/plugins/template/index.ts|'clickElement'",
  "src/scripts/adapters/weread_adapter.ts|'initPageTurnMonitor'",
  "src/scripts/adapters/weread_adapter.ts|'extractNumericBookId'",
]);

const processResult = Bun.spawn(['bunx', 'tsc', '--noEmit', '--pretty', 'false'], {
  stdout: 'pipe',
  stderr: 'pipe',
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(processResult.stdout).text(),
  new Response(processResult.stderr).text(),
  processResult.exited,
]);
const output = `${stdout}${stderr}`;
const unexpected: string[] = [];
const observed = new Set<string>();

for (const line of output.split('\n').filter(Boolean)) {
  const match = line.match(/^(.+?)\((\d+),\d+\): error TS(\d+): (.+)$/);
  if (!match || match[3] !== '6133') {
    unexpected.push(line);
    continue;
  }
  const [, file, lineNumber, , message] = match;
  const symbol = message.match(/'([^']+)'/)?.[0] ?? '';
  const candidates = [`${file}|${symbol}`, `${file}|${symbol}|${lineNumber}`];
  const key = candidates.find((candidate) => allowed.has(candidate));
  if (key) observed.add(key);
  else unexpected.push(line);
}

const missing = [...allowed].filter((item) => !observed.has(item));
if (unexpected.length > 0 || missing.length > 0 || (exitCode !== 0 && output.length === 0)) {
  if (unexpected.length > 0) console.error(unexpected.join('\n'));
  if (missing.length > 0) console.error(`Missing exact TS6133 allowance entries:\n${missing.join('\n')}`);
  process.exit(1);
}
console.log(`TypeScript strict check passed with ${observed.size} exact TS6133 allowances.`);
