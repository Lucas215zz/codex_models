// Build a key-free public copy of the migration package
const fs = require('fs');
const path = require('path');

const SRC = 'E:/github/work Buddy/data/2026-10-27-23-04-45/codex-models-migration';
const DST = 'E:/github/work Buddy/data/2026-10-27-23-04-45/codex_models-repo';
const PLACEHOLDER = 'PASTE_YOUR_KEY_HERE';

fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });

// 1. keys/*.txt -> one placeholder file per channel
const keysDir = path.join(DST, 'codex-model-router', 'keys');
let keyFiles = 0;
for (const f of fs.readdirSync(keysDir)) {
  if (f.endsWith('.txt')) {
    fs.writeFileSync(path.join(keysDir, f), PLACEHOLDER + '\n', 'utf8');
    keyFiles++;
  }
}

// 2. config.toml -> blank out all inline bearer tokens
const cfgPath = path.join(DST, 'codex-config', 'config.toml');
let toml = fs.readFileSync(cfgPath, 'utf8');
let tomlScrubbed = 0;
toml = toml.replace(/experimental_bearer_token\s*=\s*"[^"]+"/g, () => {
  tomlScrubbed++;
  return 'experimental_bearer_token = "' + PLACEHOLDER + '"';
});
fs.writeFileSync(cfgPath, toml, 'utf8');

// 3. router-config.json -> blank out real keys (keep Chinese placeholder hints as-is)
const rcPath = path.join(DST, 'codex-model-router', 'router-config.json');
const rc = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
let rcScrubbed = 0;
for (const ch of Object.values(rc.channels || {})) {
  if (typeof ch.key === 'string' && ch.key && !ch.key.startsWith('在这里填入')) {
    ch.key = PLACEHOLDER;
    rcScrubbed++;
  }
}
fs.writeFileSync(rcPath, JSON.stringify(rc, null, 2), 'utf8');

// 4. verify: no residual secrets anywhere
const secrets = [];
const scan = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { scan(p); continue; }
    if (/\.(zip|png|jpg|sqlite)$/i.test(f.name)) continue;
    const content = fs.readFileSync(p, 'utf8');
    // real key patterns: sk-... long, 64-hex, zhipu id.secret, long base64-ish tokens
    const pats = [/sk-[a-zA-Z0-9_-]{20,}/, /\b[a-f0-9]{48,64}\b/, /[a-f0-9]{32}\.[a-zA-Z0-9]{8,}/];
    if (pats.some((r) => r.test(content)) && !content.includes(PLACEHOLDER)) {
      // ignore lines that are just the placeholder
      const hits = content.split('\n').filter((l) => pats.some((r) => r.test(l)) && !l.includes(PLACEHOLDER));
      if (hits.length) secrets.push(f.name + ': ' + hits.length + ' line(s)');
    }
  }
};
scan(DST);

console.log('keyFiles replaced:', keyFiles);
console.log('config.toml tokens replaced:', tomlScrubbed);
console.log('router-config.json keys replaced:', rcScrubbed);
console.log(secrets.length ? 'RESIDUAL SECRETS:\n' + secrets.join('\n') : 'VERIFIED: no real keys remain in ' + DST);
