let allSongs = [];       // { id, file, fileName, title, artist, album, picture, addedAt }
let currentPlaylist = [];
let playOrder = [];      // indices into currentPlaylist, respects shuffle
let orderPos = -1;       // position within playOrder
let currentTrackPos = -1; // index into currentPlaylist (for compat / row highlight)
let sortMode = "az";
let searchTerm = "";
let favoriteIds = new Set();
let shuffleOn = false;
let repeatMode = "off";  // off | all | one
let objectUrl = null;    // currently active object URL, revoked on change
let dirHandle = null;    // remembered directory handle (session)

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|flac)$/i;
const DB_NAME = 'reel-db';
const DB_STORE = 'handles';

/* ---------- tiny toast ---------- */
let toastTimer = null;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('open'), 3200);
}

/* ---------- IndexedDB for folder handle persistence ---------- */
function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ()=>{
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function saveHandle(handle){
  try{
    const db = await openDb();
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(handle, 'songsFolder');
      tx.oncomplete = resolve;
      tx.onerror = ()=> reject(tx.error);
    });
  }catch(e){ /* non-fatal: persistence is a convenience, not required */ }
}
async function loadHandle(){
  try{
    const db = await openDb();
    return await new Promise((resolve, reject)=>{
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get('songsFolder');
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> reject(req.error);
    });
  }catch(e){ return null; }
}

/* ---------- favorites persistence ---------- */
function saveFavorites(){
  try{ localStorage.setItem('reel-favorites', JSON.stringify([...favoriteIds])); }
  catch(e){ /* ignore quota / privacy-mode errors */ }
}
function loadFavorites(){
  try{
    const raw = localStorage.getItem('reel-favorites');
    if(raw) favoriteIds = new Set(JSON.parse(raw));
  }catch(e){ favoriteIds = new Set(); }
}

/* ---------- folder connection ---------- */
const supportsFS = !!window.showDirectoryPicker;

async function connectFolder(){
  if(supportsFS){
    try{
      const handle = await window.showDirectoryPicker();
      dirHandle = handle;
      await saveHandle(handle);
      const files = await collectFiles(handle);
      await loadFiles(files);
    }catch(e){
      if(e.name !== 'AbortError') showToast('Could not open that folder.');
    }
  } else {
    document.getElementById('folderInputFallback').click();
  }
}

async function collectFiles(handle){
  const files = [];
  for await (const [name, entryHandle] of handle.entries()){
    if(entryHandle.kind === 'file' && AUDIO_EXT.test(name)){
      files.push(await entryHandle.getFile());
    }
  }
  return files;
}

async function tryReconnectSavedFolder(){
  if(!supportsFS) return false;
  const handle = await loadHandle();
  if(!handle) return false;
  document.getElementById('connectOverlay').style.display = 'none';
  document.getElementById('reconnectOverlay').style.display = 'flex';
  dirHandle = handle;
  return true;
}

document.getElementById('folderBtn').addEventListener('click', connectFolder);
document.getElementById('connectFolderBtn').addEventListener('click', connectFolder);

document.getElementById('reconnectBtn').addEventListener('click', async ()=>{
  if(!dirHandle) return;
  try{
    const perm = await dirHandle.requestPermission({ mode: 'read' });
    if(perm !== 'granted'){
      showToast('Permission denied — choose the folder again.');
      return;
    }
    document.getElementById('reconnectOverlay').style.display = 'none';
    const files = await collectFiles(dirHandle);
    await loadFiles(files);
  }catch(e){
    showToast('Could not reconnect. Try choosing the folder again.');
  }
});
document.getElementById('reconnectPickNew').addEventListener('click', ()=>{
  document.getElementById('reconnectOverlay').style.display = 'none';
  document.getElementById('connectOverlay').style.display = 'flex';
});

if(!supportsFS){
  document.getElementById('connectFineprint').textContent =
    "Your browser doesn't support folder memory — you'll pick your folder each visit.";
}

