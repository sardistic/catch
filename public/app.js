const form = document.querySelector('#link-form');
const urlInput = document.querySelector('#media-url');
const pasteButton = document.querySelector('#paste-button');
const inspectButton = document.querySelector('#inspect-button');
const statusBox = document.querySelector('#status');
const result = document.querySelector('#result');
const thumbnail = document.querySelector('#thumbnail');
const duration = document.querySelector('#duration');
const platformTag = document.querySelector('#platform-tag');
const resultTitle = document.querySelector('#result-title');
const creator = document.querySelector('#creator');
const qualityGroup = document.querySelector('#quality-group');
const qualityOptions = document.querySelector('#quality-options');
const downloadButton = document.querySelector('#download-button');
const formatButtons = [...document.querySelectorAll('[data-kind]')];
const gallery = document.querySelector('#gallery');
const galleryTitle = document.querySelector('#gallery-title');
const galleryCreator = document.querySelector('#gallery-creator');
const galleryGrid = document.querySelector('#gallery-grid');
const galleryZipButton = document.querySelector('#gallery-zip');
const playlistOffer = document.querySelector('#playlist-offer');
const playlistLoadButton = document.querySelector('#playlist-load');
const playlist = document.querySelector('#playlist');
const playlistTitle = document.querySelector('#playlist-title');
const playlistCreator = document.querySelector('#playlist-creator');
const playlistList = document.querySelector('#playlist-list');
const playlistCount = document.querySelector('#playlist-count');
const playlistNote = document.querySelector('#playlist-note');
const playlistZipButton = document.querySelector('#playlist-zip');
const playlistAllButton = document.querySelector('#playlist-all');
const playlistNoneButton = document.querySelector('#playlist-none');

let media = null;
let galleryData = null;
let playlistData = null;
let selectedKind = 'video';
let selectedQuality = 'best';

