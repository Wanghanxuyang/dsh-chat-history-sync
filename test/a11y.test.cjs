'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8');
const checks = [
  ["aria-label", /aria-label/],
  ["aria-expanded", /aria-expanded/],
  ["role=status", /role: 'status'/],
  ["aria-live", /aria-live/],
  ["focus-visible", /focus-visible/],
  ["narrow breakpoint", /@media \(max-width:560px\)/],
];
for (const [name, re] of checks) {
  if (!re.test(client)) { console.error('a11y missing:', name); process.exit(1); }
}
if (/window\.confirm/.test(client)) { console.error('browser confirm still used'); process.exit(1); }
console.log('a11y static checks passed');
