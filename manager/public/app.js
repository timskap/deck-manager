const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let token, connected = false, profile, info, verified, filePath = '~', psp, activeUpload, uploading = false;
let currentTab = 'connection';
const labels = { connection: 'Подключение', screen: 'Экран', media: 'Медиатека', files: 'Файлы', themes: 'Темы и Decky', terminal: 'Команды' };
function notify(text, error = false) { $('#notice').textContent = text; $('#notice').classList.toggle('error', error); $('#notice').hidden = false; }
function clearNotice() { $('#notice').hidden = true; }
async function api(route, data, method) {
  const response = await fetch('/api/' + route, { method: method || (data === undefined ? 'GET' : 'POST'), headers: { 'X-Deck-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Ошибка запроса.');
  return value;
}
async function busy(button, work) {
  const children = [...button.childNodes]; button.disabled = true; button.textContent = 'Подождите…';
  try { return await work(); } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; button.replaceChildren(...children); }
}
function size(bytes) { if (bytes === undefined || bytes === null) return '—'; if (bytes < 1024) return bytes + ' Б'; const units = ['КБ', 'МБ', 'ГБ', 'ТБ']; let n = bytes / 1024, i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toLocaleString('ru', { maximumFractionDigits: 1 }) + ' ' + units[i]; }
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function childPath(base, name) { return base.replace(/\/$/, '') + '/' + name; }
let gallery;
function setConnection(state) {
  const changedDevice = state.profile && ['host', 'port', 'username'].some(key => state.profile[key] !== profile?.[key]);
  const reloadGallery = currentTab === 'media' && state.connected && (!connected || changedDevice);
  if (connected && (!state.connected || changedDevice)) gallery?.clear();
  connected = state.connected; info = state.info; profile = state.profile || profile;
  if (!connected && screenRequest) stopScreen();
  $('#connection-badge').classList.toggle('connected', connected);
  $('#connection-badge').replaceChildren(element('i'), document.createTextNode(connected ? 'Подключён' : 'Не подключён'));
  $('#hero-status').textContent = connected ? 'УСТРОЙСТВО В СЕТИ' : 'ОЖИДАНИЕ ПОДКЛЮЧЕНИЯ';
  $('#device-name').textContent = info?.hostname || 'Steam Deck';
  $('#device-detail').textContent = connected ? `${profile.username}@${profile.host}:${profile.port}` : 'Найдите устройство в сети или укажите адрес вручную.';
  const stats = connected ? [profile.port, info.battery ? `${info.battery.percent}%` : '—', size(info.disk.free)] : ['—', '—', '—'];
  $$('#device-stats b').forEach((node, i) => node.textContent = stats[i]);
  $('#disconnect').hidden = !connected;
  $$('.offline').forEach(node => node.hidden = connected);
  $$('.online-content').forEach(node => node.hidden = !connected);
  $$('[data-online]').forEach(node => node.disabled = !connected);
  if (connected) $('#terminal-target').textContent = `${profile.username}@${info.hostname}`;
  if (reloadGallery) switchTab('media');
}
async function switchTab(name) {
  if (currentTab === 'media' && name !== 'media') gallery?.clear();
  if (name !== 'screen' && screenRequest) stopScreen();
  currentTab = name;
  $$('.view').forEach(view => view.hidden = view.id !== name);
  $$('.nav').forEach(button => { const active = button.dataset.tab === name; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#breadcrumb').textContent = 'Устройство / ' + labels[name];
  clearNotice();
  if (connected) {
    try {
      if (name === 'media') {
        const { createGallery } = await import('./media.js');
        if (currentTab !== name || !connected) return;
        gallery ??= createGallery({ api, element, size });
        await gallery.load();
      }
      if (name === 'files') await loadFiles();
      if (name === 'themes') await loadThemes();
    } catch (error) { if (currentTab === name) notify(error.message, true); }
  }
}
function navigate(name) {
  history.replaceState(null, '', '#' + name);
  return switchTab(name);
}
$$('[data-tab]').forEach(button => button.onclick = () => navigate(button.dataset.tab));
$$('[data-go]').forEach(button => button.onclick = () => navigate(button.dataset.go));
function openLinkedTab() {
  const name = location.hash.slice(1);
  return switchTab(Object.hasOwn(labels, name) ? name : 'connection');
}
window.addEventListener('hashchange', openLinkedTab);

let screenRequest = null, directScreen = false;
const screenCanvas = $('#screen-canvas'), screenStatus = $('#screen-status');
function stopScreen(message = 'Трансляция остановлена') {
  screenRequest?.abort();
  screenRequest = null;
  $('#screen-toggle').textContent = 'Начать трансляцию';
  $('#screen-format').textContent = '';
  screenCanvas.hidden = true;
  screenCanvas.getContext('2d').clearRect(0, 0, screenCanvas.width, screenCanvas.height);
  screenStatus.textContent = message;
  screenStatus.hidden = false;
}

// multipartmux supplies Content-Length for each JPEG. HTTP and SSH chunks can
// split the header or payload anywhere, or contain several complete frames.
async function* jpegFrames(body) {
  const reader = body.getReader(), decoder = new TextDecoder('ascii');
  let pending = new Uint8Array(0), length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (pending.length) {
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending); joined.set(value, pending.length);
        pending = joined;
      } else pending = value;
      while (pending.length) {
        if (!length) {
          const header = decoder.decode(pending.subarray(0, 512));
          const end = header.indexOf('\r\n\r\n');
          if (end < 0 && pending.length < 512) break;
          const size = end >= 0 && /\r\nContent-Length: *(\d+)\s*$/im.exec(header.slice(0, end));
          length = Number(size?.[1]);
          if (!length || length > 4 * 1024 * 1024) throw new Error('Некорректный кадр от Steam Deck.');
          pending = pending.subarray(end + 4);
        }
        if (pending.length < length) break;
        yield new Blob([pending.subarray(0, length)], { type: 'image/jpeg' });
        pending = pending.subarray(length);
        length = 0;
      }
    }
  } finally { reader.releaseLock(); }
}