const fallbackInput = document.createElement('input');
fallbackInput.type = 'file';
fallbackInput.webkitdirectory = true;
fallbackInput.multiple = true;
fallbackInput.id = 'folderInputFallback';
fallbackInput.style.display = 'none';
document.body.appendChild(fallbackInput);
fallbackInput.addEventListener('change', (e)=>{
  const files = Array.from(e.target.files).filter(f => AUDIO_EXT.test(f.name));
  if(files.length) loadFiles(files);
});

/* ---------- read ID3 tags for every file ---------- */
function readTags(file){
  return new Promise((resolve)=>{
    if(typeof jsmediatags === 'undefined'){
      resolve({ title:null, artist:null, album:null, picture:null });
      return;
    }
    jsmediatags.read(file, {
      onSuccess: (tag)=>{
        const t = tag.tags || {};
        let pictureUrl = null;
        if(t.picture){
          try{
            const { data, format } = t.picture;
            const bytes = new Uint8Array(data);
            const blob = new Blob([bytes], { type: format });
            pictureUrl = URL.createObjectURL(blob);
          }catch(e){ pictureUrl = null; }
        }
        resolve({
          title: t.title || null,
          artist: t.artist || null,
          album: t.album || null,
          year: t.year || null,
          picture: pictureUrl
        });
      },
      onError: ()=>{
        resolve({ title:null, artist:null, album:null, year:null, picture:null });
      }
    });
  });
}

function cleanFileName(name){
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
}

