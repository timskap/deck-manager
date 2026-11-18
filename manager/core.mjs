import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';

export const fingerprint = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export function endpoint(value) {
  const host = String(value.host || '').trim();
  const port = Number(value.port ?? 22);
  if (!host || host.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)) throw new Error('Укажите IP или имя Steam Deck.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть от 1 до 65535.');
  return { host, port };
}
export function parsePorts(value = '22,2222') {
  const result = new Set();
  for (const part of String(value).split(',')) {
    if (!/^\s*\d+(?:-\d+)?\s*$/.test(part)) throw new Error('Порты: 22,2222 или диапазон 2200-2230.');
    const [start, end = start] = part.trim().split('-').map(Number);
    if (start < 1 || end > 65535 || end < start || end - start > 127) throw new Error('Не больше 128 портов за поиск.');
    for (let n = start; n <= end; n++) result.add(n);
  }
  if (result.size > 128) throw new Error('Не больше 128 портов за поиск.');
  return [...result];
}
export function networks() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => addresses
    .filter(a => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    .map(a => ({ name, address: a.address, subnet: a.address.split('.').slice(0, 3).join('.') + '.0/24' })));
}
export function scanHosts({ host, subnet }) {
  if (host) return [endpoint({ host }).host];
  if (!networks().some(n => n.subnet === subnet)) throw new Error('Выберите локальную сеть этого компьютера.');
  const prefix = subnet.replace(/\.0\/24$/, '');
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
}
export function probeBanner(host, port, timeout = 900) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let buffer = '', done = false;
    const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('end', () => finish(null));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const banner = buffer.split(/\r?\n/).find(line => /^SSH-2\.0-/.test(line));
      if (banner) finish({ host, port, banner: banner.slice(0, 200) });
      else if (buffer.length > 4096) finish(null);
    });
  });
}
export async function discover(options) {
  const hosts = scanHosts(options), ports = parsePorts(options.ports);
  if (hosts.length * ports.length > 2048) throw new Error('Для поиска по всей сети выберите не больше 8 портов.');
  const jobs = hosts.flatMap(host => ports.map(port => ({ host, port }))), found = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(48, jobs.length) }, async () => {
    while (i < jobs.length) { const job = jobs[i++]; const result = await probeBanner(job.host, job.port, hosts.length === 1 ? 1800 : 900); if (result) found.push(result); }
  }));
  return found;
}
export function probeKey(target) {
  return new Promise((resolve, reject) => {
    const client = new Client(); let observed = false;
    client.on('error', error => { if (!observed) reject(error); });
    client.on('close', () => { if (!observed) reject(new Error('SSH завершил соединение до проверки ключа.')); });
    client.connect({ ...endpoint(target), username: 'deck', readyTimeout: 7000,
      hostVerifier(key) { observed = true; resolve(fingerprint(key)); return false; } });
  });
}
export function connectSSH(options, expectedFingerprint) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('close', () => reject(new Error('SSH завершил соединение во время входа.')));
    client.once('ready', () => resolve(client));
    client.on('error', reject);
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(p => !p.echo && /password/i.test(p.prompt) ? options.password || '' : ''));
    });
    client.connect({ ...options, readyTimeout: 12000, keepaliveInterval: 10000, keepaliveCountMax: 3,
      tryKeyboard: !!options.password, hostVerifier: key => fingerprint(key) === expectedFingerprint });
  });
}
export function execute(client, command, input = '', { timeout = 30000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let stream, done = false, stdout = '', stderr = '', size = 0;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); client.off('close', lost); error ? reject(error) : resolve(value); };
    const lost = () => finish(new Error('SSH-соединение потеряно.'));
    client.once('close', lost);
    const timer = setTimeout(() => { stream?.signal('TERM'); stream?.close(); finish(new Error('Команда превысила время ожидания; отправлен SIGTERM. Проверьте процессы на Deck.')); }, timeout);
    client.exec(command, (error, channel) => {
      if (error) return finish(error);
      stream = channel;
      if (done) return channel.close();
      const data = (chunk, isError) => {
        size += Buffer.byteLength(chunk);
        if (size > maxOutput) { channel.signal('TERM'); channel.close(); finish(new Error('Вывод превысил 2 МБ. Ограничьте его через head / tail.')); return; }
        if (isError) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      channel.setEncoding('utf8'); channel.stderr.setEncoding('utf8');
      channel.on('data', chunk => data(chunk, false));
      channel.stderr.on('data', chunk => data(chunk, true));
      channel.on('error', error => finish(error));
      channel.on('close', (code, signal) => finish(null, { stdout, stderr, code: code ?? (signal ? 128 : 255), signal }));
      channel.end(input);
    });
  });
}
export const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const sftpCall = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
export const openSftp = client => sftpCall(client, 'sftp');
export function remotePath(value, home) {
  const path = String(value || home);
  if (path.includes('\0') || path.length > 4096) throw new Error('Некорректный путь.');
  const expanded = path === '~' ? home : path.startsWith('~/') ? home + path.slice(1) : path;
  if (!expanded.startsWith('/')) throw new Error('Используйте абсолютный путь или ~/…');
  return expanded;
}