// A manager already running when its web assets are updated still has the
// original buffered command API. Keep its password-authenticated session usable
// until its next restart. A short, finite capture also ends on its own if closed.
const burstCommand = [
  'set -o pipefail',
  'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
  'timeout 6 gst-launch-1.0 -q pipewiresrc target-object=gamescope do-timestamp=true',
].join('\n') + ' ! videorate drop-only=true ! video/x-raw,framerate=15/1 ! videoconvert ! videoscale' +
  ' ! video/x-raw,format=I420,width=768,height=480,pixel-aspect-ratio=1/1 ! jpegenc quality=65' +
  ' ! identity eos-after=7 ! multipartmux boundary=deckframe ! fdsink fd=1 sync=false | base64 -w0';
async function readScreenBurst(signal) {
  const response = await fetch('/api/command', { method: 'POST', signal,
    headers: { 'X-Deck-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: burstCommand }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'SSH-соединение закрыто.');
  if (result.code || !result.stdout) throw new Error('Включите экран Deck в игровом режиме и повторите запуск. ' + result.stderr.trim());
  const bytes = Uint8Array.from(atob(result.stdout), c => c.charCodeAt(0));
  return new Blob([bytes]).stream();
}
async function* compatibleScreenFrames(signal) {
  let next = readScreenBurst(signal);
  while (!signal.aborted) {
    const body = await next;
    if (signal.aborted) return;
    next = readScreenBurst(signal);
    next.catch(() => {}); // The viewer can stop during playback of this batch.
    for await (const frame of jpegFrames(body)) {
      if (signal.aborted) return;
      yield frame;
      await new Promise(resolve => setTimeout(resolve, 1000 / 15));
    }
  }
}
async function startScreen() {
  if (!connected || screenRequest) return;
  const request = new AbortController();
  screenRequest = request;
  $('#screen-toggle').textContent = 'Остановить';
  screenStatus.textContent = 'Ожидание кадра с Deck…';
  try {
    let frames;
    if (directScreen) {
      const response = await fetch('/api/screen', { signal: request.signal, headers: { 'X-Deck-Token': token } });
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось начать трансляцию.');
      frames = jpegFrames(response.body);
    } else frames = compatibleScreenFrames(request.signal);
    const context = screenCanvas.getContext('2d');
    let count = 0, since;
    for await (const frame of frames) {
      const bitmap = await createImageBitmap(frame);
      try {
        if (request.signal.aborted) return;
        if (screenCanvas.width !== bitmap.width || screenCanvas.height !== bitmap.height) {
          screenCanvas.width = bitmap.width; screenCanvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
      } finally { bitmap.close(); }
      screenCanvas.hidden = false; screenStatus.hidden = true;
      const now = performance.now(), dimensions = screenCanvas.width + ' × ' + screenCanvas.height;
      if (since === undefined) {
        since = now;
        $('#screen-format').textContent = dimensions;
      } else {
        count++;
        if (now - since >= 1000) {
          $('#screen-format').textContent = dimensions + ' · ' + Math.round(count * 1000 / (now - since)) + ' кадр/с';
          count = 0; since = now;
        }
      }
    }
    throw new Error('Трансляция завершилась. Можно запустить её снова.');
  } catch (error) {
    if (screenRequest === request) stopScreen(error.message);
  }
}
$('#screen-toggle').onclick = () => screenRequest ? stopScreen() : startScreen();
$('#screen-fullscreen').hidden = !document.fullscreenEnabled;
$('#screen-fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#screen-player').requestFullscreen();
  } catch (error) { notify(error.message, true); }
};
document.addEventListener('fullscreenchange', () => {
  $('#screen-fullscreen').textContent = document.fullscreenElement ? 'Свернуть' : 'На весь экран';
});
window.addEventListener('pagehide', () => { if (screenRequest) stopScreen(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && screenRequest) stopScreen(); });
function authFields() {
  $('#password-field').hidden = $('#auth').value !== 'password';
  $('#key-fields').hidden = $('#auth').value !== 'key';
  $('#paired-help').hidden = $('#auth').value !== 'paired';
}
$('#auth').onchange = authFields;
for (const id of ['host', 'port']) $('#' + id).oninput = () => { verified = null; $('#fingerprint-panel').hidden = true; $('#trust').checked = false; };
$('#scan-form').onsubmit = event => { event.preventDefault(); busy($('#scan-button'), async () => {
  clearNotice(); $('#scan-results').replaceChildren(element('p', 'Ищем SSH-серверы… Обычно это занимает 10–30 секунд.', 'empty-small'));
  try {
    const result = await api('scan', { host: $('#scan-host').value.trim(), subnet: $('#network').value, ports: $('#scan-ports').value });
    $('#scan-results').replaceChildren();
    if (!result.devices.length) $('#scan-results').append(element('p', 'SSH не найден. Проверьте питание Deck, сеть и службу sshd. Для нестандартного порта задайте диапазон.', 'empty-small'));
    for (const device of result.devices) {
      const row = element('div', undefined, 'found-device'), text = element('div', `${device.host}:${device.port}`), button = element('button', 'Выбрать', 'text-button');
      text.append(element('small', device.banner));
      button.onclick = () => { $('#host').value = device.host; $('#port').value = device.port; verified = null; $('#fingerprint-panel').hidden = true; $('#trust').checked = false; $('#host').focus(); };
      row.append(text, button); $('#scan-results').append(row);
    }
  } catch (error) { $('#scan-results').replaceChildren(element('p', error.message, 'empty-small')); throw error; }
}); };
$('#connect-form').onsubmit = event => { event.preventDefault(); busy($('#connect-button'), async () => {
  clearNotice();
  const target = { host: $('#host').value.trim(), port: Number($('#port').value) };
  if (!verified || verified.host !== target.host || verified.port !== target.port) {
    verified = await api('probe', target);
    $('#fingerprint-panel').hidden = false;
    $('#fingerprint').textContent = verified.fingerprint;
    $('#fingerprint-label').textContent = verified.changed ? 'Ключ изменился! Сверьте отпечаток с устройством перед входом.' : verified.trusted ? 'Знакомое устройство · ключ проверен' : 'Первое подключение · проверьте SSH-ключ устройства';
    $('#trust-label').hidden = verified.trusted;
    $('#trust').checked = false;
  }
  if (!verified.trusted && !$('#trust').checked) { notify('Сверьте отпечаток с Deck и отметьте доверие ключу. На Deck: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'); return; }
  const data = { ...target, username: $('#username').value, auth: $('#auth').value, fingerprint: verified.fingerprint, trust: $('#trust').checked };
  if (data.auth === 'password') data.password = $('#password').value;
  if (data.auth === 'key') { const file = $('#private-key').files[0]; if (!file) throw new Error('Выберите файл приватного SSH-ключа.'); if (file.size > 32768) throw new Error('Файл ключа слишком большой.'); data.privateKey = await file.text(); data.passphrase = $('#passphrase').value; }
  try {
    const state = await api('connect', data); setConnection(state); filePath = info.home;
    notify('Соединение со Steam Deck установлено.');
  } finally { $('#password').value = ''; $('#passphrase').value = ''; $('#private-key').value = ''; delete data.password; delete data.privateKey; delete data.passphrase; }
}); };
$('#disconnect').onclick = () => busy($('#disconnect'), async () => { await api('disconnect', {}); setConnection({ connected: false }); notify('Отключено от Steam Deck.'); });

async function loadFiles(destination = filePath) {
  const result = await api('files?path=' + encodeURIComponent(destination));
  filePath = result.path; $('#remote-path').value = filePath;
  $('#file-list').replaceChildren();
  const entries = result.entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  if (!entries.length) { const row = element('tr'), cell = element('td', 'Папка пуста'); cell.colSpan = 4; row.append(cell); $('#file-list').append(row); }
  for (const entry of entries) {
    const row = element('tr'), name = element('td'), target = childPath(filePath, entry.name);
    const button = element('button', (entry.directory ? '▱  ' : entry.symlink ? '↗  ' : '·  ') + entry.name, 'text-button');
    button.onclick = () => busy(button, async () => entry.directory || entry.symlink ? loadFiles(target) : download(target, entry.name));
    name.append(button);
    const action = element('td');
    if (!entry.directory && !entry.symlink) { const get = element('button', 'Скачать ↓', 'text-button'); get.onclick = () => busy(get, () => download(target, entry.name)); action.append(get); }
    row.append(name, element('td', entry.directory ? '—' : size(entry.size)), element('td', new Date(entry.modified * 1000).toLocaleDateString('ru-RU')), action);
    $('#file-list').append(row);
  }
}
async function download(target, filename) {
  const result = await api('download-ticket', { path: target }), link = element('a');
  link.href = result.url; link.download = filename; link.click();
  notify('Скачивание передано браузеру: ' + filename);
}
$('#path-form').onsubmit = event => { event.preventDefault(); busy($('#path-form button:last-child'), () => loadFiles($('#remote-path').value)); };
$('#refresh-files').onclick = () => busy($('#refresh-files'), () => loadFiles());
$('#parent-folder').onclick = () => busy($('#parent-folder'), () => loadFiles(filePath.slice(0, filePath.lastIndexOf('/')) || '/'));
$('#home-folder').onclick = () => busy($('#home-folder'), () => loadFiles(info.home));
$('#sd-folder').onclick = () => busy($('#sd-folder'), () => loadFiles('/run/media'));
$('#new-folder').onclick = () => { $('#folder-name').value = ''; $('#folder-dialog').showModal(); };
$('#folder-dialog').onclose = async () => {
  if ($('#folder-dialog').returnValue !== 'create') return;
  const name = $('#folder-name').value.trim();
  try { if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error('Введите имя папки без слешей.'); await api('mkdir', { path: childPath(filePath, name) }); await loadFiles(); } catch (e) { notify(e.message, true); }
};
function upload(file, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); activeUpload = xhr;
    xhr.open('PUT', '/api/upload?path=' + encodeURIComponent(destination)); xhr.setRequestHeader('X-Deck-Token', token);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total * 100); };
    xhr.onload = () => { activeUpload = null; let value; try { value = JSON.parse(xhr.responseText); } catch { return reject(new Error('Не удалось прочитать ответ загрузки.')); } xhr.status === 200 ? resolve(value) : reject(new Error(value.error || 'Загрузка не удалась. Файл с этим именем может уже существовать.')); };
    xhr.onerror = () => { activeUpload = null; reject(new Error('Соединение прервано во время загрузки.')); };
    xhr.onabort = () => { activeUpload = null; reject(new Error('Загрузка отменена. Уже загруженные файлы сохранены.')); };
    xhr.send(file);
  });
}
async function uploadFiles(files) {
  if (uploading) return notify('Дождитесь завершения текущей передачи.', true);
  if (!connected || !files.length) return;
  uploading = true; const base = filePath, made = new Set(); let count = 0;
  $('#transfer-status').hidden = false;
  try {
    for (const file of files) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split('/');
      if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Некорректный путь файла.');
      for (let i = 1; i < parts.length; i++) {
        const directory = childPath(base, parts.slice(0, i).join('/'));
        if (!made.has(directory)) { await api('mkdir', { path: directory, existOk: true }); made.add(directory); }
      }
      $('#transfer-status span').textContent = `${count + 1}/${files.length} · ${relative} · ${size(file.size)}`;
      $('#transfer-status progress').value = 0;
      await upload(file, childPath(base, relative), n => $('#transfer-status progress').value = n); count++;
    }
    notify(`Загружено файлов: ${count}. Папка: ${base}`);
  } catch (error) { notify(`${error.message} Завершено файлов: ${count}/${files.length}.`, true); }
  finally { uploading = false; $('#transfer-status').hidden = true; await loadFiles().catch(e => notify(e.message, true)); }
}
$('#cancel-upload').onclick = () => activeUpload?.abort();
$('#choose-files').onclick = () => $('#upload-files').click(); $('#choose-folder').onclick = () => $('#upload-folder').click();
for (const id of ['upload-files', 'upload-folder']) $('#' + id).onchange = event => { uploadFiles([...event.target.files]); event.target.value = ''; };
$('#dropzone').ondragover = event => { event.preventDefault(); $('#dropzone').classList.add('dragover'); };
$('#dropzone').ondragleave = () => $('#dropzone').classList.remove('dragover');
$('#dropzone').ondrop = event => { event.preventDefault(); $('#dropzone').classList.remove('dragover'); if ([...event.dataTransfer.items].some(i => i.webkitGetAsEntry?.()?.isDirectory)) { notify('Для папок используйте кнопку «Выбрать папку».', true); return; } uploadFiles([...event.dataTransfer.files]); };