function initials(title){
  const clean = (title || '').replace(/[^a-zA-Z0-9\u0D00-\u0D7F ]/g,'').trim();
  const parts = clean.split(' ').filter(Boolean);
  if(parts.length === 0) return '♪';
  if(parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

async function loadFiles(files){
  if(files.length === 0){
    showToast('No supported audio files found in that folder.');
    return;
  }
  loadingOverlay.classList.add('open');
  allSongs = [];
  let done = 0;

  const loadingBarFill = document.getElementById('loadingBarFill');
  for(const file of files){
    loadingText.textContent = `Reading song info… ${done+1} of ${files.length}`;
    loadingBarFill.style.width = ((done+1) / files.length * 100) + '%';
    const tags = await readTags(file);
    allSongs.push({
      id: 'f' + done + '_' + file.name,
      file,
      fileName: file.name,
      title: tags.title || cleanFileName(file.name),
      artist: tags.artist || '',
      album: tags.album || '',
      picture: tags.picture || null,
      addedAt: done
    });
    done++;
  }

  loadingOverlay.classList.remove('open');
  document.getElementById('connectOverlay').style.display = 'none';
  document.getElementById('reconnectOverlay').style.display = 'none';

  const tagged = allSongs.filter(s => s.artist || s.album).length;
  document.getElementById('folderStatus').textContent = `${allSongs.length}`;
  document.getElementById('folderStatus').classList.add('connected');
  document.getElementById('folderBtn').textContent = 'Change Folder';
  document.getElementById('statTagged').textContent = tagged;
  document.getElementById('statSidebarTotal').textContent = allSongs.length;
  document.getElementById('statSidebarTagged').textContent = tagged;
  document.getElementById('statSidebarUntagged').textContent = allSongs.length - tagged;

  renderList();
  renderFavorites();
}

/* ---------- filtering / sorting ---------- */
function getFiltered(){
  let list = allSongs.slice();
  if(searchTerm.trim()){
    const t = searchTerm.trim().toLowerCase();
    list = list.filter(s =>
      s.title.toLowerCase().includes(t) ||
      s.artist.toLowerCase().includes(t) ||
      s.album.toLowerCase().includes(t)
    );
  }
  return list;
}

function sortList(list){
  if(sortMode === "za") return list.sort((a,b)=> b.title.localeCompare(a.title));
  if(sortMode === "artist") return list.sort((a,b)=> (a.artist||'\uffff').localeCompare(b.artist||'\uffff') || a.title.localeCompare(b.title));
  if(sortMode === "recent") return list.sort((a,b)=> b.addedAt - a.addedAt);
  return list.sort((a,b)=> a.title.localeCompare(b.title));
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ---------- render list ---------- */
function renderList(){
  const list = sortList(getFiltered());
  const previousSongId = (currentTrackPos >= 0 && currentPlaylist[currentTrackPos]) ? currentPlaylist[currentTrackPos].id : null;
  currentPlaylist = list;
  buildPlayOrder();
  if(previousSongId){
    const newPos = currentPlaylist.findIndex(s => s.id === previousSongId);
    currentTrackPos = newPos;
    orderPos = playOrder.indexOf(newPos);
  }

  const container = document.getElementById('songList');
  const empty = document.getElementById('emptyState');

  if(allSongs.length === 0){
    container.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('div:last-child').textContent = 'Choose your Songs folder to see your library here.';
    return;
  }
  if(list.length === 0){
    container.innerHTML = '';
    empty.style.display = 'block';
    empty.querySelector('div:last-child').textContent = 'No results found.';
    return;
  }
  empty.style.display = 'none';

  container.innerHTML = list.map((s, i) => {
    const thumbInner = s.picture
      ? `<img src="${s.picture}" alt="">`
      : initials(s.title);
    const subMobile = [s.artist, s.album].filter(Boolean).join(' · ');
    const isFav = favoriteIds.has(s.id);
    return `
    <div class="track-row" data-id="${s.id}" data-pos="${i}">
      <span class="idx-num">${i+1}</span>
      <span class="idx-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>
      <div class="track-info">
        <div class="track-thumb">${thumbInner}</div>
        <div class="track-text">
          <div class="track-title">${escapeHtml(s.title)}</div>
          ${subMobile ? `<div class="track-sub-mobile">${escapeHtml(subMobile)}</div>` : ''}
        </div>
      </div>
      <span class="track-more">
        <span class="track-fav-mini${isFav ? ' favorited' : ''}" data-fav-id="${s.id}" title="Favorite">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 00-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z"/></svg>
        </span>
      </span>
    </div>`;
  }).join('');

  container.querySelectorAll('.track-row').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('.track-fav-mini')) return;
      playAtPosition(parseInt(el.dataset.pos, 10));
    });
  });
  container.querySelectorAll('.track-fav-mini').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleFavoriteById(el.dataset.favId);
    });
  });

  highlightPlayingRow();
  document.getElementById('statTotal').textContent = allSongs.length;
}

/* ---------- sort dropdown ---------- */
const sortControl = document.getElementById('sortControl');
const sortDropdown = document.getElementById('sortDropdown');
const sortLabel = document.getElementById('sortLabel');
sortControl.addEventListener('click', ()=> sortDropdown.classList.toggle('open'));
document.addEventListener('click', (e)=>{
  if(!sortControl.contains(e.target)) sortDropdown.classList.remove('open');
});
sortDropdown.querySelectorAll('.sort-opt').forEach(opt=>{
  opt.addEventListener('click', ()=>{
    sortMode = opt.dataset.sort;
    sortLabel.textContent = 'Sort: ' + opt.textContent;
    sortDropdown.querySelectorAll('.sort-opt').forEach(o=>o.classList.remove('selected'));
    opt.classList.add('selected');
    sortDropdown.classList.remove('open');
    renderList();
  });
});

