import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { sftpCall } from './core.mjs';

const siblingBuild = fileURLToPath(new URL('../../psp-xmb/release/psp-xmb/', import.meta.url));
export async function resolvePspPackage(directory = process.env.PSP_XMB_PACKAGE_DIR || siblingBuild) {
  try {
    const root = await realpath(directory);
    const entries = await readdir(root);
    if (entries.some(name => ['.git', 'node_modules', 'src'].includes(name))) throw new Error('Expected a packaged plugin');
    for (const name of ['plugin.json', 'package.json', 'main.py', 'dist/index.js']) {
      const file = path.join(root, name);
      if (await realpath(file) !== file || !(await stat(file)).isFile()) throw new Error('Invalid package file');
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
    if (manifest.name !== 'PSP XMB') throw new Error('Invalid plugin name');
    return root;
  } catch (cause) {
    throw new Error('Укажите папку распакованной сборки PSP XMB в PSP_XMB_PACKAGE_DIR или выполните npm run build в соседнем репозитории psp-xmb.', { cause });
  }
}

// A release can ship additional assets such as fonts and audio alongside its entry points.
export async function uploadPspPackage(sftp, local, destination) {
  for (const entry of await readdir(local, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(local, entry.name);
    const target = path.posix.join(destination, entry.name);
    if (entry.isDirectory()) {
      await sftpCall(sftp, 'mkdir', target);
      await uploadPspPackage(sftp, source, target);
    } else if (entry.isFile()) {
      await pipeline(createReadStream(source), sftp.createWriteStream(target, { flags: 'wx' }));
    } else {
      throw new Error('Ссылки в пакете плагина не поддерживаются.');
    }
  }
}