function renderPsp(value) {
  psp = value;
  $$('[data-palette]').forEach(button => { button.classList.toggle('selected', psp.palette === button.dataset.palette); button.disabled = !info.pspInstalled; button.setAttribute('aria-pressed', String(psp.palette === button.dataset.palette)); });
  for (const key of ['enabled', 'sounds', 'motion', 'gameBackground', 'groupByFolders']) { $('#psp-' + key).checked = !!psp[key]; $('#psp-' + key).disabled = !info.pspInstalled; }
  $('#psp-language').value = psp.language; $('#psp-language').disabled = !info.pspInstalled;
}
let pspQueue = Promise.resolve();
function updatePsp(changes) {
  pspQueue = pspQueue.then(async () => {
    try { renderPsp(await api('psp', changes)); notify('Настройки PSP XMB сохранены. Обновлённый плагин применит их в течение 3 секунд; для старой версии перезапустите Decky.'); }
    catch (error) { renderPsp(psp); notify(error.message, true); }
  });
  return pspQueue;
}
$$('[data-palette]').forEach(button => button.onclick = () => busy(button, () => updatePsp({ palette: button.dataset.palette })));
for (const key of ['enabled', 'sounds', 'motion', 'gameBackground', 'groupByFolders']) $('#psp-' + key).onchange = event => updatePsp({ [key]: event.target.checked });
$('#psp-language').onchange = event => updatePsp({ language: event.target.value });
async function loadThemes() {
  const state = await api('status'); setConnection(state); if (!connected) return;
  $('#psp-installed').textContent = info.pspInstalled ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН';
  $('#plugins').replaceChildren(...info.plugins.map(p => element('span', p.name)));
  if (!info.plugins.length) $('#plugins').append(element('span', 'Плагины в ~/homebrew/plugins не найдены'));
  try { renderPsp(await api('psp')); } catch (e) { notify(e.message, true); }
  $('#css-themes').replaceChildren(); $('#css-message').hidden = true; $('#prepare-css').hidden = true;
  try {
    const themes = await api('css', { method: 'get_themes' });
    if (!Array.isArray(themes)) throw new Error('Неизвестный формат ответа CSS Loader.');
    $('#install-theme').disabled = false;
    if (!themes.length) $('#css-themes').append(element('p', 'Тем пока нет. Установите ZIP с theme.json или добавьте темы через CSS Loader на Deck.', 'muted'));
    for (const theme of themes) {
      const row = element('div', undefined, 'css-theme'), text = element('div'), toggle = element('button', theme.enabled ? 'Выключить' : 'Включить', theme.enabled ? 'primary' : 'secondary');
      text.append(element('b', theme.display_name || theme.name), element('small', [theme.author, theme.version].filter(Boolean).join(' · ')));
      toggle.setAttribute('aria-label', `${theme.enabled ? 'Выключить' : 'Включить'} ${theme.display_name || theme.name}`);
      toggle.onclick = () => busy(toggle, async () => { await api('css', { method: 'set_theme_state', args: { name: theme.name, state: !theme.enabled } }); await loadThemes(); notify('Состояние темы обновлено через CSS Loader.'); });
      row.append(text, toggle); $('#css-themes').append(row);
    }
  } catch (error) {
    $('#install-theme').disabled = true; $('#css-message').hidden = false;
    $('#prepare-css').hidden = !info.plugins.some(p => p.name === 'CSS Loader');
    $('#css-message').textContent = 'CSS Loader недоступен. Если он установлен, нажмите «Настроить удалённое управление», затем перезапустите Decky ниже. Или включите «Enable Standalone Backend» в настройках CSS Loader на Deck.\nДетали: ' + error.message;
  }
}
$('#refresh-themes').onclick = () => busy($('#refresh-themes'), loadThemes);
$('#prepare-css').onclick = () => busy($('#prepare-css'), async () => { await api('css', { method: 'prepare' }); $('.restart').open = true; $('#sudo-password').focus(); notify('Настройка CSS Loader сохранена. Введите пароль sudo ниже и перезапустите Decky, затем обновите список тем.'); });
$('#install-psp').onclick = () => { $('#install-password').value = ''; $('#admin-dialog').showModal(); };
$('#admin-dialog').onclose = () => {
  const password = $('#install-password').value; $('#install-password').value = '';
  if ($('#admin-dialog').returnValue !== 'install') return;
  busy($('#install-psp'), async () => { const result = await api('psp-install', { password }); await loadThemes(); $('.restart').open = true; notify('PSP XMB установлен. Теперь перезапустите Decky кнопкой ниже.' + (result.backup ? '\nРезервная копия: ' + result.backup : '')); });
};
$('#restart-form').onsubmit = event => { event.preventDefault(); busy($('#restart-form button'), async () => { const password = $('#sudo-password').value; $('#sudo-password').value = ''; await api('restart-decky', { password }); notify('Decky перезапущен. Подождите несколько секунд, затем обновите список тем.'); }); };
$('#install-theme').onclick = () => $('#theme-zip').click();
$('#theme-zip').onchange = event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  busy($('#install-theme'), async () => {
    if (file.size > 128 * 1024 * 1024) throw new Error('ZIP должен быть не больше 128 МБ.');
    const cachePath = childPath(info.home, '.cache/deck-theme-' + crypto.randomUUID());
    await api('mkdir', { path: cachePath });
    const target = childPath(cachePath, file.name); notify('Загружаю ZIP темы…');
    await upload(file, target); const result = await api('theme-install', { path: target });
    await loadThemes(); notify(result.warning || `Тема «${result.name}» установлена. Её можно включить в списке.`);
  });
};
async function runCommand() {
  const command = $('#command').value.trim(); if (!command) return;
  await busy($('#run-command'), async () => {
    const output = $('#terminal-output'); output.textContent += '\n$ ' + command + '\n'; output.scrollTop = output.scrollHeight;
    try { const result = await api('command', { command }); output.textContent += result.stdout + result.stderr + `\n[Код завершения: ${result.code}]\n`; }
    catch (error) { output.textContent += '\n' + error.message + '\n'; throw error; }
    finally { output.textContent = output.textContent.slice(-2 * 1024 * 1024); output.scrollTop = output.scrollHeight; }
  });
}
$('#command-form').onsubmit = event => { event.preventDefault(); runCommand(); };
$('#command').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!$('#run-command').disabled) runCommand(); } };
$$('[data-command]').forEach(button => button.onclick = () => { $('#command').value = button.dataset.command; $('#command').focus(); });
$('#clear-terminal').onclick = () => $('#terminal-output').textContent = '';
try {
  const response = await fetch('/api/bootstrap'); if (!response.ok) throw new Error('Менеджер недоступен.');
  const initial = await response.json(); token = initial.token; profile = initial.profile;
  directScreen = initial.screenStream === true;
  $('#host').value = profile.host; $('#port').value = profile.port; $('#username').value = profile.username;
  $('#paired-option').disabled = !initial.hasPairedKey; $('#auth').value = profile.auth || 'password'; authFields();
  for (const n of initial.networks) { const option = element('option', `${n.subnet} · ${n.name}`); option.value = n.subnet; $('#network').append(option); }
  if (!initial.networks.length) { $('#network').append(element('option', 'Укажите адрес вручную')); $('#scan-host').value = profile.host; }
  setConnection(initial.connected ? await api('status') : { connected: false });
  if (connected) filePath = info.home;
  await openLinkedTab();
  setInterval(async () => {
    if (!connected || document.hidden) return;
    try { const state = await api('status'); if (!state.connected) notify('SSH-соединение закрыто. Подключитесь снова.', true); setConnection(state); }
    catch (error) { setConnection({ connected: false }); notify('Связь потеряна: ' + error.message, true); }
  }, 20000);
} catch (error) { notify(error.message, true); }
