const manifest = await Bun.file('scripts/frozen-files.sha256').text();
const failures: string[] = [];

for (const line of manifest.trim().split('\n')) {
  const [expected, file] = line.trim().split(/\s+/, 2);
  const source = Bun.file(file);
  if (!(await source.exists())) {
    failures.push(`${file}: missing`);
    continue;
  }
  const actual = new Bun.CryptoHasher('sha256').update(await source.arrayBuffer()).digest('hex');
  if (actual !== expected) failures.push(`${file}: ${actual} != ${expected}`);
}

if (failures.length > 0) {
  console.error(`Frozen file verification failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('Frozen files verified.');
