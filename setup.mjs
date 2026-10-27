// Codex models migration - one-click setup for a new PC or Mac
// Windows: double-click setup.cmd   |   Mac: run `node setup.mjs` in Terminal
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const IS_MAC = process.platform === 'darwin';
const pkgDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const home = os.homedir();
const codexDir = path.join(home, '.codex');
const srcRouterDir = path.join(pkgDir, 'codex-model-router');
const cfgDir = path.join(pkgDir, 'codex-config');
// on mac the router must live at ~/codex-model-router (launchd plist expects this)
const routerDir = IS_MAC ? path.join(home, 'codex-model-router') : srcRouterDir;

const log = (m) => console.log(m);
const fail = (m) => { console.error('[ERROR] ' + m); process.exit(1); };

// 1. sanity checks
if (!fs.existsSync(path.join(srcRouterDir, 'server.mjs'))) fail('codex-model-router folder missing next to setup.mjs');
if (!fs.existsSync(path.join(cfgDir, 'config.toml'))) fail('codex-config folder missing next to setup.mjs');

// 2. place the router files
if (IS_MAC) {
  fs.mkdirSync(routerDir, { recursive: true });
  fs.mkdirSync(path.join(routerDir, 'keys'), { recursive: true });
  for (const f of fs.readdirSync(srcRouterDir)) {
    const s = path.join(srcRouterDir, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(routerDir, f));
  }
  for (const f of fs.readdirSync(path.join(srcRouterDir, 'keys'))) {
    fs.copyFileSync(path.join(srcRouterDir, 'keys', f), path.join(routerDir, 'keys', f));
  }
  // strip the Windows Clash proxy so the mac goes direct (add back manually if needed)
  const cfgPath = path.join(routerDir, 'router-config.json');
  const rc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (rc.proxy) { delete rc.proxy; fs.writeFileSync(cfgPath, JSON.stringify(rc, null, 2), 'utf8'); log('[ok] removed Windows proxy setting (mac goes direct)'); }
  log('[ok] router installed at ' + routerDir);
} else {
  log('[ok] router will run from ' + routerDir);
}

// 3. prepare ~/.codex (backup existing first)
fs.mkdirSync(codexDir, { recursive: true });
for (const f of ['config.toml', 'model-catalog.json']) {
  const dest = path.join(codexDir, f);
  if (fs.existsSync(dest)) {
    const bak = dest + '.bak-migration-' + new Date().toISOString().slice(0, 10);
    fs.copyFileSync(dest, bak);
    log(`[ok] backed up existing ${f} -> ${path.basename(bak)}`);
  }
}

// 4. write config.toml adapted to this machine
let toml = fs.readFileSync(path.join(cfgDir, 'config.toml'), 'utf8');
const catalogDest = path.join(codexDir, 'model-catalog.json');
toml = toml.replace(/model_catalog_json\s*=\s*"[^"]*"/, 'model_catalog_json = "' + catalogDest.replace(/\\/g, '\\\\') + '"');
toml = toml.split('\n').filter((l) => !l.startsWith('notify =')).join('\n'); // old machine's notify hook
fs.writeFileSync(path.join(codexDir, 'config.toml'), toml, 'utf8');
fs.copyFileSync(path.join(cfgDir, 'model-catalog.json'), catalogDest);
log('[ok] wrote ' + codexDir + '/config.toml and model-catalog.json');

// 5. start the router
const probe = () => new Promise((resolve) => {
  const req = http.get('http://127.0.0.1:8788/__routes', (r) => { r.resume(); resolve(r.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(2000, () => { req.destroy(); resolve(false); });
});

if (await probe()) {
  log('[ok] router already running on http://127.0.0.1:8788');
} else if (IS_MAC) {
  // on mac, let launchd start the router (avoids port clash with a manual spawn)
  const plistSrc = path.join(pkgDir, 'mac', 'com.codex.model-router.plist');
  if (fs.existsSync(plistSrc)) {
    const laDir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(laDir, { recursive: true });
    const plistDest = path.join(laDir, 'com.codex.model-router.plist');
    fs.copyFileSync(plistSrc, plistDest);
    try { execSync(`launchctl unload "${plistDest}" 2>/dev/null`); } catch {}
    execSync(`launchctl load "${plistDest}"`);
    log('[ok] launchd autostart registered - waiting for router to come up...');
  }
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await probe(); }
  if (!up) {
    // fallback: start manually this session
    const child = spawn(process.execPath, ['server.mjs'], { cwd: routerDir, detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 20 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await probe(); }
  }
  if (!up) fail('router did not start - check /tmp/codex-model-router.err.log');
  log('[ok] router started on http://127.0.0.1:8788');
} else {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: routerDir, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  let up = false;
  for (let i = 0; i < 20 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await probe(); }
  if (!up) fail('router did not start - run start.cmd inside codex-model-router manually to see the error');
  log('[ok] router started on http://127.0.0.1:8788');
}

// 6. quick end-to-end test through the router (autostart already registered on mac in step 5)
const test = await new Promise((resolve) => {
  const body = JSON.stringify({ model: 'wbm-deepseek-v4.1-flash', input: 'hi', max_output_tokens: 16, stream: false });
  const req = http.request('http://127.0.0.1:8788/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local-router' } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(r.statusCode === 200));
  });
  req.on('error', () => resolve(false));
  req.write(body); req.end();
});
log(test ? '[ok] end-to-end test PASSED (wbm-deepseek-v4.1-flash replied)' : '[warn] end-to-end test failed - check network/proxy and keys');

log('');
log('================ DONE ================');
log('1. (Re)start Codex desktop - the wbm-/wb2- models are now in the model picker.');
if (!IS_MAC) {
  log('2. Optional: double-click codex-model-router\\install-autostart.cmd');
  log('   so the router starts automatically every time you log in.');
} else {
  log('2. Autostart is already registered via launchd - nothing else to do.');
}
log('======================================');