function showStatus(message, type = 'error') {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`;
  statusBox.hidden = false;
}

function hideStatus() {
  statusBox.hidden = true;
}

function setInspecting(isLoading) {
  inspectButton.disabled = isLoading;
  inspectButton.querySelector('span').textContent = isLoading ? 'Looking…' : 'Find media';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60);
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

async function readApiError(response) {
  try {
    const body = await response.json();
    return body.error || 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

async function saveResponse(response, fallbackName) {
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const basicName = disposition.match(/filename="([^"]+)"/i);
  const filename = utf8Name ? decodeURIComponent(utf8Name[1]) : basicName?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

function renderQualities(qualities) {
  qualityOptions.replaceChildren();
  selectedQuality = 'best';
  qualities.forEach(({ value, label }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `quality${value === selectedQuality ? ' active' : ''}`;
    button.dataset.quality = value;
    button.textContent = label;
    button.addEventListener('click', () => {
      selectedQuality = value;
      document.querySelectorAll('.quality').forEach((item) => item.classList.toggle('active', item === button));
    });
    qualityOptions.append(button);
  });
}

function renderResult(data) {
  media = data;
  resultTitle.textContent = data.title;
  creator.textContent = data.creator;
  platformTag.textContent = data.platform;
  const time = formatDuration(data.duration);
  duration.textContent = time;
  duration.hidden = !time;
  if (data.thumbnail) {
    thumbnail.src = data.thumbnail;
    thumbnail.alt = `Thumbnail for ${data.title}`;
  } else {
    thumbnail.removeAttribute('src');
    thumbnail.alt = '';
  }
  selectedKind = 'video';
  formatButtons.forEach((button) => button.classList.toggle('active', button.dataset.kind === 'video'));
  qualityGroup.hidden = false;
  downloadButton.querySelector('span').textContent = 'Download video';
  renderQualities(data.qualities);
  playlistOffer.hidden = !data.playlist;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function describeGallery(data) {
  const parts = [];
  if (data.imageCount) parts.push(`${data.imageCount} photo${data.imageCount === 1 ? '' : 's'}`);
  if (data.videoCount) parts.push(`${data.videoCount} video${data.videoCount === 1 ? '' : 's'}`);
  return `${data.creator} · ${parts.join(' · ')}`;
}

function galleryCard(item, index) {
  const card = document.createElement('figure');
  card.className = 'gallery-item';

  const preview = document.createElement('img');
  preview.src = item.preview;
  preview.alt = `${item.kind === 'video' ? 'Video' : 'Photo'} ${index + 1} from this post`;
  preview.loading = 'lazy';

  const position = document.createElement('span');
  position.className = 'item-index';
  position.textContent = String(index + 1).padStart(2, '0');

  const save = document.createElement('a');
  save.className = 'item-save';
  save.href = item.download;
  save.download = item.filename;
  save.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg>';
  save.append('Save');

  card.append(preview, position, save);

  if (item.kind === 'video') {
    const kind = document.createElement('span');
    kind.className = 'item-kind';
    kind.textContent = 'Video';
    card.append(kind);
  }
  return card;
}

function renderGallery(data) {
  galleryData = data;
  galleryTitle.textContent = data.title;
  galleryCreator.textContent = describeGallery(data);
  galleryGrid.replaceChildren(...data.items.map(galleryCard));
  galleryZipButton.hidden = data.items.length < 2;
  gallery.hidden = false;
  gallery.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectedTracks() {
  return [...playlistList.querySelectorAll('input[type="checkbox"]:checked')].map((box) =>
    Number(box.dataset.index)
  );
}

function refreshSelection() {
  const chosen = selectedTracks();
  const overflowing = chosen.length > playlistData.batchLimit;

  playlistList.querySelectorAll('.track').forEach((row) => {
    row.classList.toggle('picked', row.querySelector('input').checked);
  });

  playlistCount.textContent = `${chosen.length} of ${playlistData.items.length} selected`;
  playlistZipButton.disabled = !chosen.length || overflowing;
  playlistZipButton.querySelector('span').textContent = chosen.length
    ? `Download ${chosen.length} MP3${chosen.length === 1 ? '' : 's'}`
    : 'Download MP3s';

  const notes = [];
  if (overflowing) {
    notes.push(`Pick at most ${playlistData.batchLimit} tracks per batch.`);
  }
  if (playlistData.total > playlistData.listed) {
    notes.push(`Showing the first ${playlistData.listed} of ${playlistData.total} videos.`);
  }
  notes.push('Each track is converted separately, so a long batch takes a while. Keep this tab open.');
  playlistNote.textContent = notes.join(' ');
}

async function saveTrack(item, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '…';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url, title: item.title, kind: 'audio', quality: 'best' })
    });
    if (!response.ok) throw new Error(await readApiError(response));
    await saveResponse(response, `${item.title}.mp3`);
    hideStatus();
  } catch (error) {
    showStatus(error.message || 'That track could not be prepared.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function trackRow(item, index) {
  const row = document.createElement('li');
  row.className = 'track';

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.dataset.index = String(item.index);
  // Everything is on by default, up to the size a single batch can carry.
  pick.checked = index < playlistData.batchLimit;
  pick.setAttribute('aria-label', `Include ${item.title}`);
  pick.addEventListener('change', refreshSelection);

  const number = document.createElement('span');
  number.className = 'track-number';
  number.textContent = String(item.index);

  const body = document.createElement('div');
  body.className = 'track-body';
  const title = document.createElement('p');
  title.className = 'track-title';
  title.textContent = item.title;
  title.title = item.title;
  body.append(title);

  // Most playlists are one creator's, already named in the header; only a
  // guest upload is worth repeating per row.
  if (item.creator && item.creator !== playlistData.creator) {
    const meta = document.createElement('p');
    meta.className = 'track-meta';
    meta.textContent = item.creator;
    body.append(meta);
  }

  const time = document.createElement('span');
  time.className = 'track-time';
  time.textContent = formatDuration(item.duration);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'track-save';
  save.textContent = 'MP3';
  save.addEventListener('click', () => saveTrack(item, save));

  row.append(pick, number);
  if (item.thumbnail) {
    const thumb = document.createElement('img');
    thumb.className = 'track-thumb';
    thumb.src = item.thumbnail;
    thumb.alt = '';
    thumb.loading = 'lazy';
    row.append(thumb);
  }
  row.append(body, time, save);
  return row;
}

function renderPlaylist(data) {
  playlistData = data;
  playlistTitle.textContent = data.title;
  playlistCreator.textContent = `${data.creator} · ${data.listed} video${data.listed === 1 ? '' : 's'}`;
  playlistList.replaceChildren(...data.items.map(trackRow));
  refreshSelection();
  playlist.hidden = false;
  playlist.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setAllTracks(checked) {
  playlistList.querySelectorAll('input[type="checkbox"]').forEach((box, index) => {
    box.checked = checked && index < playlistData.batchLimit;
  });
  refreshSelection();
}

playlistAllButton.addEventListener('click', () => setAllTracks(true));
playlistNoneButton.addEventListener('click', () => setAllTracks(false));

playlistLoadButton.addEventListener('click', () => {
  if (!media?.playlist) return;
  urlInput.value = media.playlist.url;
  form.requestSubmit();
});

playlistZipButton.addEventListener('click', async () => {
  if (!playlistData) return;
  const indexes = selectedTracks();
  if (!indexes.length) return;

  playlistZipButton.disabled = true;
  const label = playlistZipButton.querySelector('span');
  const original = label.textContent;
  label.textContent = 'Converting…';
  showStatus(
    `Converting ${indexes.length} track${indexes.length === 1 ? '' : 's'} to MP3 and bundling them into a zip. This can take several minutes — keep this tab open.`,
    'loading'
  );

  try {
    const response = await fetch('/api/playlist-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: playlistData.mediaUrl, indexes })
    });
    if (!response.ok) throw new Error(await readApiError(response));

    await saveResponse(response, `${playlistData.title}.zip`);
    showStatus('Your zip is ready. Anything we could not reach is listed in skipped-tracks.txt.', 'success');
  } catch (error) {
    showStatus(error.message || 'The batch could not be prepared.');
  } finally {
    label.textContent = original;
    refreshSelection();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setInspecting(true);
  result.hidden = true;
  gallery.hidden = true;
  playlist.hidden = true;
  playlistOffer.hidden = true;
  showStatus('Reading the link and checking available formats…', 'loading');

  try {
    const response = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const data = await response.json();
    hideStatus();
    media = null;
    galleryData = null;
    playlistData = null;

    if (data.type === 'gallery') {
      renderGallery(data);
    } else if (data.type === 'playlist') {
      renderPlaylist(data);
    } else {
      renderResult(data);
    }
  } catch (error) {
    media = null;
    galleryData = null;
    playlistData = null;
    showStatus(error.message || 'Could not read that link.');
  } finally {
    setInspecting(false);
  }
});

pasteButton.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    urlInput.focus();
  } catch {
    urlInput.focus();
    showStatus('Your browser blocked clipboard access. Paste the link into the field.', 'error');
  }
});

formatButtons.forEach((button) => {
  button.addEventListener('click', () => {
    selectedKind = button.dataset.kind;
    formatButtons.forEach((item) => item.classList.toggle('active', item === button));
    qualityGroup.hidden = selectedKind === 'audio';
    downloadButton.querySelector('span').textContent = selectedKind === 'audio' ? 'Download audio' : 'Download video';
  });
});

galleryZipButton.addEventListener('click', async () => {
  if (!galleryData) return;
  galleryZipButton.disabled = true;
  const label = galleryZipButton.querySelector('span');
  const original = label.textContent;
  label.textContent = 'Bundling…';
  showStatus('Bundling every file in this post into a zip. Keep this tab open.', 'loading');

  try {
    const response = await fetch('/api/gallery-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: galleryData.mediaUrl })
    });
    if (!response.ok) throw new Error(await readApiError(response));

    await saveResponse(response, `instagram-${galleryData.shortcode}.zip`);
    showStatus('Your zip is ready.', 'success');
  } catch (error) {
    showStatus(error.message || 'The zip could not be prepared.');
  } finally {
    galleryZipButton.disabled = false;
    label.textContent = original;
  }
});

downloadButton.addEventListener('click', async () => {
  if (!media) return;
  downloadButton.disabled = true;
  const label = downloadButton.querySelector('span');
  const original = label.textContent;
  label.textContent = 'Preparing file…';
  showStatus('Preparing your file. Keep this tab open until the save prompt appears.', 'loading');

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: media.mediaUrl,
        title: media.title,
        kind: selectedKind,
        quality: selectedQuality
      })
    });
    if (!response.ok) throw new Error(await readApiError(response));

    await saveResponse(response, `download.${selectedKind === 'audio' ? 'mp3' : 'mp4'}`);
    showStatus('Your download is ready.', 'success');
  } catch (error) {
    showStatus(error.message || 'The download could not be prepared.');
  } finally {
    downloadButton.disabled = false;
    label.textContent = original;
  }
});
