import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
export class MediaServer {
  constructor() { this.files = new Map(); }
  // Scopes keep library covers alive while project media is replaced.
  clear(scope = null) { if (scope === null) this.files.clear(); else for (const [k, v] of this.files) if (v.scope === scope) this.files.delete(k); }
  grant(items, scope = 'project') {
    this.clear(scope); const urls = {};
    for (const item of items) {
      try {
        const real = fs.realpathSync(item.path), stat = fs.statSync(real), type = types[path.extname(real).toLowerCase()];
        if (!stat.isFile() || !stat.size || !type) continue;
        const token = randomUUID(); this.files.set(token, { real, size: stat.size, mtimeMs: stat.mtimeMs, type, scope });
        urls[item.path] = `elpo-media://local/${token}`;
      } catch { /* absent or unsupported files have no playback grant */ }
    }
    return urls;
  }
  async handle(request) {
    const url = new URL(request.url), token = url.pathname.slice(1), entry = this.files.get(token);
    if (url.hostname !== 'local' || url.search || !entry) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let fd;
    try {
      fd = fs.openSync(entry.real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) { fs.closeSync(fd); return new Response(null, { status: 409 }); }
      let start = 0, end = stat.size - 1, status = 200;
      const range = request.headers.get('range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || !m[1] && !m[2]) { fs.closeSync(fd); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } }); }
        if (!m[1]) start = Math.max(0, stat.size - Number(m[2]));
        else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { fs.closeSync(fd); return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } }); }
        status = 206;
      }
      const headers = { 'Content-Type': entry.type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      if (request.method === 'HEAD') { fs.closeSync(fd); return new Response(null, { status, headers }); }
      return new Response(Readable.toWeb(fs.createReadStream(entry.real, { fd, autoClose: true, start, end })), { status, headers });
    } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return new Response(null, { status: 404 }); }
  }
}