/* ---------- shuffle / repeat ---------- */
function buildPlayOrder(){
  playOrder = currentPlaylist.map((_, i)=> i);
  if(shuffleOn) shufflePlayOrder();
  if(currentTrackPos >= 0){
    orderPos = playOrder.indexOf(currentTrackPos);
  }
}
function shufflePlayOrder(){
  for(let i = playOrder.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [playOrder[i], playOrder[j]] = [playOrder[j], playOrder[i]];
  }
  // keep currently playing track at its current spot in the new order if mid-playback
  if(currentTrackPos >= 0){
    const idx = playOrder.indexOf(currentTrackPos);
    if(idx > -1){
      playOrder.splice(idx, 1);
      playOrder.unshift(currentTrackPos);
    }
  }
}
function setShuffle(on){
  shuffleOn = on;
  document.getElementById('shuffleBtn').classList.toggle('active', shuffleOn);
  document.getElementById('shuffleBtnPlayer').classList.toggle('active', shuffleOn);
  buildPlayOrder();
}
document.getElementById('shuffleBtn').addEventListener('click', ()=> setShuffle(!shuffleOn));
document.getElementById('shuffleBtnPlayer').addEventListener('click', ()=> setShuffle(!shuffleOn));

const repeatBtn = document.getElementById('repeatBtn');
function cycleRepeat(){
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  repeatBtn.classList.toggle('active', repeatMode !== 'off');
  repeatBtn.classList.toggle('repeat-one', repeatMode === 'one');
  repeatBtn.title = repeatMode === 'off' ? 'Repeat' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one';
}
repeatBtn.addEventListener('click', cycleRepeat);

/* ---------- player ---------- */
const audioEl = document.getElementById('audioEl');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const playerTitle = document.getElementById('playerTitle');
const playerMovie = document.getElementById('playerMovie');
const playerThumb = document.getElementById('playerThumb');
const progressFill = document.getElementById('progressFill');
const progressTrack = document.getElementById('progressTrack');
const curTimeEl = document.getElementById('curTime');
const durTimeEl = document.getElementById('durTime');
const volFill = document.getElementById('volFill');
const volTrack = document.getElementById('volTrack');

const ICON_PLAY = '<path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
const FALLBACK_ART = `<svg viewBox="0 0 32 32" fill="none" class="art-fallback-mark"><rect x="2" y="13" width="3" height="6" rx="1.5"/><rect x="7" y="8" width="3" height="16" rx="1.5"/><rect x="12" y="4" width="3" height="24" rx="1.5"/><rect x="17" y="10" width="3" height="12" rx="1.5"/><rect x="22" y="6" width="3" height="20" rx="1.5"/><rect x="27" y="12" width="3" height="8" rx="1.5"/></svg>`;

