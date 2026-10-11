import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function headerHash(filename) {
  const fd = fs.openSync(filename, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, prefix.length, 0) !== prefix.length || prefix.readUInt32LE(0) !== 4) {
      throw Error('Invalid ASAR header');
    }
    const headerLength = prefix.readUInt32LE(12);
    const headerSize = prefix.readUInt32LE(4);
    if (headerLength < 2 || headerLength > headerSize - 8 || headerLength > 32 * 1024 * 1024) {
      throw Error('Invalid ASAR header bounds');
    }
    const header = Buffer.alloc(headerLength);
    if (fs.readSync(fd, header, 0, headerLength, 16) !== headerLength) throw Error('Truncated ASAR header');
    JSON.parse(header.toString('utf8'));
    return sha256(header);
  } finally {
    fs.closeSync(fd);
  }
}

function resource(binary) {
  const prefix = Buffer.from(JSON.stringify({file: 'resources\\app.asar', alg: 'SHA256', value: ''}).slice(0, -2));
  const locations = [];
  for (let from = 0; from < binary.length;) {
    const offset = binary.indexOf(prefix, from);
    if (offset < 0) break;
    locations.push(offset);
    from = offset + prefix.length;
  }
  if (locations.length === 0) return null;
  if (locations.length !== 1) throw Error(`Expected one ElectronAsar integrity resource; found ${locations.length}`);
  const valueOffset = locations[0] + prefix.length;
  const value = binary.subarray(valueOffset, valueOffset + 64).toString('ascii');
  if (!/^[0-9a-f]{64}$/.test(value) || binary.subarray(valueOffset + 64, valueOffset + 66).toString() !== '"}') {
    throw Error('Invalid ElectronAsar integrity resource');
  }
  return {valueOffset, value};
}

export function inspectIntegrity(sourceAsar, targetAsar, exePath) {
  const sourceHeaderHash = headerHash(sourceAsar);
  const targetHeaderHash = headerHash(targetAsar);
  const binary = fs.readFileSync(exePath);
  const embedded = resource(binary);
  return {sourceHeaderHash, targetHeaderHash, resourcePresent: Boolean(embedded), embeddedHeaderHash: embedded?.value ?? null,
    executableSha256: sha256(binary)};
}

export function updateIntegrity(sourceAsar, targetAsar, exePath) {
  const info = inspectIntegrity(sourceAsar, targetAsar, exePath);
  if (!info.resourcePresent) return {sourceExeSha256: info.executableSha256,
    patchedExeSha256: info.executableSha256, sourceHeaderHash: info.sourceHeaderHash,
    patchedHeaderHash: info.targetHeaderHash, integrityUpdated: false};
  if (info.embeddedHeaderHash !== info.sourceHeaderHash) {
    throw Error('Copied EXE does not match official ASAR header; refusing to modify it');
  }
  const binary = fs.readFileSync(exePath);
  const {valueOffset} = resource(binary);
  binary.write(info.targetHeaderHash, valueOffset, 64, 'ascii');
  const staged = exePath + '.integrity-staged';
  if (fs.existsSync(staged)) throw Error('Stale executable integrity staging file');
  fs.writeFileSync(staged, binary, {flag: 'wx'});
  try {
    const checked = inspectIntegrity(sourceAsar, targetAsar, staged);
    if (checked.embeddedHeaderHash !== checked.targetHeaderHash) throw Error('Executable integrity update failed');
    fs.renameSync(staged, exePath);
    return {sourceExeSha256: info.executableSha256, patchedExeSha256: checked.executableSha256,
      sourceHeaderHash: info.sourceHeaderHash, patchedHeaderHash: info.targetHeaderHash,
      integrityUpdated: true};
  } catch (error) {
    fs.rmSync(staged, {force: true});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, sourceAsar, targetAsar, exePath] = process.argv.slice(2);
    if (!sourceAsar || !targetAsar || !exePath || !['inspect', 'update'].includes(mode)) {
      throw Error('Usage: asar-integrity.mjs inspect|update SOURCE_ASAR PATCHED_ASAR EXE');
    }
    const result = mode === 'inspect'
      ? inspectIntegrity(sourceAsar, targetAsar, exePath)
      : updateIntegrity(sourceAsar, targetAsar, exePath);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
