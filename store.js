// Lamplight — on-device storage. Every book that has been opened is kept in
// IndexedDB (its bytes, cover, shelves and reading position) so it reopens
// without choosing the file again. Settings live in localStorage under
// "lamplight:*". Nothing is ever sent anywhere.

const LIBRARY_DB = 'lamplight-reader';
const LIBRARY_STORE = 'files';

function openLibraryDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LIBRARY_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(LIBRARY_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
  try{ localStorage.setItem(key, JSON.stringify(pos)); } catch(e){ /* storage full or unavailable */ }
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