function playAtPosition(pos){
  const song = currentPlaylist[pos];
  if(!song) return;
  currentTrackPos = pos;
  orderPos = playOrder.indexOf(pos);

  if(objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(song.file);
  audioEl.src = objectUrl;
  audioEl.play().catch(()=> showToast('Tap play to start — your browser blocked autoplay.'));

  playerTitle.textContent = song.title;
  playerMovie.textContent = [song.artist, song.album].filter(Boolean).join(' · ') || 'Unknown artist';
  playerThumb.innerHTML = song.picture ? `<img src="${song.picture}" alt="">` : FALLBACK_ART;
  playIcon.innerHTML = ICON_PAUSE;
  document.getElementById('playerPanel').classList.remove('empty');
  highlightPlayingRow();
  updateFavButton();
  renderFavorites();
}

function updateFavButton(){
  const favBtn = document.getElementById('favBtn');
  if(currentTrackPos < 0 || !currentPlaylist[currentTrackPos]) return;
  const song = currentPlaylist[currentTrackPos];
  favBtn.classList.toggle('favorited', favoriteIds.has(song.id));
}

function toggleFavoriteById(id){
  if(favoriteIds.has(id)) favoriteIds.delete(id);
  else favoriteIds.add(id);
  saveFavorites();
  updateFavButton();
  renderFavorites();
  renderList();
}

function toggleFavorite(){
  if(currentTrackPos < 0 || !currentPlaylist[currentTrackPos]) return;
  toggleFavoriteById(currentPlaylist[currentTrackPos].id);
}

function favThumb(song){
  return song.picture ? `<img src="${song.picture}" alt="">` : initials(song.title);
}

function renderFavorites(){
  const list = document.getElementById('favoritesList');
  const favSongs = allSongs.filter(s => favoriteIds.has(s.id));
  document.getElementById('favSubtext').textContent =
    favSongs.length === 0 ? 'No favorites yet' : `${favSongs.length} song${favSongs.length===1?'':'s'}`;
  if(favSongs.length === 0){
    list.innerHTML = '<div class="queue-empty">No favorites yet</div>';
    return;
  }
  const currentId = (currentTrackPos >= 0 && currentPlaylist[currentTrackPos]) ? currentPlaylist[currentTrackPos].id : null;
  list.innerHTML = favSongs.map(s => `
    <div class="queue-item${s.id === currentId ? ' active' : ''}" data-id="${s.id}">
      <span class="queue-item-thumb">${favThumb(s)}</span>
      <span class="queue-item-title">${escapeHtml(s.title)}</span>
    </div>
  `).join('');
  list.querySelectorAll('.queue-item').forEach(el=>{
    el.addEventListener('click', ()=>{
      const song = allSongs.find(s => s.id === el.dataset.id);
      if(!song) return;
      const pos = currentPlaylist.findIndex(s => s.id === song.id);
      if(pos >= 0){ playAtPosition(pos); }
      else { currentPlaylist = [song]; buildPlayOrder(); playAtPosition(0); }
    });
  });
}
document.getElementById('favToggle').addEventListener('click', ()=>{
  document.getElementById('favoritesList').scrollIntoView({ behavior:'smooth', block:'nearest' });
});

function downloadCurrentSong(){
  if(currentTrackPos < 0 || !currentPlaylist[currentTrackPos]) return;
  const song = currentPlaylist[currentTrackPos];
  const url = URL.createObjectURL(song.file);
  const a = document.createElement('a');
  a.href = url;
  a.download = song.fileName || (song.title + '.mp3');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 5000);
}

document.getElementById('favBtn').addEventListener('click', toggleFavorite);
document.getElementById('downloadBtn').addEventListener('click', downloadCurrentSong);

function highlightPlayingRow(){
  document.querySelectorAll('.track-row').forEach(el=>el.classList.remove('playing'));
  if(currentTrackPos >= 0 && currentPlaylist[currentTrackPos]){
    const id = currentPlaylist[currentTrackPos].id;
    const row = document.querySelector(`.track-row[data-id="${id}"]`);
    if(row) row.classList.add('playing');
  }
}

playPauseBtn.addEventListener('click', ()=>{
  if(!audioEl.src) return;
  if(audioEl.paused){ audioEl.play(); playIcon.innerHTML = ICON_PAUSE; }
  else { audioEl.pause(); playIcon.innerHTML = ICON_PLAY; }
});

document.getElementById('playAllBtn').addEventListener('click', ()=>{
  if(currentPlaylist.length === 0) return;
  playAtPosition(playOrder[0]);
});

document.getElementById('rewindBtn').addEventListener('click', ()=>{
  if(!audioEl.duration) return;
  audioEl.currentTime = Math.max(0, audioEl.currentTime - 10);
});
document.getElementById('forwardBtn').addEventListener('click', ()=>{
  if(!audioEl.duration) return;
  audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 10);
});

function skipTrack(dir){
  if(playOrder.length === 0) return;
  let nextOrderPos = orderPos + dir;
  if(nextOrderPos >= playOrder.length){
    if(repeatMode !== 'all' && repeatMode !== 'one'){
      // stop at end of list
      audioEl.pause();
      playIcon.innerHTML = ICON_PLAY;
      return;
    }
    nextOrderPos = 0;
  }
  if(nextOrderPos < 0) nextOrderPos = playOrder.length - 1;
  playAtPosition(playOrder[nextOrderPos]);
}

