import fs from 'node:fs';
import path from 'node:path';
import { check, EditError } from './errors.js';

const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const natural = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

// Read dimensions from the image container. Playback still checks actual decoding.
export function imageDimensions(bytes) {
  let width, height;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    check(bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'IMAGE_FORMAT', 'En-tête PNG invalide.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      check(offset + 12 + size <= bytes.length, 'IMAGE_FORMAT', 'PNG tronqué.');
      if (kind === 'IDAT' && size) data = true;
      if (kind === 'IEND') { ended = size === 0; break; }
      offset += size + 12;
    }
    check(data && ended, 'IMAGE_FORMAT', 'PNG incomplet.');
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      check(bytes[offset++] === 0xff, 'IMAGE_FORMAT', 'Marqueur JPEG invalide.');
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      check(offset + 2 <= bytes.length, 'IMAGE_FORMAT', 'JPEG tronqué.');
      const size = bytes.readUInt16BE(offset);
      check(size >= 2 && offset + size <= bytes.length, 'IMAGE_FORMAT', 'Segment JPEG invalide.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        check(size >= 8, 'IMAGE_FORMAT', 'Dimensions JPEG absentes.');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    check(bytes.readUInt32LE(4) + 8 === bytes.length, 'IMAGE_FORMAT', 'WebP tronqué.');
    const kind = bytes.toString('ascii', 12, 16), size = bytes.readUInt32LE(16);
    check(20 + size <= bytes.length, 'IMAGE_FORMAT', 'Segment WebP invalide.');
    if (kind === 'VP8X' && size >= 10) {
      check(!(bytes[20] & 2), 'IMAGE_FORMAT', 'Les WebP animés ne sont pas pris en charge.');
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8 ' && size >= 10 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && size >= 5 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 32768 && height <= 32768 && width * height <= 100000000,
    'IMAGE_FORMAT', 'Image non reconnue ou dimensions trop grandes. Formats acceptés : PNG, JPEG et WebP fixes.');
  return { width, height };
}

export function scanFlowFolder(folder) {
  check(typeof folder === 'string' && path.isAbsolute(folder) && fs.existsSync(folder), 'FLOW_FOLDER', 'Choisissez un dossier local d’images Flow.');
  const root = fs.realpathSync(folder);
  check(fs.statSync(root).isDirectory(), 'FLOW_FOLDER', 'Le chemin Flow doit être un dossier.');
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const candidates = entries.filter(e => !e.name.startsWith('.') && extensions.has(path.extname(e.name).toLowerCase()));
  check(candidates.length > 0 && candidates.length <= 10000, 'FLOW_COUNT', 'Le dossier doit contenir entre 1 et 10 000 images PNG, JPEG ou WebP fixes.');
  const visuals = candidates.map(entry => {
    const file = path.join(root, entry.name);
    check(entry.isFile() && !entry.isSymbolicLink(), 'FLOW_FILE', `Image liée ou non régulière refusée : ${entry.name}.`);
    const stat = fs.lstatSync(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 64 * 1024 * 1024, 'FLOW_FILE', `Image vide ou supérieure à 64 Mo : ${entry.name}.`);
    let dimensions;
    try { dimensions = imageDimensions(fs.readFileSync(file)); }
    catch (e) { throw new EditError(e.code || 'FLOW_FILE', `${entry.name} : ${e.message}`); }
    return { path: file, name: entry.name, type: 'photo', durationUs: 0, ...dimensions };
  }).sort((a, b) => natural.compare(a.name, b.name) || a.name.localeCompare(b.name));
  return { folder: root, visuals, ignored: entries.length - candidates.length };
}
