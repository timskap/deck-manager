import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path/posix';
import { pipeline } from 'node:stream/promises';
import { openSftp, sftpCall } from './core.mjs';

const types = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4s': 'video/iso.segment',
};

export function mediaPage(session, { items, counts }) {
  // A browser media element cannot attach the API header. Give it a capability
  // for one catalogued item, valid only for this SSH connection.
  const catalog = session.media ??= { key: randomBytes(32), items: new Map() };
  return { counts, items: items.map(item => {
    const id = createHmac('sha256', catalog.key).update(item.path).digest('base64url');
    catalog.items.set(id, item);
    const base = '/api/media/' + id;
    const { kind, name, game, time, size, duration } = item;
    return { id, kind, name, game, time, size, duration, dash: !!item.manifest,
      url: base + (item.manifest ? '/clip.mpd' : '/file'),
      thumbnail: item.thumb ? base + '/thumb' : kind === 'image' ? base + '/file' : null,
      download: item.manifest ? null : base + '/download' };
  }) };
}

export function mediaAsset(session, id, resource) {
  const item = session.media?.items.get(id);
  if (!item) return null;
  if (resource === 'clip.mpd' && item.manifest) return { manifest: item.manifest };
  if (resource === 'thumb' && item.thumb) return { path: item.thumb };
  if (!item.manifest && (resource === 'file' || resource === 'download')) {
    return { path: item.path, download: resource === 'download' };
  }
  const segment = /^p(\d+)\/((?:init-stream\d+|chunk-stream\d+-\d+)\.m4s)$/.exec(resource);
  const folder = segment && item.parts?.[Number(segment[1])];
  return folder ? { path: path.join(folder, segment[2]) } : null;
}

export function openMediaSftp(session) {
  // SFTP multiplexes file handles. One channel serves all thumbnails and DASH
  // tracks, including when several browser tabs share the same Deck session.
  if (session.mediaChannel) return session.mediaChannel;
  const forget = () => { if (session.mediaChannel === opening) delete session.mediaChannel; };
  const opening = openSftp(session.client).then(channel => {
    channel.once('close', forget);
    channel.on('error', forget);
    return channel;
  }, error => { forget(); throw error; });
  session.mediaChannel = opening;
  return opening;
}

// Return inclusive offsets, or false for an unsatisfiable single-range request.
export function byteRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return false;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return false;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start > end ? false : { start, end };
}

export async function sendMediaFile(sftp, asset, req, res) {
  if (res.destroyed) return;
  const missing = () => Object.assign(new Error('Файл больше не доступен на Steam Deck.'), { status: 404 });
  let info;
  try {
    // Reject files or parent directories replaced with symlinks since the scan.
    if (await sftpCall(sftp, 'realpath', asset.path) !== asset.path) throw missing();
    info = await sftpCall(sftp, 'lstat', asset.path);
  } catch (error) {
    if (error.code === 2) throw missing();
    throw error;
  }
  if (!info.isFile()) throw missing();
  if (res.destroyed) return;
  const range = byteRange(req.headers.range, info.size);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range === false) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + info.size });
    return res.end();
  }
  const length = range ? range.end - range.start + 1 : info.size;
  res.setHeader('Content-Type', types[path.extname(asset.path).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', length);
  if (asset.download) res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(asset.path)));
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
  }
  if (req.method === 'HEAD' || !length) return res.end();
  await pipeline(sftp.createReadStream(asset.path, range || { start: 0, end: length - 1 }), res);
}
