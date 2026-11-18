import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { connectSSH, discover, endpoint, execute, fingerprint, networks, openSftp, probeKey, remotePath, sftpCall, shellQuote } from './core.mjs';
import { streamScreen } from './screen.mjs';
import { resolvePspPackage, uploadPspPackage } from './psp-package.mjs';
import { mediaAsset, mediaPage, openMediaSftp, sendMediaFile } from './media.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory), cache = path.join(root, '.cache/deck-manager');
// Read the helper for each call so local fixes do not interrupt an SSH session.
const token = randomBytes(32).toString('hex');
const port = Number(process.env.DECK_MANAGER_PORT || 8787);
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
await mkdir(cache, { recursive: true, mode: 0o700 });
const load = async (name, fallback) => { try { return JSON.parse(await readFile(path.join(cache, name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
const save = async (name, value) => {
  const temporary = path.join(cache, `${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path.join(cache, name));
};
const trust = await load('known-hosts.json', {});
let profile = await load('profile.json', { host: 'steamdeck.local', port: 22, username: 'deck' });
let pairedKey, pairedFingerprints = [];
try {
  pairedKey = await readFile(path.join(root, '.cache/pairing-private/deck_key'));
  const known = await readFile(path.join(root, '.cache/pairing-private/known_hosts'), 'utf8');
  pairedFingerprints = known.split('\n').filter(line => line && !line.startsWith('#')).map(line => fingerprint(Buffer.from(line.trim().split(/\s+/)[2], 'base64')));
} catch { /* Pairing is optional. */ }
let session = null, connecting = false, scanning = false;
const pendingKeys = new Map();
const downloads = new Map();
function requireSession() {
  if (!session) throw Object.assign(new Error('Подключитесь к Steam Deck.'), { status: 409 });
  return session;
}
async function remote(current, action, args = {}, sudo) {
  const helper = await readFile(path.join(directory, action === 'media-list' ? 'media.py' : 'remote.py'), 'utf8');
  let command = `python3 -c ${shellQuote(helper)}`;
  let input = JSON.stringify({ action, ...args });
  if (sudo !== undefined) {
    if (typeof sudo !== 'string' || /[\r\n]/.test(sudo)) throw new Error('Некорректный пароль sudo.');
    command = (sudo ? "sudo -S -p '' -- " : 'sudo -n -- ') + command + ' ' + shellQuote(current.home);
    if (sudo) input = sudo + '\n' + input;
  }
  const result = await execute(current.client, command, input);
  if (result.code !== 0) throw new Error(result.stderr || 'Для управления нужен Python 3 на Steam Deck.');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Steam Deck вернул некорректный ответ.'); }
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}
function message(error) {
  if (error.code === 'ECONNREFUSED') return 'SSH-порт закрыт. На Deck выполните: sudo systemctl enable --now sshd';
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'Адрес не найден. Укажите IP Steam Deck или запустите поиск в сети.';
  if (/authentication methods failed/i.test(error.message)) return 'Не удалось войти. Проверьте пользователя и пароль или выберите другой способ входа.';
  if (/timed out|timeout/i.test(error.message)) return 'Нет ответа. Проверьте, что Steam Deck включён и доступен в вашей сети.';
  if (/verification failed/i.test(error.message)) return 'SSH-ключ устройства изменился. Снова проверьте устройство.';
  return error.message || 'Не удалось выполнить действие.';
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Запрос слишком большой.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function withSftp(current, fn) {
  const sftp = await openSftp(current.client);
  try { return await fn(sftp); } finally { sftp.end(); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    if (!hosts.has(req.headers.host)) return json(res, { error: 'Invalid Host' }, 403);
    const origin = `http://${req.headers.host}`;
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, { error: 'Cross-origin access denied' }, 403);
    const url = new URL(req.url, origin), route = url.pathname;
    if (route === '/api/bootstrap' && req.method === 'GET') return json(res, { token, profile, hasPairedKey: !!pairedKey, networks: networks(), connected: !!session, screenStream: true });
    if (!route.startsWith('/api/')) {
      if (req.method !== 'GET') return json(res, { error: 'Method not allowed' }, 405);
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
        '/media.js': ['media.js', 'text/javascript'], '/dash-player.js': ['../../node_modules/dashjs/dist/modern/esm/dash.mediaplayer.min.js', 'text/javascript'] };
      if (!files[route]) return json(res, { error: 'Not found' }, 404);
      const [file, type] = files[route];
      res.setHeader('Content-Type', type + '; charset=utf-8');
      return res.end(await readFile(path.join(directory, 'public', file)));
    }
    const mediaRoute = /^\/api\/media\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(route);
    if (mediaRoute && (req.method === 'GET' || req.method === 'HEAD')) {
      const current = requireSession(), asset = mediaAsset(current, mediaRoute[1], mediaRoute[2]);
      if (!asset) return json(res, { error: 'Файл не найден. Обновите медиатеку.' }, 404);
      if (asset.manifest) {
        res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Content-Length': Buffer.byteLength(asset.manifest) });
        return res.end(req.method === 'HEAD' ? undefined : asset.manifest);
      }
      return await sendMediaFile(await openMediaSftp(current), asset, req, res);
    }
    let download;
    if (route === '/api/download' && req.method === 'GET' && url.searchParams.has('ticket')) {
      const ticket = url.searchParams.get('ticket'); download = downloads.get(ticket); downloads.delete(ticket);
      if (!download || download.expires < Date.now() || download.session !== session) return json(res, { error: 'Ссылка истекла. Скачайте файл заново.' }, 403);
    } else if (req.headers['x-deck-token'] !== token) return json(res, { error: 'Перезагрузите страницу менеджера.' }, 403);
    if (route === '/api/status' && req.method === 'GET') return json(res, session ? { connected: true, profile, info: await remote(session, 'status') } : { connected: false });
    if (route === '/api/scan' && req.method === 'POST') {
      if (scanning) throw new Error('Поиск уже идёт.');
      const data = await body(req); scanning = true;
      try { return json(res, { devices: await discover(data) }); } finally { scanning = false; }
    }
    if (route === '/api/probe' && req.method === 'POST') {
      const target = endpoint(await body(req)), id = `${target.host}:${target.port}`;
      const key = await probeKey(target);
      pendingKeys.set(id, { key, at: Date.now() });
      const known = trust[id];
      return json(res, { ...target, fingerprint: key, trusted: known === key || (!known && pairedFingerprints.includes(key)), changed: !!known && known !== key });
    }
    if (route === '/api/connect' && req.method === 'POST') {
      if (connecting) throw new Error('Подключение уже выполняется.');
      const data = await body(req), target = endpoint(data), id = `${target.host}:${target.port}`;
      const pending = pendingKeys.get(id);
      if (!pending || pending.key !== data.fingerprint || Date.now() - pending.at > 300000) throw new Error('Сначала проверьте устройство заново.');
      const isTrusted = trust[id] === pending.key || (!trust[id] && pairedFingerprints.includes(pending.key));
      if (!isTrusted && data.trust !== true) throw new Error('Подтвердите отпечаток SSH-ключа устройства.');
      const username = String(data.username || 'deck');
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(username)) throw new Error('Некорректное имя пользователя.');
      const options = { ...target, username };
      if (data.auth === 'paired') { if (!pairedKey) throw new Error('Сохранённого ключа нет.'); options.privateKey = pairedKey; }
      else if (data.auth === 'key') {
        if (typeof data.privateKey !== 'string' || data.privateKey.length > 32768) throw new Error('Выберите файл SSH-ключа.');
        options.privateKey = data.privateKey; options.passphrase = data.passphrase || undefined;
      } else if (data.auth === 'password') {
        if (typeof data.password !== 'string' || !data.password) throw new Error('Введите пароль пользователя Steam Deck.');
        options.password = data.password;
      } else throw new Error('Выберите способ входа.');
      connecting = true;
      let client;
      try {
        client = await connectSSH(options, pending.key);
        const current = { client }, info = await remote(current, 'status');
        current.home = info.home;
        trust[id] = pending.key;
        const nextProfile = { ...target, username, auth: data.auth };
        await save('known-hosts.json', trust); await save('profile.json', nextProfile);
        session?.client.end(); session = current; profile = nextProfile;
        client.on('close', () => { if (session === current) session = null; });
        return json(res, { connected: true, profile, info });
      } catch (e) { client?.end(); throw e; }
      finally { connecting = false; delete options.password; delete options.passphrase; delete options.privateKey; }
    }
    if (route === '/api/disconnect' && req.method === 'POST') { session?.client.end(); session = null; return json(res, { ok: true }); }
    const current = requireSession();
    if (route === '/api/media' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') || 'all', offset = Number(url.searchParams.get('offset') || 0);
      if (!['all', 'image', 'video'].includes(kind) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Некорректный запрос медиатеки.');
      return json(res, mediaPage(current, await remote(current, 'media-list', { kind, offset })));
    }
    if (route === '/api/screen' && req.method === 'GET') {
      res.setTimeout(0);
      return await streamScreen(current.client, res);
    }
    if (route === '/api/command' && req.method === 'POST') {
      const data = await body(req);
      if (typeof data.command !== 'string' || !data.command.trim() || data.command.length > 16000) throw new Error('Введите команду (до 16 000 символов).');
      return json(res, await execute(current.client, data.command, data.stdin || '', { timeout: 120000 }));
    }
    if (route === '/api/files' && req.method === 'GET') {
      const requested = remotePath(url.searchParams.get('path'), current.home);
      return json(res, await withSftp(current, async sftp => {
        const actual = await sftpCall(sftp, 'realpath', requested);
        const entries = await sftpCall(sftp, 'readdir', actual);
        return { path: actual, entries: entries.map(e => ({ name: e.filename, size: e.attrs.size, modified: e.attrs.mtime, directory: e.attrs.isDirectory(), symlink: e.attrs.isSymbolicLink() })) };
      }));
    }
    if (route === '/api/mkdir' && req.method === 'POST') {
      const data = await body(req), destination = remotePath(data.path, current.home);
      await withSftp(current, async sftp => {
        try { await sftpCall(sftp, 'mkdir', destination); }
        catch (error) { if (!data.existOk || !(await sftpCall(sftp, 'stat', destination).catch(() => null))?.isDirectory()) throw error; }
      });
      return json(res, { path: destination });
    }
    if (route === '/api/upload' && req.method === 'PUT') {
      const destination = remotePath(url.searchParams.get('path'), current.home);
      const temporary = path.posix.join(path.posix.dirname(destination), '.deck-upload-' + randomUUID());
      await withSftp(current, async sftp => {
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, next) { bytes += chunk.length; next(bytes > 32 * 1024 ** 3 ? new Error('Лимит файла: 32 ГБ.') : null, chunk); } });
        try {
          // SFTP v3 rename must fail when destination exists. Never overwrite user content.
          await pipeline(req, limit, sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
          await sftpCall(sftp, 'rename', temporary, destination);
        } catch (error) {
          await sftpCall(sftp, 'unlink', temporary).catch(() => {});
          if (await sftpCall(sftp, 'lstat', destination).catch(() => null)) throw new Error('Файл с этим именем уже существует; содержимое сохранено. Выберите другую папку или имя.');
          throw error;
        }
      });
      return json(res, { path: destination });
    }
    if (route === '/api/download-ticket' && req.method === 'POST') {
      const data = await body(req), source = remotePath(data.path, current.home);
      for (const [key, item] of downloads) if (item.expires < Date.now()) downloads.delete(key);
      const ticket = randomBytes(24).toString('hex'); downloads.set(ticket, { source, session: current, expires: Date.now() + 60000 });
      return json(res, { url: '/api/download?ticket=' + ticket });
    }
    if (route === '/api/download' && req.method === 'GET') {
      const source = download?.source || remotePath(url.searchParams.get('path'), current.home);
      return await withSftp(current, async sftp => {
        const info = await sftpCall(sftp, 'stat', source);
        if (!info.isFile()) throw new Error('Выберите файл.');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', info.size);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(source))}`);
        await pipeline(sftp.createReadStream(source), res);
      });
    }
    if (route === '/api/psp' && req.method === 'GET') return json(res, await remote(current, 'psp-get'));
    if (route === '/api/psp' && req.method === 'POST') return json(res, await remote(current, 'psp-set', { settings: await body(req) }));
    if (route === '/api/css' && req.method === 'POST') {
      const data = await body(req);
      if (data.method === 'prepare') return json(res, await remote(current, 'css-prepare'));
      return json(res, await remote(current, 'css', { method: data.method, args: data.args || {} }));
    }
    if (route === '/api/theme-install' && req.method === 'POST') return json(res, await remote(current, 'theme-install', { path: remotePath((await body(req)).path, current.home) }));
    if (route === '/api/psp-install' && req.method === 'POST') {
      const data = await body(req);
      const packagePath = await resolvePspPackage();
      const stage = await remote(current, 'psp-stage');
      await withSftp(current, sftp => uploadPspPackage(sftp, packagePath, stage));
      return json(res, await remote(current, 'psp-install', { stage }, data.password || ''));
    }
    if (route === '/api/restart-decky' && req.method === 'POST') {
      const data = await body(req);
      const password = data.password;
      if (password && /[\r\n]/.test(password)) throw new Error('Некорректный пароль.');
      const result = await execute(current.client, password ? "sudo -S -p '' -- systemctl restart plugin_loader" : 'sudo -n -- systemctl restart plugin_loader', password ? password + '\n' : '');
      if (result.code !== 0) throw new Error(result.stderr || 'Не удалось перезапустить Decky.');
      return json(res, { ok: true });
    }
    return json(res, { error: 'Not found' }, 404);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) json(res, { error: message(error) }, error.status || 400);
    else res.destroy();
  }
});
server.requestTimeout = 0;
server.setTimeout(5 * 60 * 1000);
server.listen(port, '127.0.0.1', () => console.log(`Deck Manager: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Используйте DECK_MANAGER_PORT=8788 npm run manager` : error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { session?.client.end(); server.close(); server.closeAllConnections(); });
