import fs from 'node:fs';
import crypto from 'node:crypto';
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function archive(bytes) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw Error('Invalid ASAR prefix');
  const size = bytes.readUInt32LE(4), length = bytes.readUInt32LE(12);
  const base = 8 + size;
  if (length > size - 8 || base > bytes.length) throw Error('Invalid ASAR header bounds');
  const header = JSON.parse(bytes.subarray(16, 16 + length).toString());
  const entries = new Map();
  function walk(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files || {})) {
      if (!name || name === '..' || name.includes('/') || name.includes('\\')) throw Error('Unsafe ASAR name');
      const key = prefix + name;
      if (entry.files) walk(entry, key + '/');
      else entries.set(key, entry);
    }
  }
  walk(header);
  function read(name) {
    const entry = entries.get(name);
    if (!entry || entry.unpacked || entry.link) throw Error('Not a packed file: ' + name);
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size)
      || entry.size < 0 || base + offset + entry.size > bytes.length) throw Error('Invalid ASAR file bounds');
    return bytes.subarray(base + offset, base + offset + entry.size);
  }
  return {header, entries, base, read};
}

export function replaceFile(original, filename, replacement, stateFile = false) {
  const source = archive(original), entry = source.entries.get(filename);
  source.read(filename);
  const blockSize = entry.integrity?.blockSize || 4194304;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw Error('Invalid integrity block size');
  const blocks = [];
  for (let at = 0; at < replacement.length; at += blockSize) blocks.push(sha256(replacement.subarray(at, at + blockSize)));
  entry.offset = String(original.length - source.base);
  entry.size = replacement.length;
  entry.integrity = {algorithm: 'SHA256', hash: sha256(replacement), blockSize, blocks};
  if (stateFile) {
    if (source.header.files.webview.files['inspector-state.json']) throw Error('Unexpected existing Inspector state');
    source.header.files.webview.files['inspector-state.json'] = {size:16384,unpacked:true};
  }
  const json = Buffer.from(JSON.stringify(source.header));
  const payloadLength = 4 + json.length, padded = Math.ceil(payloadLength / 4) * 4;
  const prefix = Buffer.alloc(12 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + padded, 4);
  prefix.writeUInt32LE(padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  const result = Buffer.concat([prefix, original.subarray(source.base), replacement]);
  const next = archive(result);
  for (const [name, old] of archive(original).entries) {
    if (old.unpacked || old.link) continue;
    const expected = name === filename ? replacement : archiveRead(source, original, name);
    if (!next.read(name).equals(expected)) throw Error('Round-trip verification failed: ' + name);
  }
  return result;
}
function archiveRead(source, original, name) {
  // source's target entry was updated above. Other entries remain identical.
  return source.read(name);
}
export function writeNewAtomic(filename, bytes) {
  if (fs.existsSync(filename)) throw Error('Refusing to overwrite: ' + filename);
  const temp = filename + '.tmp-' + process.pid;
  fs.writeFileSync(temp, bytes, {flag: 'wx'});
  try {
    if (sha256(fs.readFileSync(temp)) !== sha256(bytes)) throw Error('Write verification failed');
    fs.renameSync(temp, filename);
  } catch (error) { fs.rmSync(temp, {force: true}); throw error; }
}
