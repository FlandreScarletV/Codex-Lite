import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {archive, replaceFile} from './asar.mjs';
import {updateIntegrity} from './asar-integrity.mjs';

// Only desktop isolation; no composer, model observer or network proxy patches.
const [source, destination, executable] = process.argv.slice(2);
try {
  const original = fs.readFileSync(source), ar = archive(original);
  let bytes = original, trayCount = 0, closeCount = 0;
  const trayId = crypto.randomUUID();
  for (const [name, entry] of ar.entries) {
    if (entry.unpacked || entry.link || !name.startsWith('.vite/') || !name.endsWith('.js')) continue;
    let code = ar.read(name).toString(), changed = false;
    const tray = /new ([\w$]+)\.Tray\(([^,]+),process\.platform===`win32`&&\1\.app\.isPackaged\?([\w$]+)\(([^)]+)\):void 0\)/g;
    const hits = [...code.matchAll(tray)];
    trayCount += hits.length;
    if (hits.length) {
      code = code.replace(tray, `new $1.Tray($2,process.platform===\`win32\`?\`${trayId}\`:void 0)`);
      changed = true;
    }
    const close = /\.on\(`close`,e=>\{(?=[\s\S]{0,400}?this\.persistPrimaryWindowBounds\([\w$]+\);let [\w$]+=this\.getPrimaryWindows\(\)\.some\()/g;
    const closures = [...code.matchAll(close)];
    closeCount += closures.length;
    if (closures.length) {
      code = code.replace(close, '$&if(!this.isAppQuitting){e.preventDefault();setImmediate(()=>{const a=require(`electron`).app;a.once(`will-quit`,()=>{const t=setTimeout(()=>a.exit(0),10000);t.unref()});a.quit()});return}');
      changed = true;
    }
    if (changed) {
      const check = spawnSync(process.execPath, ['--check'], {input:code,encoding:'utf8'});
      if (check.status !== 0) throw Error(`Syntax failed: ${name}: ${check.stderr}`);
      bytes = replaceFile(bytes, name, Buffer.from(code));
    }
  }
  if (trayCount !== 1 || closeCount !== 1) throw Error(`Desktop isolation unsupported: tray=${trayCount}, close=${closeCount}`);
  fs.writeFileSync(destination, bytes, {flag:'wx'});
  const integrity = updateIntegrity(source, destination, executable);
  console.log(JSON.stringify({version:JSON.parse(ar.read('package.json')).version,trayId,...integrity}));
} catch (error) { console.error(error.message); process.exitCode=1; }
