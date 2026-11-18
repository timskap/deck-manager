import { readFile } from 'node:fs/promises';
import { shellQuote } from './core.mjs';

const helper = await readFile(new URL('./capture.py', import.meta.url), 'utf8');
const captureCommand = 'exec python3 -c ' + shellQuote(helper);

// Keep stdin open while the viewer is present. The Deck also watches it for
// EOF so that closing the browser releases the encoder even on a static screen.
export function streamScreen(client, res) {
  return new Promise((resolve, reject) => {
    let channel, finished = false, diagnostic = '';
    const firstFrameTimeout = setTimeout(() => finish(new Error('Deck не передаёт кадры. Проверьте, что его экран включён.')), 12000);
    const disconnected = () => finish(new Error('SSH-соединение с Deck закрыто.'));
    const cancelled = () => finish();

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(firstFrameTimeout);
      client.off('close', disconnected);
      res.off('close', cancelled);
      if (channel) {
        channel.unpipe(res);
        channel.end();
        channel.close();
      }
      if (error) reject(error);
      else resolve();
    }

    client.once('close', disconnected);
    res.once('close', cancelled);
    client.exec(captureCommand, (error, stream) => {
      if (error) return finish(error);
      stream.on('error', finish);
      if (finished || res.destroyed) {
        stream.end();
        stream.close();
        return finish();
      }
      channel = stream;
      stream.stderr.on('data', part => { diagnostic = (diagnostic + part.toString()).slice(-1800); });
      res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=deckframe');
      stream.once('data', () => clearTimeout(firstFrameTimeout));
      stream.once('close', () => finish(new Error(diagnostic.trim() || 'Deck завершил трансляцию. Запустите её снова.')));
      stream.pipe(res, { end: false });
    });
  });
}
