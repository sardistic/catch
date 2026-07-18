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

let media = null;
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
  inspectButton.querySelector('span').textContent = isLoading ? 'Looking…' : 'Find video';
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
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  setInspecting(true);
  result.hidden = true;
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
    renderResult(data);
  } catch (error) {
    media = null;
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

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const basicName = disposition.match(/filename="([^"]+)"/i);
    const filename = utf8Name ? decodeURIComponent(utf8Name[1]) : basicName?.[1] || `download.${selectedKind === 'audio' ? 'mp3' : 'mp4'}`;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    showStatus('Your download is ready.', 'success');
  } catch (error) {
    showStatus(error.message || 'The download could not be prepared.');
  } finally {
    downloadButton.disabled = false;
    label.textContent = original;
  }
});
