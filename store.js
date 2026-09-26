// Lamplight — on-device storage. Every book that has been opened is kept in
// IndexedDB (its bytes, cover, shelves and reading position) so it reopens
// without choosing the file again. Settings live in localStorage under
// "lamplight:*". Nothing is ever sent anywhere.

const LIBRARY_DB = 'lamplight-reader';
const LIBRARY_STORE = 'files';
const KV_STORE = 'kv'; // small things that don't fit localStorage, such as a folder handle

function openLibraryDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIBRARY_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(LIBRARY_STORE)) db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
      if(!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key){
  try{
    const db = await openLibraryDB();
    try{
      return await new Promise((resolve, reject) => {
        const req = db.transaction(KV_STORE, 'readonly').objectStore(KV_STORE).get(key);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  } catch(err){ console.warn('Could not read', key, err); return undefined; }
}
async function kvSet(key, value){
  try{
    const db = await openLibraryDB();
    try{
      await new Promise((resolve, reject) => {
        const tx = db.transaction(KV_STORE, 'readwrite');
        if(value === undefined) tx.objectStore(KV_STORE).delete(key); else tx.objectStore(KV_STORE).put(value, key);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  } catch(err){ console.warn('Could not store', key, err); }
}

// Runs one read-write transaction against the library store and resolves when it
// commits. `fn` gets the object store and may return a request whose result is
// wanted back.
async function withLibraryStore(mode, fn){
  const db = await openLibraryDB();
  try{
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE, mode);
      let out;
      const req = fn(tx.objectStore(LIBRARY_STORE));
      if(req && 'onsuccess' in req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

function bookIdFor(file){ return file.name.trim().toLowerCase(); } // same filename = same book

// Adds or updates a book. Fields already stored (custom title, shelves, position)
// survive a re-open of the same file.
async function saveBookToLibrary(file, buf, extra){
  extra = extra || {};
  try{
    await withLibraryStore('readwrite', store => {
      const id = bookIdFor(file);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const old = getReq.result || {};
        store.put(Object.assign({}, old, {
          id,
          name: file.name,
          type: file.type,
          data: buf,
          savedAt: Date.now(),
          displayName: old.displayName,
          shelves: old.shelves || extra.shelves || [],
          title: extra.title || old.title || '',
          author: extra.author || old.author || '',
          series: old.series !== undefined ? old.series : (extra.series || ''),
          seriesIndex: old.seriesIndex !== undefined ? old.seriesIndex : (extra.seriesIndex != null ? extra.seriesIndex : null),
          sourcePath: extra.sourcePath || old.sourcePath || '',
          cover: extra.cover !== undefined ? extra.cover : (old.cover || null),
          totalChars: extra.totalChars || old.totalChars || 0,
          chapterCount: extra.chapterCount || old.chapterCount || 0,
          progress: old.progress || null
        }));
      };
    });
  } catch(err){ console.warn('Could not save book to library:', err); }
}

// Every stored book, most recently opened first, without the file bytes (those are
// fetched by id when a book is actually opened).
async function listLibraryBooks(){
  try{
    const records = await withLibraryStore('readonly', store => store.getAll());
    (records || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return records || [];
  } catch(err){ console.warn('Could not list library:', err); return []; }
}

async function getLibraryBook(id){
  try{ return await withLibraryStore('readonly', store => store.get(id)); }
  catch(err){ console.warn('Could not read book:', err); return null; }
}

async function deleteBookFromLibrary(id){
  try{ await withLibraryStore('readwrite', store => store.delete(id)); }
  catch(err){ console.warn('Could not remove book from library:', err); }
}

// Merges a few fields into one record (rename, shelves, progress, per-book voice).
async function updateLibraryBook(id, fields){
  try{
    await withLibraryStore('readwrite', store => {
      const getReq = store.get(id);
      getReq.onsuccess = () => { const rec = getReq.result; if(rec) store.put(Object.assign(rec, fields)); };
    });
  } catch(err){ console.warn('Could not update book:', err); }
}

function libraryBookTitle(rec){
  return rec.displayName || rec.title || rec.name.replace(/\.(epub|pdf)$/i, '');
}

// ---------------- Shelves ----------------
const DEFAULT_SHELVES = ['Christian', 'Biography', 'Sci-fi', 'Classics'];
function loadShelves(){
  try{
    const raw = localStorage.getItem('lamplight:shelves');
    if(raw){ const list = JSON.parse(raw); if(Array.isArray(list)) return list; }
  } catch(e){ /* ignore */ }
  return DEFAULT_SHELVES.slice();
}
function saveShelves(list){
  try{ localStorage.setItem('lamplight:shelves', JSON.stringify(list)); } catch(e){ /* ignore */ }
}

// ---------------- Reading position ----------------
// Kept in localStorage under the same key earlier versions used, so nobody loses
// their place on upgrade. The library record also gets a summary for its card.
function progressKeyFor(title, size){ return 'lamplight:' + title + ':' + size; }
function saveProgressFor(key, pos){
  if(!key) return;
  try{ localStorage.setItem(key, JSON.stringify(Object.assign({ at: Date.now() }, pos))); } catch(e){ /* storage full or unavailable */ }
}
function loadProgressFor(key){
  if(!key) return null;
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch(e){ return null; }
}

// ---------------- Small settings helpers ----------------
function settingGet(name, fallback){
  try{ const v = localStorage.getItem('lamplight:' + name); return v === null ? fallback : v; } catch(e){ return fallback; }
}
function settingSet(name, value){
  try{ localStorage.setItem('lamplight:' + name, String(value)); } catch(e){ /* ignore */ }
}
function settingGetJSON(name, fallback){
  try{ const v = localStorage.getItem('lamplight:' + name); return v === null ? fallback : JSON.parse(v); } catch(e){ return fallback; }
}

// Asks the browser to keep this site's data when storage runs low (Safari clears
// unvisited sites after about a week otherwise). Resolves to true when granted.
async function requestPersistentStorage(){
  try{
    if(!navigator.storage || !navigator.storage.persist) return null;
    if(await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch(e){ return null; }
}
async function storageEstimate(){
  try{ return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch(e){ return null; }
}

// ---------------- Backup and restore ----------------
// One zip file holds every book, its cover, shelves, positions, pronunciation rules
// and filter words. Saved to iCloud Drive or Google Drive and restored on another
// device, it is also how two of your own devices stay in step: restoring merges,
// newer positions win, and nothing is deleted.
const BACKUP_MANIFEST = 'lamplight-backup.json';
const DEVICE_SETTINGS = ['fontSize','font','theme','darkMode','follow','fadeRead','engine','useServer','serverUrl',
  'maxInternalGapMs','speed','voice','piperVoice','skipUnit','secPerChar','shelves','filterSettings','pronunciationRules','lastBackupAt'];

function isPositionKey(key){ return /^lamplight:.+:\d+$/.test(key); }
function readPosition(raw){
  try{ const p = JSON.parse(raw); return p && typeof p.chapter === 'number' && typeof p.sentence === 'number' ? p : null; } catch(e){ return null; }
}

async function exportBackupBlob(){
  const zip = new JSZip();
  const books = await listLibraryBooks();
  const positions = {};
  try{
    for(let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if(isPositionKey(key) && readPosition(localStorage.getItem(key))) positions[key] = readPosition(localStorage.getItem(key));
    }
  } catch(e){ /* ignore */ }
  const manifest = {
    version: 1,
    exportedAt: Date.now(),
    shelves: loadShelves(),
    filterWords: settingGetJSON('filterSettings', {}).custom || [],
    pronunciationRules: settingGetJSON('pronunciationRules', []),
    positions,
    books: books.map(rec => ({
      id: rec.id, name: rec.name, type: rec.type || '', displayName: rec.displayName || '', title: rec.title || '',
      author: rec.author || '', shelves: rec.shelves || [], totalChars: rec.totalChars || 0, chapterCount: rec.chapterCount || 0,
      series: rec.series || '', seriesIndex: rec.seriesIndex != null ? rec.seriesIndex : null,
      progress: rec.progress || null, savedAt: rec.savedAt || 0,
      file: rec.data ? 'books/' + rec.id : null,
      cover: rec.cover ? 'covers/' + rec.id + (rec.cover.type === 'image/png' ? '.png' : '.jpg') : null,
      coverType: rec.cover ? rec.cover.type : null
    }))
  };
  books.forEach(rec => {
    if(rec.data) zip.file('books/' + rec.id, rec.data);
    if(rec.cover) zip.file('covers/' + rec.id + (rec.cover.type === 'image/png' ? '.png' : '.jpg'), rec.cover);
  });
  zip.file(BACKUP_MANIFEST, JSON.stringify(manifest));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' }); // EPUBs are already compressed
}

// Merges a backup into this device. Returns counts for the message shown afterwards.
async function importBackup(file){
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file(BACKUP_MANIFEST);
  if(!entry) throw new Error('That is not a Lamplight backup.');
  const manifest = JSON.parse(await entry.async('string'));
  const out = { booksAdded: 0, booksUpdated: 0, positionsUpdated: 0, newerPositions: {} };

  // Shelves, filter words and pronunciation rules: union.
  const shelves = loadShelves();
  (manifest.shelves || []).forEach(s => { if(!shelves.includes(s)) shelves.push(s); });
  saveShelves(shelves);
  const fs = settingGetJSON('filterSettings', { enabled: true, custom: [] });
  fs.custom = fs.custom || [];
  (manifest.filterWords || []).forEach(w => { if(!fs.custom.includes(w)) fs.custom.push(w); });
  settingSet('filterSettings', JSON.stringify(fs));
  const rules = settingGetJSON('pronunciationRules', []);
  const ruleKey = r => [r.find, r.replace || '', !!r.matchCase].join('\u0001');
  const have = new Set(rules.map(ruleKey));
  (manifest.pronunciationRules || []).forEach(r => { if(r && r.find && !have.has(ruleKey(r))){ rules.push(r); have.add(ruleKey(r)); } });
  settingSet('pronunciationRules', JSON.stringify(rules));

  // Reading positions: the newer one wins.
  Object.entries(manifest.positions || {}).forEach(([key, pos]) => {
    if(!isPositionKey(key) || !pos) return;
    let local = null;
    try{ local = readPosition(localStorage.getItem(key)); } catch(e){ /* ignore */ }
    if(!local || (pos.at || 0) > (local.at || 0)){
      try{ localStorage.setItem(key, JSON.stringify(pos)); } catch(e){ /* ignore */ }
      out.positionsUpdated++; out.newerPositions[key] = pos;
    }
  });

  // Books: add missing ones, merge the rest.
  for(const b of manifest.books || []){
    if(!b || !b.id) continue;
    const local = await getLibraryBook(b.id);
    const coverEntry = b.cover && zip.file(b.cover);
    const cover = coverEntry ? new Blob([await coverEntry.async('uint8array')], { type: b.coverType || 'image/jpeg' }) : null;
    if(!local){
      const dataEntry = b.file && zip.file(b.file);
      if(!dataEntry) continue;
      const data = await dataEntry.async('arraybuffer');
      await withLibraryStore('readwrite', store => store.put({
        id: b.id, name: b.name, type: b.type, data, savedAt: b.savedAt || Date.now(),
        displayName: b.displayName || undefined, title: b.title || '', author: b.author || '', shelves: b.shelves || [],
        series: b.series || '', seriesIndex: b.seriesIndex != null ? b.seriesIndex : null,
        cover, totalChars: b.totalChars || 0, chapterCount: b.chapterCount || 0, progress: b.progress || null
      }));
      out.booksAdded++;
    } else {
      const merged = {};
      const union = (local.shelves || []).slice(); (b.shelves || []).forEach(s => { if(!union.includes(s)) union.push(s); });
      merged.shelves = union;
      if(!local.displayName && b.displayName) merged.displayName = b.displayName;
      if(!local.title && b.title) merged.title = b.title;
      if(!local.author && b.author) merged.author = b.author;
      if(!local.series && b.series){ merged.series = b.series; merged.seriesIndex = b.seriesIndex != null ? b.seriesIndex : null; }
      if(!local.cover && cover) merged.cover = cover;
      if(b.progress && (!local.progress || (b.progress.at || 0) > (local.progress.at || 0))) merged.progress = b.progress;
      await updateLibraryBook(b.id, merged);
      out.booksUpdated++;
    }
  }
  return out;
}