audioEl.addEventListener('ended', ()=>{
  if(repeatMode === 'one'){ playAtPosition(currentTrackPos); return; }
  skipTrack(1);
});
audioEl.addEventListener('timeupdate', ()=>{
  if(!audioEl.duration) return;
  progressFill.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
  curTimeEl.textContent = formatTime(audioEl.currentTime);
  document.getElementById('curTimeVol').textContent = formatTime(audioEl.currentTime);
});
audioEl.addEventListener('loadedmetadata', ()=>{
  durTimeEl.textContent = formatTime(audioEl.duration);
  document.getElementById('durTimeVol').textContent = formatTime(audioEl.duration);
});

function formatTime(sec){
  if(!isFinite(sec)) return '0:00';
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
}

progressTrack.addEventListener('click', (e)=>{
  if(!audioEl.duration) return;
  const rect = progressTrack.getBoundingClientRect();
  audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
});

const ICON_VOL_UP = '<path d="M4 9v6h4l5 5V4L8 9H4zm11.5 3a4.5 4.5 0 00-2.5-4.03v8.06A4.5 4.5 0 0015.5 12zM13 3.23v2.06c3.39.86 6 3.9 6 7.71s-2.61 6.85-6 7.71v2.06c4.5-.9 8-4.87 8-9.77s-3.5-8.87-8-9.77z"/>';
const ICON_VOL_MUTE = '<path d="M4 9v6h4l5 5V4L8 9H4zm14.1-1.5l-1.4-1.4L15 8.8l-1.7-1.7-1.4 1.4L13.6 10l-1.7 1.7 1.4 1.4L15 11.4l1.7 1.7 1.4-1.4L16.4 10l1.7-1.5z"/>';

let lastVolume = 0.7;
let isMuted = false;
const volIconSvg = document.getElementById('volIconSvg');
const muteBtn = document.getElementById('muteBtn');

audioEl.volume = 0.7;

function setVolume(v){
  audioEl.volume = v;
  volFill.style.width = (v*100) + '%';
  isMuted = v === 0;
  volIconSvg.innerHTML = isMuted ? ICON_VOL_MUTE : ICON_VOL_UP;
}

muteBtn.addEventListener('click', ()=>{
  if(isMuted){
    setVolume(lastVolume || 0.7);
  } else {
    lastVolume = audioEl.volume;
    setVolume(0);
  }
});

function volFromEvent(e){
  const rect = volTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

let draggingVol = false;
volTrack.addEventListener('mousedown', (e)=>{
  draggingVol = true;
  setVolume(volFromEvent(e));
});
window.addEventListener('mousemove', (e)=>{
  if(!draggingVol) return;
  setVolume(volFromEvent(e));
});
window.addEventListener('mouseup', ()=>{
  draggingVol = false;
});
volTrack.addEventListener('click', (e)=>{
  setVolume(volFromEvent(e));
});

document.getElementById('searchInput').addEventListener('input', (e)=>{
  searchTerm = e.target.value;
  renderList();
});

/* ---------- keyboard shortcuts ---------- */
document.addEventListener('keydown', (e)=>{
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea') return;

  if(e.code === 'Space'){
    e.preventDefault();
    if(!audioEl.src) return;
    if(audioEl.paused){ audioEl.play(); playIcon.innerHTML = ICON_PAUSE; }
    else { audioEl.pause(); playIcon.innerHTML = ICON_PLAY; }
  } else if(e.code === 'ArrowLeft'){
    if(!audioEl.duration) return;
    audioEl.currentTime = Math.max(0, audioEl.currentTime - 10);
  } else if(e.code === 'ArrowRight'){
    if(!audioEl.duration) return;
    audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + 10);
  } else if(e.code === 'KeyM'){
    muteBtn.click();
  }
});

/* ---------- boot ---------- */
(async function init(){
  loadFavorites();
  const hasSaved = await tryReconnectSavedFolder();
  if(!hasSaved){
    document.getElementById('connectOverlay').style.display = 'flex';
  }
})();