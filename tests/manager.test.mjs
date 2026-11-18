import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { createWriteStream, mkdir as mkdirCallback } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { connectSSH, endpoint, execute, fingerprint, parsePorts, probeBanner, probeKey, remotePath, scanHosts, shellQuote } from '../manager/core.mjs';
import { streamScreen } from '../manager/screen.mjs';
import { resolvePspPackage, uploadPspPackage } from '../manager/psp-package.mjs';
import { byteRange, mediaAsset, mediaPage, openMediaSftp } from '../manager/media.mjs';
const { Server, utils } = ssh2;

test('an unpacked PSP XMB release can be installed from a standalone manager', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'deck-manager-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'plugin');
  const destination = path.join(temporary, 'stage');
  await assert.rejects(resolvePspPackage(directory), /PSP_XMB_PACKAGE_DIR/);
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await mkdir(path.join(directory, 'sounds'));
  await mkdir(destination);
  for (const name of ['plugin.json', 'package.json', 'main.py', 'dist/index.js', 'sounds/menu.wav', '.local-notes']) {
    const contents = name === 'plugin.json' ? JSON.stringify({ name: 'PSP XMB' }) : name;
    await writeFile(path.join(directory, name), contents);
  }
  const sftp = { mkdir: mkdirCallback, createWriteStream };
  await uploadPspPackage(sftp, await resolvePspPackage(directory), destination);
  assert.equal(await readFile(path.join(destination, 'dist/index.js'), 'utf8'), 'dist/index.js');
  assert.equal(await readFile(path.join(destination, 'sounds/menu.wav'), 'utf8'), 'sounds/menu.wav');
  await assert.rejects(readFile(path.join(destination, '.local-notes')), { code: 'ENOENT' });
  await mkdir(path.join(directory, '.git'));
  await assert.rejects(resolvePspPackage(directory), /PSP_XMB_PACKAGE_DIR/);
});

test('concurrent gallery reads share one SFTP channel and recover if it closes', async () => {
  let opens = 0;
  const session = { client: { sftp(done) { opens++; setImmediate(() => done(null, new EventEmitter())); } } };
  const channels = await Promise.all(Array.from({ length: 36 }, () => openMediaSftp(session)));
  assert.equal(opens, 1);
  assert.equal(new Set(channels).size, 1);
  channels[0].emit('error', new Error('channel closed'));
  const replacement = await openMediaSftp(session);
  channels[0].emit('close');
  assert.equal(await openMediaSftp(session), replacement);
  assert.equal(opens, 2);
});

test('media URLs only grant the listed resources within the current SSH session', () => {
  const session = {}, other = {};
  const clip = { path: '/clips/a', kind: 'video', thumb: '/clips/a/thumbnail.jpg',
    manifest: '<MPD/>', parts: ['/clips/a/video/first', '/clips/a/video/second'] };
  const shot = { path: '/screenshots/кадр #1.jpg', kind: 'image' };
  const page = { items: [clip, shot], counts: { all: 2, image: 1, video: 1 } };
  const [video, image] = mediaPage(session, page).items;
  assert.equal(mediaPage(session, page).items[0].id, video.id);
  assert.notEqual(mediaPage(other, page).items[0].id, video.id);
  assert.equal(mediaAsset(other, video.id, 'thumb'), null);
  assert.deepEqual(mediaAsset(session, video.id, 'p1/chunk-stream0-00002.m4s'), { path: '/clips/a/video/second/chunk-stream0-00002.m4s' });
  for (const resource of ['file', 'download', 'p0/clip.pb', 'p1/../clip.pb', 'p9/init-stream0.m4s']) {
    assert.equal(mediaAsset(session, video.id, resource), null);
  }
  assert.equal(image.thumbnail, image.url);
  assert.deepEqual(mediaAsset(session, image.id, 'download'), { path: shot.path, download: true });
});

test('byte ranges for video seeking include the last byte and support suffix probes', () => {
  assert.deepEqual(byteRange('bytes=0-0', 12), { start: 0, end: 0 });
  assert.deepEqual(byteRange('bytes=4-', 12), { start: 4, end: 11 });
  assert.deepEqual(byteRange('bytes=-4', 12), { start: 8, end: 11 });
  assert.deepEqual(byteRange('bytes=2-99', 12), { start: 2, end: 11 });
  assert.deepEqual(byteRange('bytes=-99', 12), { start: 0, end: 11 });
  for (const range of ['bytes=12-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=0-0,3-4']) {
    assert.equal(byteRange(range, 12), false);
  }
  assert.equal(byteRange(undefined, 12), null);
  assert.equal(byteRange('bytes=0-0', 0), false);
});

