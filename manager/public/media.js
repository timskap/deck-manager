const $ = selector => document.querySelector(selector);
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const date = item => dateFormat.format(new Date(item.time * 1000));
const title = item => item.game || (item.dash ? 'Запись Steam' : item.name);

function duration(seconds) {
  if (seconds < 1) return '< 1 с';
  const s = Math.floor(seconds);
  return [Math.floor(s / 3600) || null, Math.floor(s / 60) % 60, s % 60]
    .filter(value => value !== null).map((value, i) => i ? String(value).padStart(2, '0') : value).join(':');
}

export function createGallery({ api, element, size }) {
  const grid = $('#media-grid'), status = $('#media-status'), more = $('#more-media');
  const dialog = $('#media-dialog'), stage = $('#media-stage'), playStatus = $('#media-play-status');
  const filters = [...document.querySelectorAll('#media [data-kind]')];
  let kind = 'all', items = [], offset = 0, hasMore = false, loading = false, generation = 0;
  let selected = -1, player;

  function showStatus(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  function releasePlayer() {
    const video = stage.querySelector('video');
    if (video) {
      video.onerror = null;
      video.onloadeddata = null;
      video.pause();
      player?.reset();
      player = null;
      video.removeAttribute('src');
      video.load();
    }
    stage.replaceChildren();
    showStatus(playStatus, '');
  }

  function updateNavigation() {
    $('#media-prev').disabled = selected < 1;
    $('#media-next').disabled = loading || (selected >= items.length - 1 && !hasMore);
  }

  async function openItem(index) {
    const item = items[index];
    if (!item) return;
    releasePlayer();
    selected = index;
    $('#media-title').textContent = title(item);
    $('#media-detail').textContent = [date(item), item.dash ? duration(item.duration) : size(item.size),
      item.game && !item.dash ? item.name : ''].filter(Boolean).join(' · ');
    const link = $('#media-download');
    link.hidden = !item.download;
    if (item.download) { link.href = item.download; link.download = item.name; }
    else link.removeAttribute('href');
    updateNavigation();
    if (!dialog.open) dialog.showModal();
    if (item.kind === 'image') {
      const image = element('img');
      image.alt = title(item);
      image.onerror = () => { if (stage.contains(image)) showStatus(playStatus, 'Не удалось загрузить скриншот. Обновите медиатеку.'); };
      stage.append(image);
      image.src = item.url;
      return;
    }
    const video = element('video');
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    if (item.thumbnail) video.poster = item.thumbnail;
    const failed = () => {
      if (stage.contains(video)) showStatus(playStatus, item.download
        ? 'Не удалось воспроизвести видео. Можно скачать файл и открыть его в плеере.'
        : 'Не удалось открыть запись Steam. Проверьте подключение и поддержку кодека в браузере.');
    };
    video.onerror = failed;
    video.onloadeddata = () => showStatus(playStatus, '');
    stage.append(video);
    showStatus(playStatus, 'Загружаем видео…');
    if (!item.dash) { video.src = item.url; return; }
    try {
      const { MediaPlayer } = await import('/dash-player.js');
      if (!dialog.open || !stage.contains(video)) return;
      player = MediaPlayer().create();
      player.updateSettings({ debug: { logLevel: 0 }, streaming: { utcSynchronization: { enabled: false } } });
      // Steam can end a clip with several sub-second periods. The player's
      // default one-second tolerance would signal end-of-stream too early.
      player.on(MediaPlayer.events.STREAM_INITIALIZING, ({ streamInfo }) => {
        streamInfo.isLast = Math.round((streamInfo.start + streamInfo.duration) * 1000) === Math.round(item.duration * 1000);
      });
      player.on(MediaPlayer.events.ERROR, failed);
      player.initialize(video, item.url, true);
    } catch { failed(); }
  }

  function card(item, index) {
    const button = element('button', undefined, 'media-card');
    button.type = 'button';
    button.setAttribute('aria-label', (item.kind === 'image' ? 'Скриншот' : 'Видео') + ' · ' + title(item) + ' · ' + date(item));
    const cover = element('span', undefined, 'media-cover');
    cover.setAttribute('aria-hidden', 'true');
    if (item.thumbnail) {
      const image = element('img');
      image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      image.onerror = () => {
        image.onerror = () => image.remove();
        setTimeout(() => {
          if (image.isConnected) image.src = item.kind === 'image' ? item.url : item.thumbnail;
        }, 400);
      };
      image.src = item.thumbnail;
      cover.append(image);
    }
    if (item.kind === 'video') {
      cover.append(element('span', '▶', 'media-play'));
      if (item.duration) cover.append(element('span', duration(item.duration), 'media-length'));
    }
    const caption = element('span', undefined, 'media-caption');
    caption.append(element('strong', title(item)), element('small', date(item)));
    button.append(cover, caption);
    button.onclick = () => openItem(index);
    return button;
  }

  async function load(append = false) {
    if (append && (loading || !hasMore)) return;
    const request = ++generation;
    if (!append) {
      items = []; offset = 0; hasMore = false;
      grid.replaceChildren();
      showStatus(status, 'Ищем скриншоты и видео на Steam Deck…');
    }
    loading = true;
    more.hidden = !append; more.disabled = true;
    grid.setAttribute('aria-busy', 'true');
    try {
      const page = await api(`media?kind=${kind}&offset=${offset}`);
      if (request !== generation) return;
      for (const filter of filters) filter.querySelector('span').textContent = page.counts[filter.dataset.kind];
      const known = new Set(items.map(item => item.id));
      for (const item of page.items) {
        if (known.has(item.id)) continue;
        grid.append(card(item, items.length)); items.push(item);
      }
      offset += page.items.length;
      hasMore = page.items.length > 0 && offset < page.counts[kind];
      const empty = { image: 'Скриншотов пока нет.', video: 'Сохранённых видео пока нет.', all: 'На Steam Deck пока нет скриншотов и видео.' };
      showStatus(status, items.length ? '' : empty[kind]);
    } catch (error) {
      if (request === generation) showStatus(status, 'Не удалось загрузить медиатеку. ' + error.message);
    } finally {
      if (request === generation) {
        loading = false; more.hidden = !hasMore; more.disabled = false;
        grid.setAttribute('aria-busy', 'false');
        updateNavigation();
      }
    }
  }

  function clear() {
    generation++;
    if (dialog.open) dialog.close();
    releasePlayer();
    selected = -1; items = []; offset = 0; loading = false; hasMore = false;
    grid.replaceChildren(); more.hidden = true;
    showStatus(status, '');
    for (const filter of filters) filter.querySelector('span').textContent = '';
  }

  for (const filter of filters) filter.onclick = () => {
    if (filter.dataset.kind === kind) return;
    kind = filter.dataset.kind;
    for (const button of filters) button.setAttribute('aria-pressed', String(button === filter));
    load();
  };
  $('#refresh-media').onclick = () => load();
  more.onclick = () => load(true);
  $('#media-close').onclick = () => dialog.close();
  dialog.onclose = () => { if (!dialog.open) { selected = -1; releasePlayer(); } };
  $('#media-prev').onclick = () => openItem(selected - 1);
  $('#media-next').onclick = async () => {
    const next = selected + 1;
    if (next === items.length) await load(true);
    if (dialog.open) openItem(next);
  };
  dialog.onkeydown = event => {
    if (items[selected]?.kind !== 'image') return;
    if (event.key === 'ArrowLeft') $('#media-prev').click();
    else if (event.key === 'ArrowRight') $('#media-next').click();
  };
  return { load, clear };
}