test('connection input rejects shell/options injection and invalid ports', () => {
  assert.deepEqual(endpoint({ host: 'deck.local', port: '2222' }), { host: 'deck.local', port: 2222 });
  for (const host of ['-oProxyCommand=x', 'x;touch /tmp/test', 'a b', '']) assert.throws(() => endpoint({ host }));
  for (const port of [0, -1, 65536, 2.5, 'no']) assert.throws(() => endpoint({ host: 'deck.local', port }));
  assert.deepEqual(parsePorts('22,2222,2200-2202,22'), [22, 2222, 2200, 2201, 2202]);
  for (const ports of ['1-65535', '3-1', '0', '22,no', '65536']) assert.throws(() => parsePorts(ports));
  assert.throws(() => scanHosts({ subnet: '8.8.8.0/24' }));
  assert.equal(remotePath('~/Games/a b', '/home/deck'), '/home/deck/Games/a b');
  assert.throws(() => remotePath('relative/path', '/home/deck'));
  assert.equal(shellQuote("a'; echo secret"), "'a'\\''; echo secret'");
});

test('discovery verifies an SSH banner rather than a generic open TCP port', async t => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.end('HTTP/1.1 200 OK\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { sockets.forEach(s => s.destroy()); server.close(); });
  assert.equal(await probeBanner('127.0.0.1', server.address().port), null);
});

test('SSH handshake pins the host key, authenticates, executes stdin and preserves exit status', async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const clients = new Set();
  const binary = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]);
  let captureStopped, failCapture = false;
  const server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'deck' && ctx.password === 'test-only' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (accept, _reject, request) => {
        const channel = accept();
        if (request.command.startsWith('exec python3 -c ')) {
          if (failCapture) {
            channel.stderr.write('Экран недоступен');
            channel.exit(1); channel.end();
          } else {
            channel.write(binary);
            channel.on('close', () => captureStopped());
            channel.resume();
          }
          return;
        }
        if (request.command === 'hang') return;
        let input = ''; channel.on('data', chunk => input += chunk.toString());
        channel.on('end', () => {
          if (request.command === 'overflow') channel.write('x'.repeat(4096));
          else { channel.write('Привет ' + input); channel.stderr.write('warning'); }
          channel.exit(7); channel.end();
        });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { clients.forEach(c => c.end()); server.close(); });
  const target = { host: '127.0.0.1', port: server.address().port };
  assert.match((await probeBanner(target.host, target.port)).banner, /^SSH-2.0-/);
  const expected = fingerprint(utils.parseKey(privateKey).getPublicSSH());
  assert.equal(await probeKey(target), expected);
  await assert.rejects(connectSSH({ ...target, username: 'deck', password: 'test-only' }, 'SHA256:wrong'));
  await assert.rejects(connectSSH({ ...target, username: 'deck', password: 'wrong' }, expected));
  const client = await connectSSH({ ...target, username: 'deck', password: 'test-only' }, expected);
  t.after(() => client.end());
  const result = await execute(client, 'echo', 'мир');
  assert.equal(result.stdout, 'Привет мир'); assert.equal(result.stderr, 'warning'); assert.equal(result.code, 7);
  await assert.rejects(execute(client, 'overflow', '', { maxOutput: 100 }), /2 МБ/);
  await assert.rejects(execute(client, 'hang', '', { timeout: 80 }), /SIGTERM/);
  await t.test('screen preserves binary frames and closing the viewer releases only its SSH channel', { timeout: 5000 }, async () => {
    const response = new PassThrough(), closed = new Promise(resolve => { captureStopped = resolve; });
    let mime;
    response.setHeader = (_name, value) => { mime = value; };
    const received = once(response, 'data'), running = streamScreen(client, response);
    const [bytes] = await received;
    assert.deepEqual(bytes, binary);
    assert.equal(mime, 'multipart/x-mixed-replace; boundary=deckframe');
    response.destroy();
    await running; await closed;
    assert.equal((await execute(client, 'echo', 'ok')).stdout, 'Привет ok');
  });
  await t.test('screen reports diagnostics when capture stops before the first frame', async () => {
    failCapture = true;
    const response = new PassThrough();
    response.setHeader = () => {};
    await assert.rejects(streamScreen(client, response), /Экран недоступен/);
    assert.equal(response.readableLength, 0);
    response.destroy();
  });
});
