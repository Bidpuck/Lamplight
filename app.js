// Lamplight — the screens. Library (shelves, book cards), Reader (text, highlight,
// follow-along, player bar), Settings, and the sheets over them. Talks to the
// Player for anything about playback and to Voice for anything about voices.

// ---------------- No pinch / double-tap zoom ----------------
// touch-action + the viewport meta tag aren't reliably enough on iOS: Safari's native
// pinch and double-tap-to-zoom fire independently of those.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
let lastTouchEndAt = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if(now - lastTouchEndAt <= 300) e.preventDefault();
  lastTouchEndAt = now;
}, { passive: false });

const $$ = sel => Array.from(document.querySelectorAll(sel));
const fmtClock = sec => { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec/60) + ':' + String(sec % 60).padStart(2, '0'); };
const fmtLong = sec => {
  const min = Math.max(0, Math.round((sec || 0) / 60));
  if(min < 1) return 'under a minute';
  if(min < 60) return min + ' min';
  return Math.floor(min/60) + ' h ' + String(min % 60).padStart(2, '0') + ' min';
};

// ---------------- Views and sheets ----------------
function showView(name){
  ['viewLibrary', 'viewReader', 'viewSettings'].forEach(id => el(id).classList.toggle('hidden', id !== name));
}
function openSheet(id){ el(id).classList.remove('hidden'); }
function closeSheet(id){ el(id).classList.add('hidden'); }
$$('[data-close]').forEach(b => b.addEventListener('click', () => closeSheet(b.dataset.close)));
$$('.sheet').forEach(sh => sh.addEventListener('click', e => { if(e.target === sh) sh.classList.add('hidden'); }));
document.addEventListener('keydown', e => { if(e.key === 'Escape') $$('.sheet').forEach(sh => sh.classList.add('hidden')); });

// ---------------- Display settings ----------------
const FONTS = [
  { id: 'source',   label: 'Source Serif', family: "'Source Serif 4', Georgia, serif" },
  { id: 'literata', label: 'Literata',     family: "Literata, Georgia, serif" },
  { id: 'atkinson', label: 'Atkinson',     family: "'Atkinson Hyperlegible', Arial, sans-serif" },
  { id: 'lexend',   label: 'Lexend',       family: "Lexend, Arial, sans-serif" },
  { id: 'system',   label: 'System',       family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }
];
const Display = {
  fontSize: parseInt(settingGet('fontSize', '19'), 10) || 19,
  font: settingGet('font', 'source'),
  theme: settingGet('theme', settingGet('darkMode', '0') === '1' ? 'dark' : 'paper'),
  follow: settingGet('follow', '1') === '1',
  fade: settingGet('fadeRead', '1') === '1'
};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyDisplay(){
  document.documentElement.style.setProperty('--prose-font-size', Display.fontSize + 'px');
  const font = FONTS.find(f => f.id === Display.font) || FONTS[0];
  document.documentElement.style.setProperty('--prose-font', font.family);
  const dark = Display.theme === 'dark' || (Display.theme === 'auto' && darkQuery.matches);
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('fade-read', Display.fade);
  document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#1B1F1A' : '#ECE6D6');
  // The same controls appear in the Display sheet and in Settings: keep both in step.
  ['fontSizeRange', 'fontSizeRange2'].forEach(id => { el(id).value = Display.fontSize; });
  $$('[data-fonts] button').forEach(b => b.classList.toggle('on', b.dataset.f === Display.font));
  $$('#themeSeg button, #themeSeg2 button').forEach(b => b.classList.toggle('on', b.dataset.v === Display.theme));
  ['followToggle', 'followToggle2'].forEach(id => { el(id).checked = Display.follow; });
  ['fadeToggle', 'fadeToggle2'].forEach(id => { el(id).checked = Display.fade; });
}
$$('[data-fonts]').forEach(group => {
  FONTS.forEach(f => {
    const b = document.createElement('button');
    b.dataset.f = f.id; b.style.fontFamily = f.family;
    b.innerHTML = '<b>Aa</b><span></span>';
    b.querySelector('span').textContent = f.label;
    b.addEventListener('click', () => { Display.font = f.id; settingSet('font', f.id); applyDisplay(); });
    group.appendChild(b);
  });
});
['fontSizeRange', 'fontSizeRange2'].forEach(id => el(id).addEventListener('input', () => {
  Display.fontSize = parseInt(el(id).value, 10); settingSet('fontSize', Display.fontSize); applyDisplay();
}));
$$('#themeSeg button, #themeSeg2 button').forEach(b => b.addEventListener('click', () => {
  Display.theme = b.dataset.v; settingSet('theme', Display.theme); applyDisplay();
}));
darkQuery.addEventListener('change', () => { if(Display.theme === 'auto') applyDisplay(); });
['followToggle', 'followToggle2'].forEach(id => el(id).addEventListener('change', () => {
  Display.follow = el(id).checked; settingSet('follow', Display.follow ? '1' : '0'); applyDisplay();
  if(Display.follow) Reader.followScroll(false);
}));
['fadeToggle', 'fadeToggle2'].forEach(id => el(id).addEventListener('change', () => {
  Display.fade = el(id).checked; settingSet('fadeRead', Display.fade ? '1' : '0'); applyDisplay();
}));
applyDisplay();

// ---------------- Library ----------------
const Library = {
  shelves: loadShelves(),
  books: [],
  filter: 'All',
  editing: null,
  coverUrls: new Map(), // book id -> object URL for its cover

  async refresh(){
    this.books = await listLibraryBooks();
    this.renderShelves();
    this.renderBooks();
    el('shelvesVal').textContent = this.shelves.length;
  },
  renderShelves(){
    const row = el('shelfRow'); row.innerHTML = '';
    ['All', ...this.shelves, 'Finished'].forEach(name => {
      const b = document.createElement('button');
      b.textContent = name; b.classList.toggle('on', this.filter === name);
      b.addEventListener('click', () => { this.filter = name; this.renderShelves(); this.renderBooks(); });
      row.appendChild(b);
    });
    const e = document.createElement('button'); e.className = 'edit'; e.textContent = 'Edit shelves';
    e.addEventListener('click', () => { this.renderShelfManager(); openSheet('shelvesSheet'); });
    row.appendChild(e);
    if(this.filter !== 'All' && this.filter !== 'Finished' && !this.shelves.includes(this.filter)) this.filter = 'All';
  },
  coverUrl(rec){
    if(!rec.cover) return null;
    if(!this.coverUrls.has(rec.id)) this.coverUrls.set(rec.id, URL.createObjectURL(rec.cover));
    return this.coverUrls.get(rec.id);
  },
  renderBooks(){
    const list = el('bookList'); list.innerHTML = '';
    const shown = this.books.filter(b => {
      if(this.filter === 'All') return true;
      if(this.filter === 'Finished') return !!(b.progress && b.progress.finished);
      return (b.shelves || []).includes(this.filter);
    });
    if(!shown.length){
      const empty = document.createElement('div'); empty.className = 'lib-empty';
      empty.textContent = this.books.length ? 'Nothing on this shelf yet. Open a book’s ⋯ menu to add it.' : 'No books yet. Add one below.';
      list.appendChild(empty);
      return;
    }
    // Books of one series sit together under a header, in series order, at the spot
    // where the most recently opened of them would have been.
    const groupSeries = settingGet('groupSeries', '1') === '1';
    const groups = new Map();
    shown.forEach(b => { const key = (b.series || '').trim().toLowerCase(); if(key){ if(!groups.has(key)) groups.set(key, []); groups.get(key).push(b); } });
    const rendered = new Set();
    shown.forEach(rec => {
      if(rendered.has(rec.id)) return;
      const key = (rec.series || '').trim().toLowerCase();
      const grp = key ? groups.get(key) : null;
      if(groupSeries && grp && grp.length > 1){
        const head = document.createElement('div'); head.className = 'series-head';
        const done = grp.filter(x => x.progress && x.progress.finished).length;
        head.innerHTML = '<b></b><span></span>';
        head.querySelector('b').textContent = rec.series.trim();
        head.querySelector('span').textContent = grp.length + ' books' + (done ? ' · ' + done + ' finished' : '');
        list.appendChild(head);
        grp.slice().sort((x, y) => ((x.seriesIndex != null ? x.seriesIndex : 1e9) - (y.seriesIndex != null ? y.seriesIndex : 1e9)) || ((y.savedAt || 0) - (x.savedAt || 0)))
           .forEach(b => { list.appendChild(this.card(b, { inSeries: true })); rendered.add(b.id); });
      } else {
        list.appendChild(this.card(rec, {})); rendered.add(rec.id);
      }
    });
  },
  card(rec, opts){
    const card = document.createElement('div'); card.className = 'book'; card.setAttribute('role', 'button'); card.tabIndex = 0;
    const cover = document.createElement('div'); cover.className = 'cover';
    const url = this.coverUrl(rec);
    if(url){ const img = document.createElement('img'); img.src = url; img.alt = ''; cover.appendChild(img); cover.classList.add('has-img'); }
    else cover.textContent = libraryBookTitle(rec);
    card.appendChild(cover);

    const body = document.createElement('div');
    const t = document.createElement('div'); t.className = 't'; t.textContent = libraryBookTitle(rec); body.appendChild(t);
    const a = document.createElement('div'); a.className = 'a'; a.textContent = rec.author || rec.name.replace(/\.(epub|pdf)$/i, ''); body.appendChild(a);

    const p = rec.progress;
    const fraction = p ? (p.finished ? 1 : p.fraction || 0) : 0;
    const pr = document.createElement('div'); pr.className = 'pr';
    pr.innerHTML = '<div class="bar"><i></i></div><span></span>';
    pr.querySelector('i').style.width = Math.round(fraction * 100) + '%';
    pr.querySelector('span').textContent = p ? (p.finished ? 'Done' : Math.round(fraction * 100) + '%') : 'New';
    body.appendChild(pr);

    const cont = document.createElement('div'); cont.className = 'cont';
    if(p && p.finished) cont.textContent = 'Finished · tap to read again';
    else if(p && p.chapterTitle) cont.textContent = 'Continue · ' + p.chapterTitle + (p.secLeft ? ' · ' + fmtLong(p.secLeft) + ' left' : '');
    else if(rec.totalChars) cont.textContent = 'Start · about ' + fmtLong(rec.totalChars * Player.secPerCharNow());
    else cont.textContent = 'Open';
    body.appendChild(cont);

    if((rec.shelves && rec.shelves.length) || rec.series){
      const tags = document.createElement('div'); tags.className = 'tags';
      if(rec.series){
        const tag = document.createElement('span'); tag.className = 'tag num';
        const n = rec.seriesIndex != null ? '#' + rec.seriesIndex : '';
        tag.textContent = opts.inSeries ? (n || 'Series') : (rec.series.trim() + (n ? ' ' + n : ''));
        tags.appendChild(tag);
      }
      (rec.shelves || []).forEach(s => { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = s; tags.appendChild(tag); });
      body.appendChild(tags);
    }
    card.appendChild(body);

    const more = document.createElement('button'); more.className = 'more'; more.setAttribute('aria-label', 'Book options'); more.textContent = '⋯';
    more.addEventListener('click', ev => { ev.stopPropagation(); this.openBookSheet(rec); });
    card.appendChild(more);

    card.addEventListener('click', () => this.open(rec));
    card.addEventListener('keydown', ev => { if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); this.open(rec); } });
    return card;
  },
  async open(rec){
    const full = await getLibraryBook(rec.id);
    if(!full || !full.data){ el('loadStatus').textContent = 'That book could not be read from storage. Add the file again.'; return; }
    const file = new File([full.data], full.name, { type: full.type || '' });
    handleFile(file, { displayName: full.displayName || null, record: full });
  },
  openBookSheet(rec){
    this.editing = rec;
    el('bookSheetTitle').textContent = libraryBookTitle(rec);
    el('bookNameInput').value = libraryBookTitle(rec);
    el('bookSeriesInput').value = rec.series || '';
    el('bookSeriesIndexInput').value = rec.seriesIndex != null ? rec.seriesIndex : '';
    const g = el('bookShelves'); g.innerHTML = '';
    if(!this.shelves.length){ g.innerHTML = '<div class="row"><span class="sub">No shelves yet. Add some under Edit shelves.</span></div>'; }
    this.shelves.forEach(s => {
      const r = document.createElement('label'); r.className = 'row check';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = (rec.shelves || []).includes(s);
      cb.addEventListener('change', async () => {
        rec.shelves = (rec.shelves || []).filter(x => x !== s);
        if(cb.checked) rec.shelves.push(s);
        await updateLibraryBook(rec.id, { shelves: rec.shelves });
        this.renderBooks();
      });
      const label = document.createElement('span'); label.textContent = s;
      r.appendChild(cb); r.appendChild(label); g.appendChild(r);
    });
    openSheet('bookSheet');
  },
  renderShelfManager(){
    const l = el('shelfList'); l.innerHTML = '';
    if(!this.shelves.length) l.innerHTML = '<div class="row"><span class="sub">No shelves yet.</span></div>';
    this.shelves.forEach(s => {
      const r = document.createElement('div'); r.className = 'row';
      const n = this.books.filter(b => (b.shelves || []).includes(s)).length;
      const label = document.createElement('span'); label.textContent = s;
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = n + (n === 1 ? ' book' : ' books'); label.appendChild(sub);
      const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Delete shelf');
      x.addEventListener('click', async () => {
        this.shelves = this.shelves.filter(v => v !== s); saveShelves(this.shelves);
        for(const b of this.books){ if((b.shelves || []).includes(s)){ b.shelves = b.shelves.filter(v => v !== s); await updateLibraryBook(b.id, { shelves: b.shelves }); } }
        this.renderShelfManager(); this.renderShelves(); this.renderBooks();
        el('shelvesVal').textContent = this.shelves.length;
      });
      r.appendChild(label); r.appendChild(x); l.appendChild(r);
    });
  },
  // A new book gets a shelf suggested from the EPUB's own subject metadata.
  suggestShelves(subjects){
    const text = (subjects || []).join(' | ');
    const out = [];
    const rules = [
      ['Christian', /christian|religio|bible|biblical|devotion|theolog|gospel|church|faith/i],
      ['Biography', /biograph|memoir|autobiograph|diary|letters/i],
      ['Sci-fi', /science fiction|sci-?fi|space opera/i],
      ['Classics', /classic/i]
    ];
    rules.forEach(([shelf, re]) => { if(re.test(text) && this.shelves.includes(shelf)) out.push(shelf); });
    return out;
  }
};
el('bookRenameBtn').addEventListener('click', async () => {
  const rec = Library.editing; if(!rec) return;
  const name = el('bookNameInput').value.trim();
  if(name){ rec.displayName = name; await updateLibraryBook(rec.id, { displayName: name }); el('bookSheetTitle').textContent = name; Library.renderBooks(); }
});
el('bookSeriesBtn').addEventListener('click', async () => {
  const rec = Library.editing; if(!rec) return;
  rec.series = el('bookSeriesInput').value.trim();
  const n = parseFloat(el('bookSeriesIndexInput').value);
  rec.seriesIndex = rec.series && !isNaN(n) ? n : null;
  rec.seriesManual = true;
  await updateLibraryBook(rec.id, { series: rec.series, seriesIndex: rec.seriesIndex, seriesManual: true });
  Library.renderBooks();
});
el('bookRestartBtn').addEventListener('click', async () => {
  const rec = Library.editing; if(!rec) return;
  const key = progressKeyFor(rec.name.replace(/\.(epub|pdf)$/i, ''), rec.data ? rec.data.byteLength : 0);
  saveProgressFor(key, { chapter: 0, sentence: 0 });
  rec.progress = null; await updateLibraryBook(rec.id, { progress: null });
  if(Reader.book && Reader.book.id === rec.id) Player.seek(0, 0);
  Library.renderBooks(); closeSheet('bookSheet');
});
el('bookRemoveBtn').addEventListener('click', async () => {
  const rec = Library.editing; if(!rec) return;
  if(Reader.book && Reader.book.id === rec.id){ Player.unload(); Reader.book = null; }
  await deleteBookFromLibrary(rec.id);
  await dismissBook(rec.id); // so a watched folder doesn't bring it straight back
  closeSheet('bookSheet'); Library.refresh();
});
el('addShelfBtn').addEventListener('click', () => {
  const v = el('newShelfInput').value.trim();
  if(!v || Library.shelves.includes(v)) return;
  Library.shelves.push(v); saveShelves(Library.shelves); el('newShelfInput').value = '';
  Library.renderShelfManager(); Library.renderShelves(); el('shelvesVal').textContent = Library.shelves.length;
});
el('newShelfInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); el('addShelfBtn').click(); } });
el('shelvesRow').addEventListener('click', () => { Library.renderShelfManager(); openSheet('shelvesSheet'); });

// ---------------- Watched folder ----------------
// Chrome and Edge on desktop can remember a folder between visits (File System
// Access API): the app checks it for new EPUBs and PDFs on every start and on demand.
// Other browsers can only import a folder's contents when it is picked. New books
// arrive with no shelf; shelving is up to the person.
const Folder = {
  handle: null,
  supported: 'showDirectoryPicker' in window,
  scanning: false,
  async init(){
    this.handle = (await kvGet('watchedFolder')) || null;
    this.render();
    if(!this.handle) return;
    try{
      if((await this.handle.queryPermission({ mode: 'read' })) === 'granted') this.scan();
      else this.render('Tap Check now to allow access to it again.');
    } catch(e){ this.render(); }
  },
  async pick(){
    if(!this.supported){ el('folderInput').click(); return; }
    try{
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await kvSet('watchedFolder', handle);
      this.handle = handle; this.render();
      await this.scan();
    } catch(err){ if(!err || err.name !== 'AbortError'){ console.error(err); this.render('Could not use that folder: ' + (err && err.message)); } }
  },
  async forget(){ await kvSet('watchedFolder', undefined); this.handle = null; settingSet('folderLastScan', ''); this.render(); },
  async ensurePermission(){
    if(!this.handle) return false;
    let p = await this.handle.queryPermission({ mode: 'read' });
    if(p !== 'granted') p = await this.handle.requestPermission({ mode: 'read' });
    return p === 'granted';
  },
  async *walk(dir, path){
    for await (const [name, h] of dir.entries()){
      if(h.kind === 'file'){ if(/\.(epub|pdf)$/i.test(name)) yield { handle: h, path: path + name }; }
      else if(h.kind === 'directory') yield* this.walk(h, path + name + '/');
    }
  },
  async scan(){
    if(!this.handle || this.scanning) return;
    let ok = false;
    try{ ok = await this.ensurePermission(); } catch(e){ ok = false; }
    if(!ok){ this.render('Access was not allowed. Tap Check now to try again.'); return; }
    this.scanning = true;
    const known = new Set(Library.books.map(b => b.id));
    (await dismissedBooks()).forEach(id => known.add(id)); // deleted on purpose: leave them out
    let added = 0, seen = 0;
    try{
      for await (const f of this.walk(this.handle, '')){
        seen++;
        const id = f.path.split('/').pop().trim().toLowerCase();
        if(known.has(id)) continue;
        this.render('Adding ' + f.path + ' …');
        try{ if(await importFile(await f.handle.getFile(), { sourcePath: f.path, fromFolder: true })){ known.add(id); added++; } }
        catch(err){ console.error('Could not add', f.path, err); }
      }
      settingSet('folderLastScan', Date.now());
    } catch(err){ console.error(err); this.scanning = false; this.render('Could not read the folder: ' + (err && err.message)); return; }
    this.scanning = false;
    if(added) await Library.refresh();
    this.render(added ? 'Added ' + added + (added === 1 ? ' new book' : ' new books') + '.' : 'No new books (' + seen + ' checked).');
  },
  // Browsers without a persistent handle: import whatever is in the picked folder now.
  async importPicked(files){
    const list = Array.from(files || []).filter(f => /\.(epub|pdf)$/i.test(f.name));
    if(!list.length){ this.render('No EPUB or PDF files in that folder.'); return; }
    const known = new Set(Library.books.map(b => b.id));
    (await dismissedBooks()).forEach(id => known.add(id));
    let added = 0;
    for(const f of list){
      if(known.has(bookIdFor(f))) continue;
      this.render('Adding ' + f.name + ' …');
      try{ if(await importFile(f, { sourcePath: f.webkitRelativePath || f.name, fromFolder: true })){ known.add(bookIdFor(f)); added++; } } catch(err){ console.error(err); }
    }
    if(added) await Library.refresh();
    this.render(added ? 'Added ' + added + (added === 1 ? ' new book' : ' new books') + ' from that folder.' : 'No new books in that folder.');
  },
  render(msg){
    const name = this.handle ? this.handle.name : '';
    const last = parseInt(settingGet('folderLastScan', '0'), 10);
    el('folderTitle').textContent = name ? 'Watching \u201C' + name + '\u201D' : (this.supported ? 'Or keep a folder in step' : 'Or add a whole folder');
    el('folderSub').textContent = msg || (name
      ? 'New EPUBs and PDFs in it, and in its subfolders, are added when the app opens.' + (last ? ' Last checked ' + new Date(last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : '')
      : (this.supported ? 'New EPUBs and PDFs in it, and in its subfolders, are added to the library on their own. New books arrive without a shelf; put them where you like.'
                        : 'Every EPUB and PDF in the folder and its subfolders is added, without a shelf. This browser cannot remember the folder, so pick it again to check for new files.'));
    el('folderPickBtn').textContent = name ? 'Change folder' : (this.supported ? 'Choose a folder' : 'Add a folder');
    el('folderScanBtn').classList.toggle('hidden', !name);
    el('folderForgetBtn').classList.toggle('hidden', !name);
    el('folderVal').textContent = name || 'None';
    el('folderRowSub').textContent = name ? (last ? 'Last checked ' + new Date(last).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Not checked yet') : (this.supported ? 'New EPUBs and PDFs are added on their own' : 'Pick a folder to add its books');
  }
};
el('folderPickBtn').addEventListener('click', () => Folder.pick());
el('folderScanBtn').addEventListener('click', () => Folder.scan());
el('folderForgetBtn').addEventListener('click', () => Folder.forget());
el('folderRow').addEventListener('click', () => { el('viewSettings').classList.add('hidden'); showView('viewLibrary'); Folder.pick(); });
el('folderInput').addEventListener('change', e => { Folder.importPicked(e.target.files); e.target.value = ''; });
el('seriesToggle').addEventListener('change', () => { settingSet('groupSeries', el('seriesToggle').checked ? '1' : '0'); Library.renderBooks(); });

// ---------------- Opening a file ----------------
el('fileInput').addEventListener('change', e => {
  const files = Array.from(e.target.files || []); e.target.value = '';
  if(files.length === 1) handleFile(files[0]);
  else if(files.length > 1) importFiles(files);
});

// Reads a book's metadata (title, author, cover, series) and puts it in the library
// without opening it. Chapters are parsed the first time it is opened.
async function importFile(file, opts){
  opts = opts || {};
  const name = file.name.toLowerCase();
  if(!/\.(epub|pdf)$/.test(name)) return false;
  const buf = await file.arrayBuffer();
  const meta = name.endsWith('.epub') ? await readEpubMeta(buf) : await readPdfMeta(buf.slice(0));
  if(!opts.fromFolder) await undismissBook(bookIdFor(file));
  await saveBookToLibrary(file, buf, {
    title: meta.title || '', author: meta.author || '', cover: meta.cover || undefined,
    series: meta.series || '', seriesIndex: meta.seriesIndex, sourcePath: opts.sourcePath || '',
    shelves: opts.suggestShelves ? Library.suggestShelves(meta.subjects) : []
  });
  return true;
}
async function importFiles(files){
  const status = el('loadStatus');
  let added = 0;
  for(const file of files){
    status.textContent = 'Adding ' + file.name + ' …';
    try{ if(await importFile(file, { suggestShelves: true })) added++; }
    catch(err){ console.error(err); }
  }
  status.textContent = 'Added ' + added + (added === 1 ? ' book' : ' books') + ' to the library.';
  Library.refresh();
}
const dropZone = el('dropZone');
['dragover', 'dragenter'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('over'); }));
dropZone.addEventListener('drop', e => { if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

async function handleFile(file, opts){
  opts = opts || {};
  const status = el('loadStatus');
  status.textContent = 'Reading ' + file.name + ' …';
  try{
    const name = file.name.toLowerCase();
    const fileTitle = file.name.replace(/\.(epub|pdf)$/i, '');
    const buf = await file.arrayBuffer();
    let chapters, meta = { title: '', author: '', subjects: [], cover: null };
    if(name.endsWith('.epub')){
      chapters = await parseEpub(buf);
      meta = await readEpubMeta(buf);
    } else if(name.endsWith('.pdf')){
      chapters = await parsePdf(buf.slice(0)); // pdf.js's worker can detach the buffer it's given, so hand it a copy
      meta = await readPdfMeta(buf.slice(0));
    } else {
      status.textContent = 'Please choose an .epub or .pdf file.'; return;
    }
    if(!chapters.length){ status.textContent = 'Could not find readable text in that file.'; return; }

    const rec = opts.record;
    const title = opts.displayName || (rec && rec.displayName) || meta.title || fileTitle;
    const author = meta.author || (rec && rec.author) || '';
    const cover = meta.cover || (rec && rec.cover) || null;
    const progressKey = progressKeyFor(fileTitle, file.size);
    const saved = loadProgressFor(progressKey);
    undismissBook(bookIdFor(file)); // opened by hand, so it is wanted again
    const totalChars = chapters.reduce((a, ch) => a + ch.sentences.reduce((b, s) => b + s.length, 0), 0);

    if(Reader.book && Reader.book.artworkUrl) URL.revokeObjectURL(Reader.book.artworkUrl);
    const book = {
      id: bookIdFor(file), title, author, progressKey,
      artworkUrl: cover ? URL.createObjectURL(cover) : null, artworkType: cover ? cover.type : null
    };
    Reader.book = book;
    Player.load(chapters, book, saved);
    Reader.renderChapter();
    showView('viewReader');
    requestAnimationFrame(() => Reader.followScroll(true));
    status.textContent = '';

    // Library record: file bytes, cover, metadata, and a suggested shelf for a new book.
    await saveBookToLibrary(file, buf, {
      title: meta.title || '', author, cover: meta.cover || undefined, totalChars, chapterCount: chapters.length,
      series: meta.series || '', seriesIndex: meta.seriesIndex,
      shelves: Library.suggestShelves(meta.subjects)
    });
    Player.saveSummary(true);
    Library.refresh();
  } catch(err){
    console.error(err);
    status.textContent = 'Something went wrong opening that file: ' + err.message;
  }
}

// ---------------- Reader ----------------
const Reader = {
  book: null,
  renderedCh: -1,
  spans: [],
  curIdx: -1,
  autoScrollUntil: 0,
  userScrolled: false,
  suppressScrollOnce: false,

  renderChapter(){
    const text = el('text'); text.innerHTML = '';
    const ch = Player.chapter(); if(!ch) return;
    const name = document.createElement('p'); name.className = 'book-name'; name.textContent = this.book ? this.book.title : ''; text.appendChild(name);
    const h = document.createElement('h2'); h.textContent = ch.title; text.appendChild(h);
    this.spans = [];
    ch.paragraphs.forEach((para, pIdx) => {
      const p = document.createElement('p'); p.className = 'para'; p.dataset.p = pIdx;
      para.sentenceIndices.forEach(si => {
        const span = document.createElement('span'); span.className = 's'; span.dataset.i = si;
        span.textContent = displayFilteredText(ch.sentences[si]) + ' ';
        span.addEventListener('click', () => { this.suppressScrollOnce = true; Player.seek(Player.ch, si); });
        p.appendChild(span); this.spans[si] = span;
      });
      text.appendChild(p);
    });
    const end = document.createElement('p'); end.className = 'end';
    end.textContent = Player.ch < Player.chapters.length - 1 ? 'End of ' + ch.title : 'End of the book';
    text.appendChild(end);
    this.renderedCh = Player.ch; this.curIdx = -1;
    el('chapTitle').textContent = ch.title;
    el('chapSub').textContent = 'Chapter ' + (Player.ch + 1) + ' of ' + Player.chapters.length + ' · tap for contents';
    this.highlight();
  },

  highlight(){
    if(this.renderedCh !== Player.ch) return this.renderChapter();
    const ch = Player.chapter(); if(!ch) return;
    const cur = Player.s;
    if(this.curIdx !== cur){
      if(this.curIdx >= 0 && this.spans[this.curIdx]) this.spans[this.curIdx].classList.remove('cur');
      // Mark everything before the current sentence as read; unmark on the way back.
      if(this.curIdx < 0 || cur < this.curIdx){
        this.spans.forEach((sp, i) => sp.classList.toggle('done', i < cur));
      } else {
        for(let i = this.curIdx; i < cur; i++) this.spans[i].classList.add('done');
      }
      this.spans[cur].classList.remove('done');
      this.spans[cur].classList.add('cur');
      this.curIdx = cur;
      const curPara = ch.sentenceParagraph[cur];
      $$('#text .para').forEach(p => p.classList.toggle('active', Number(p.dataset.p) === curPara));
    }
    el('nowText').textContent = displayFilteredText(ch.sentences[cur] || '');
    this.updateScrub();
  },

  // Scroll ownership: the app scrolls only while follow-along is on and the page is
  // visible. Smooth while reading; instant when catching up after the screen was off.
  followScroll(instant){
    if(!Display.follow) return;
    const text = el('text');
    const sp = this.spans[Player.s]; if(!sp) return;
    const target = sp.offsetTop - text.clientHeight * 0.35;
    this.autoScrollUntil = Date.now() + 1200;
    this.userScrolled = false;
    text.classList.toggle('nosmooth', !!instant);
    text.scrollTo({ top: Math.max(0, target), behavior: instant ? 'auto' : 'smooth' });
    if(instant) requestAnimationFrame(() => text.classList.remove('nosmooth'));
    el('returnPill').classList.add('hidden');
  },
  curVisible(){
    const text = el('text'); const sp = this.spans[Player.s]; if(!sp) return true;
    const top = sp.offsetTop - text.scrollTop, bottom = top + sp.offsetHeight;
    return top > 40 && bottom < text.clientHeight - 190;
  },
  onUserScroll(){
    if(Date.now() < this.autoScrollUntil && !this.userScrolled) return;
    if(this.userScrolled && Display.follow){ Display.follow = false; applyDisplay(); }
    this.userScrolled = false;
    el('returnPill').classList.toggle('hidden', Display.follow || this.curVisible());
  },

  updateScrub(){
    const info = Player.positionInfo();
    el('posLeft').textContent = fmtClock(info.chapterElapsed);
    el('posRight').textContent = '-' + fmtClock(Math.max(0, info.chapterTotal - info.chapterElapsed));
    el('scrubFill').style.width = (info.chapterTotal ? Math.min(100, info.chapterElapsed / info.chapterTotal * 100) : 0) + '%';
  },
  updatePlayButton(){
    const playing = Player.state !== 'idle';
    el('playIcon').innerHTML = playing
      ? '<rect x="6" y="5" width="4.2" height="14" rx="1"/><rect x="13.8" y="5" width="4.2" height="14" rx="1"/>'
      : '<polygon points="8,5 8,19 19,12"/>';
    el('playBtn').classList.toggle('preparing', Player.state === 'preparing');
    el('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  },
  updateChips(){
    el('speedChip').textContent = Voice.settings.speed.toFixed(1).replace(/\.0$/, '.0') + '×';
    const id = Voice.currentVoiceId();
    el('voiceChip').textContent = id ? Voice.voiceLabel(id).name : 'Voice';
    el('setVoiceVal').textContent = (id ? Voice.voiceLabel(id).name : '—') + ' · ' + Voice.settings.speed.toFixed(1) + '×';
  },

  renderToc(){
    const list = el('tocList'); list.innerHTML = '';
    Player.chapters.forEach((ch, i) => {
      const r = document.createElement('button'); r.className = 'row' + (i === Player.ch ? ' on' : '');
      const label = document.createElement('span'); label.textContent = ch.title;
      const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = 'about ' + fmtLong(ch.charTotal * Player.secPerCharNow()); label.appendChild(sub);
      r.appendChild(label);
      const pct = document.createElement('span'); pct.className = 'toc-pct';
      pct.textContent = i < Player.ch ? 'read' : i === Player.ch ? (ch.sentences.length ? Math.round(Player.s / ch.sentences.length * 100) + '%' : '') : '';
      r.appendChild(pct);
      r.addEventListener('click', () => { closeSheet('tocSheet'); Player.seek(i, 0); });
      list.appendChild(r);
    });
  }
};

// ---------------- Search within the book ----------------
// Lives in the Contents sheet: type and the chapter list gives way to matching
// sentences; tap one to start reading there.
const Search = {
  run(query){
    const list = el('searchResults'), foot = el('searchFoot');
    const q = query.trim();
    if(!q){ list.classList.add('hidden'); el('tocList').classList.remove('hidden'); foot.textContent = ''; return; }
    // Match on the original text with a case-insensitive pattern, so the offset used
    // for the snippet is an offset into that same text (lower-casing can change length).
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const MAX = 100;
    const hits = [];
    outer: for(let ci = 0; ci < Player.chapters.length; ci++){
      const sentences = Player.chapters[ci].sentences;
      for(let si = 0; si < sentences.length; si++){
        const m = re.exec(sentences[si]);
        if(m){ hits.push({ item: { ch: ci, s: si }, at: m.index, len: m[0].length }); if(hits.length >= MAX) break outer; }
      }
    }
    list.innerHTML = '';
    el('tocList').classList.add('hidden'); list.classList.remove('hidden');
    if(!hits.length){ list.innerHTML = '<div class="row"><span class="sub">Nothing found for \u201C' + query.trim().replace(/</g, '&lt;') + '\u201D</span></div>'; foot.textContent = ''; return; }
    hits.forEach(({ item, at, len }) => {
      const ch = Player.chapters[item.ch];
      const text = ch.sentences[item.s];
      const q = { length: len };
      const r = document.createElement('button'); r.className = 'row result';
      const body = document.createElement('span');
      const snip = document.createElement('span'); snip.className = 'snip';
      // Show a window around the match with the match itself marked.
      const start = Math.max(0, at - 60), end = Math.min(text.length, at + q.length + 90);
      if(start > 0) snip.appendChild(document.createTextNode('\u2026'));
      snip.appendChild(document.createTextNode(text.slice(start, at)));
      const m = document.createElement('mark'); m.textContent = text.slice(at, at + q.length); snip.appendChild(m);
      snip.appendChild(document.createTextNode(text.slice(at + q.length, end) + (end < text.length ? '\u2026' : '')));
      const where = document.createElement('span'); where.className = 'where'; where.textContent = ch.title;
      body.appendChild(snip); body.appendChild(where); r.appendChild(body);
      r.addEventListener('click', () => { closeSheet('tocSheet'); Player.seek(item.ch, item.s); });
      list.appendChild(r);
    });
    foot.textContent = hits.length >= MAX ? 'First ' + MAX + ' matches shown. Add a word to narrow it down.' : hits.length + (hits.length === 1 ? ' match' : ' matches');
  }
};
let searchTimer = null;
el('bookSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => Search.run(el('bookSearch').value), 150); });
el('bookSearch').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); const first = el('searchResults').querySelector('.result'); if(first) first.click(); } });

// Wire the reader to the player.
Player.on((type, detail) => {
  if(type === 'chapter'){ if(!el('viewReader').classList.contains('hidden')) Reader.renderChapter(); }
  if(type === 'position'){
    const chapterChanged = Reader.renderedCh !== Player.ch; // highlight() re-renders, so read this first
    Reader.highlight();
    if(document.hidden) return; // catch up on 'visible' instead
    if(Reader.suppressScrollOnce){ Reader.suppressScrollOnce = false; return; }
    if(Display.follow) Reader.followScroll(!!(detail && detail.jump && chapterChanged));
    else el('returnPill').classList.toggle('hidden', Reader.curVisible());
  }
  if(type === 'visible'){ Reader.highlight(); if(Display.follow) Reader.followScroll(true); else Reader.onUserScroll(); }
  if(type === 'state'){ Reader.updatePlayButton(); Reader.updateScrub(); }
  if(type === 'tick') Reader.updateScrub();
  if(type === 'finished') Library.refresh();
});
Player.init();

const textPane = el('text');
// Only a wheel or a finger drag counts as the person scrolling; a tap on a sentence does not.
['wheel', 'touchmove'].forEach(ev => textPane.addEventListener(ev, () => { Reader.userScrolled = true; }, { passive: true }));
textPane.addEventListener('scroll', () => Reader.onUserScroll(), { passive: true });
el('returnPill').addEventListener('click', () => { Display.follow = true; settingSet('follow', '1'); applyDisplay(); Reader.followScroll(false); });

el('backBtn').addEventListener('click', () => { Player.saveSummary(true); showView('viewLibrary'); Library.refresh(); });
el('chapBtn').addEventListener('click', () => { Reader.renderToc(); el('bookSearch').value = ''; Search.run(''); openSheet('tocSheet'); });
el('displayBtn').addEventListener('click', () => openSheet('displaySheet'));
el('playBtn').addEventListener('click', () => { if(Player.state === 'idle'){ Display.follow = true; settingSet('follow', '1'); applyDisplay(); } Player.toggle(); });
el('prevBtn').addEventListener('click', () => Player.prev());
el('nextBtn').addEventListener('click', () => Player.next());
el('scrubBar').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect();
  Player.seekChapterFraction(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
});
el('speedChip').addEventListener('click', () => openVoiceSheet());
el('voiceChip').addEventListener('click', () => openVoiceSheet());
el('setVoiceRow').addEventListener('click', () => openVoiceSheet());

document.addEventListener('keydown', e => {
  if(el('viewReader').classList.contains('hidden')) return;
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if(!$$('.sheet').every(sh => sh.classList.contains('hidden'))) return;
  if(e.key === ' '){ e.preventDefault(); Player.toggle(); }
  else if(e.key === 'ArrowRight'){ e.preventDefault(); Player.next(); }
  else if(e.key === 'ArrowLeft'){ e.preventDefault(); Player.prev(); }
});

// ---------------- Voice & speed sheet ----------------
let voiceListLoadedFor = null;
function openVoiceSheet(){
  openSheet('voiceSheet');
  syncSpeedControls();
  const key = Voice.settings.engine + ':' + Voice.settings.useServer + ':' + Voice.settings.serverUrl;
  if(voiceListLoadedFor !== key) loadVoiceList();
  else markSelectedVoice();
}
async function loadVoiceList(){
  const list = el('voiceList');
  list.innerHTML = '<div class="row"><span class="sub">Loading voices…</span></div>';
  const voices = await Voice.listVoices();
  voiceListLoadedFor = Voice.settings.engine + ':' + Voice.settings.useServer + ':' + Voice.settings.serverUrl;
  list.innerHTML = '';
  if(!voices.length){ list.innerHTML = '<div class="row"><span class="sub">No voices available. See the note below, or check the voice server under Settings.</span></div>'; Reader.updateChips(); return; }
  voices.forEach(v => {
    const r = document.createElement('button'); r.className = 'row'; r.dataset.id = v.id;
    const label = document.createElement('span'); label.textContent = v.name;
    const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = v.detail; label.appendChild(sub);
    r.appendChild(label);
    const check = document.createElement('span'); check.className = 'val noarrow'; check.textContent = '✓'; r.appendChild(check);
    r.addEventListener('click', () => { Voice.setVoiceId(v.id); markSelectedVoice(); Reader.updateChips(); Player.clearAudio(); });
    list.appendChild(r);
  });
  markSelectedVoice();
  Reader.updateChips();
}
function markSelectedVoice(){
  const id = Voice.currentVoiceId();
  $$('#voiceList .row').forEach(r => { const on = r.dataset.id === id; r.classList.toggle('on', on); r.querySelector('.val').style.visibility = on ? 'visible' : 'hidden'; });
}
function syncSpeedControls(){
  $$('#speedChips button').forEach(b => b.classList.toggle('on', Math.abs(parseFloat(b.dataset.sp) - Voice.settings.speed) < 0.01));
  el('rateSlider').value = Voice.settings.speed;
  el('rateLabel').textContent = Voice.settings.speed.toFixed(2) + '×';
  Reader.updateChips();
}
function setSpeed(v){ Voice.setSpeed(v); syncSpeedControls(); Player.clearAudio(); }
el('speedChips').addEventListener('click', e => { const b = e.target.closest('button'); if(b) setSpeed(parseFloat(b.dataset.sp)); });
el('rateSlider').addEventListener('change', () => setSpeed(parseFloat(el('rateSlider').value)));
el('rateSlider').addEventListener('input', () => { el('rateLabel').textContent = parseFloat(el('rateSlider').value).toFixed(2) + '×'; });
el('sampleVoiceBtn').addEventListener('click', async () => {
  const b = el('sampleVoiceBtn'); b.disabled = true;
  try{ await Voice.preview('The lamp is lit, and the story can begin.'); } catch(err){ console.error(err); setEngineStatus('Could not play a sample: ' + err.message); }
  b.disabled = false;
});
el('refreshVoicesBtn').addEventListener('click', () => { Voice.forgetServer(); loadVoiceList(); });
syncSpeedControls();

// ---------------- Settings ----------------
el('libSettingsBtn').addEventListener('click', () => openSettings());
el('readerSettingsBtn').addEventListener('click', () => openSettings());
el('settingsBackBtn').addEventListener('click', () => { el('viewSettings').classList.add('hidden'); });
function openSettings(){
  el('viewSettings').classList.remove('hidden');
  syncSettings();
  refreshStorageRows();
}
function syncSettings(){
  $$('#skipSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === Player.skipUnit));
  el('gapRange').value = Voice.settings.gapMs; el('gapLabel').textContent = Voice.settings.gapMs + ' ms';
  el('filterToggle').checked = filterEnabled;
  el('wordsVal').textContent = customBadWords.length ? customBadWords.length + ' added' : 'none added';
  el('pronVal').textContent = pronunciationRules.length + (pronunciationRules.length === 1 ? ' rule' : ' rules');
  $$('#runSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === (Voice.settings.useServer ? 'server' : 'device')));
  el('engineSelect').value = Voice.settings.engine;
  el('serverRow').classList.toggle('hidden', !Voice.settings.useServer);
  el('serverSub').textContent = Voice.settings.serverUrl.replace(/^https?:\/\//, '').replace(/\/[^/]*$/, '');
  el('serverDot').classList.toggle('online', Voice.settings.useServer);
  const gen = Player.genSummary();
  el('genSpeedVal').textContent = gen.clips ? gen.timesFaster.toFixed(1) + '×' : '—';
  el('genSpeedSub').textContent = gen.clips
    ? 'Makes speech ' + gen.timesFaster.toFixed(1) + '× as fast as it’s read, plus ' + gen.fixed.toFixed(1) + ' s a clip (' + gen.clips + ' clips)'
    : 'Measured as this voice reads';
  el('shelvesVal').textContent = Library.shelves.length;
  el('seriesToggle').checked = settingGet('groupSeries', '1') === '1';
  Reader.updateChips();
}
$$('#skipSeg button').forEach(b => b.addEventListener('click', () => { Player.setSkipUnit(b.dataset.v); syncSettings(); }));
el('gapRange').addEventListener('input', () => { el('gapLabel').textContent = el('gapRange').value + ' ms'; });
el('gapRange').addEventListener('change', () => { Voice.setGapMs(parseInt(el('gapRange').value, 10)); Player.clearAudio(); });

// Words
loadFilterSettings();
el('filterWords').value = customBadWords.join(', ');
el('filterToggle').addEventListener('change', () => {
  filterEnabled = el('filterToggle').checked; saveFilterSettings(); Player.clearAudio();
  if(Player.chapters.length){ Reader.renderedCh = -1; Reader.highlight(); }
});
el('wordsRow').addEventListener('click', () => openSheet('wordsSheet'));
// While typing, only the cache and the on-screen masking update; the audible restart
// waits for the field to be left, so playback isn't interrupted on every keystroke.
el('filterWords').addEventListener('input', () => {
  customBadWords = el('filterWords').value.split(',').map(w => w.trim()).filter(Boolean);
  saveFilterSettings(); Player.cache.clear(); syncSettings();
  if(Player.chapters.length){ Reader.renderedCh = -1; Reader.highlight(); }
});
el('filterWords').addEventListener('change', () => Player.clearAudio());

// Pronunciation
loadPronunciationRules();
function renderPronunciationList(){
  const container = el('pronunciationGroup'); container.innerHTML = '';
  if(!pronunciationRules.length){ container.innerHTML = '<div class="row"><span class="sub">No rules yet</span></div>'; return; }
  pronunciationRules.forEach((rule, idx) => {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('span');
    label.textContent = '“' + rule.find + '” → ' + (rule.replace ? ('“' + rule.replace + '”') : 'skip') + (rule.matchCase ? ' · match case' : '');
    const btns = document.createElement('div'); btns.style.display = 'flex'; btns.style.gap = '8px'; btns.style.flexShrink = '0';
    const play = document.createElement('button'); play.className = 'preview-btn'; play.setAttribute('aria-label', 'Preview');
    play.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="8,5 8,19 19,12"/></svg>';
    play.addEventListener('click', async () => { play.disabled = true; try{ await Voice.preview(rule.replace || rule.find); } catch(e){ console.error(e); } play.disabled = false; });
    const del = document.createElement('button'); del.className = 'x'; del.textContent = '✕'; del.setAttribute('aria-label', 'Remove rule');
    del.addEventListener('click', () => { pronunciationRules.splice(idx, 1); savePronunciationRules(); renderPronunciationList(); Player.clearAudio(); syncSettings(); });
    btns.appendChild(play); btns.appendChild(del);
    row.appendChild(label); row.appendChild(btns); container.appendChild(row);
  });
}
el('pronRow').addEventListener('click', () => { renderPronunciationList(); openSheet('pronSheet'); });
el('pronPreviewBtn').addEventListener('click', async () => {
  const find = el('pronFindInput').value.trim(), replace = el('pronReplaceInput').value.trim();
  const b = el('pronPreviewBtn'); b.disabled = true;
  try{ await Voice.preview(replace || find); } catch(e){ console.error(e); }
  b.disabled = false;
});
el('pronAddBtn').addEventListener('click', () => {
  const find = el('pronFindInput').value.trim(); if(!find) return;
  pronunciationRules.push({ find, replace: el('pronReplaceInput').value.trim(), matchCase: el('pronMatchCase').checked });
  savePronunciationRules(); renderPronunciationList();
  el('pronFindInput').value = ''; el('pronReplaceInput').value = ''; el('pronMatchCase').checked = false;
  Player.clearAudio(); syncSettings();
});

// Voice engine
$$('#runSeg button').forEach(b => b.addEventListener('click', () => {
  Voice.setUseServer(b.dataset.v === 'server'); voiceListLoadedFor = null; syncSettings(); Player.clearAudio();
}));
el('engineSelect').addEventListener('change', () => {
  Voice.setEngine(el('engineSelect').value); voiceListLoadedFor = null; syncSettings(); Player.clearAudio();
});
el('serverRow').addEventListener('click', () => { el('serverUrlInput').value = Voice.settings.serverUrl; el('serverTestVal').textContent = ''; openSheet('serverSheet'); });
el('serverUrlInput').addEventListener('change', () => { Voice.setServerUrl(el('serverUrlInput').value); voiceListLoadedFor = null; Player.clearAudio(); syncSettings(); });
el('serverTestBtn').addEventListener('click', async () => {
  Voice.setServerUrl(el('serverUrlInput').value); Voice.forgetServer(); voiceListLoadedFor = null;
  el('serverTestVal').textContent = 'Connecting…';
  const voices = await Voice.listVoices();
  el('serverTestVal').textContent = voices.length ? voices.length + ' voices' : 'No answer';
  syncSettings();
});
el('connectClose').addEventListener('click', () => hideConnectToast(0));
el('connectRetry').addEventListener('click', () => { Voice.forgetServer(); voiceListLoadedFor = null; setEngineStatus(''); loadVoiceList(); });

// Storage
async function refreshStorageRows(){
  const est = await storageEstimate();
  el('storageVal').textContent = est && est.usage != null ? (est.usage / 1048576 < 1024 ? Math.round(est.usage / 1048576) + ' MB' : (est.usage / 1073741824).toFixed(1) + ' GB') : 'unknown';
  try{
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
    el('persistVal').textContent = persisted === null ? 'Not supported' : persisted ? 'Granted' : 'Tap to ask';
  } catch(e){ el('persistVal').textContent = 'Not supported'; }
}
el('persistRow').addEventListener('click', async () => {
  const ok = await requestPersistentStorage();
  el('persistVal').textContent = ok === null ? 'Not supported' : ok ? 'Granted' : 'Not granted';
});
el('clearAudioRow').addEventListener('click', () => { Player.cache.clear(); setEngineStatus('Prepared audio cleared.'); setTimeout(() => setEngineStatus(''), 1500); });

// Backup and restore (also how two of your own devices stay in step).
function backupFileName(){ const d = new Date(); return 'Lamplight backup ' + d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '.zip'; }
function showBackupDate(){
  const at = parseInt(settingGet('lastBackupAt', '0'), 10);
  el('backupVal').textContent = at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Never';
}
// Building the zip can take a while with a real library, and the share sheet only
// opens from a fresh tap. So the first tap packs the file and the next tap hands it
// over (a download needs no such care and happens at once).
let pendingBackup = null;
el('backupRow').addEventListener('click', async () => {
  const foot = el('backupFoot');
  const canShare = !!(navigator.canShare && navigator.share);
  try{
    if(!pendingBackup){
      foot.textContent = 'Packing your library…';
      const blob = await exportBackupBlob();
      pendingBackup = new File([blob], backupFileName(), { type: 'application/zip' });
      if(canShare && navigator.canShare({ files: [pendingBackup] })){
        el('backupVal').textContent = 'Tap to save';
        foot.textContent = 'Backup ready (' + Math.max(1, Math.round(blob.size / 1048576)) + ' MB). Tap again to save it to iCloud Drive, Google Drive or anywhere else.';
        return;
      }
    }
    const file = pendingBackup;
    if(canShare && navigator.canShare({ files: [file] })){
      try{ await navigator.share({ files: [file], title: 'Lamplight backup' }); }
      catch(err){
        if(err && err.name === 'AbortError'){ foot.textContent = 'Not saved. Tap again when you are ready.'; return; }
        throw err;
      }
    } else {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a'); link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    pendingBackup = null;
    settingSet('lastBackupAt', Date.now()); showBackupDate();
    foot.textContent = 'Saved ' + file.name + '. Keep it in iCloud Drive or Google Drive, then restore it on your other device.';
  } catch(err){
    console.error(err);
    pendingBackup = null; showBackupDate();
    foot.textContent = 'Could not make the backup: ' + (err && err.message ? err.message : err);
  }
});
el('restoreRow').addEventListener('click', () => el('restoreInput').click());
el('restoreInput').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if(!file) return;
  const foot = el('backupFoot');
  foot.textContent = 'Restoring…';
  try{
    const result = await importBackup(file);
    loadFilterSettings(); loadPronunciationRules(); Library.shelves = loadShelves();
    el('filterWords').value = customBadWords.join(', ');
    Player.clearAudio(); // clips prepared under the old rules and filter words are stale now
    if(Player.chapters.length){ Reader.renderedCh = -1; Reader.highlight(); }
    await Library.refresh(); syncSettings();
    // If the open book's place moved forward on the other device, go there now.
    if(Reader.book && Player.state === 'idle'){
      const pos = result.newerPositions[Reader.book.progressKey];
      if(pos) Player.seek(pos.chapter, pos.sentence);
    }
    foot.textContent = 'Restored: ' + result.booksAdded + ' book' + (result.booksAdded === 1 ? '' : 's') + ' added, ' + result.booksUpdated + ' merged, ' + result.positionsUpdated + ' reading position' + (result.positionsUpdated === 1 ? '' : 's') + ' moved forward.';
  } catch(err){
    console.error(err);
    foot.textContent = 'Could not restore: ' + (err && err.message ? err.message : err);
  }
});
showBackupDate();

// ---------------- Open in Lamplight: share sheet, file handler, offline shell ----------------
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered:', err)); }
// Installed app opened with a file (desktop and Android browsers that support file handlers).
if('launchQueue' in window && window.launchQueue.setConsumer){
  window.launchQueue.setConsumer(async params => {
    for(const handle of (params.files || [])){
      try{ handleFile(await handle.getFile()); } catch(err){ console.warn('Could not open the launched file:', err); }
    }
  });
}
// A book shared to the installed app: the service worker parked it in a cache.
async function openSharedFile(){
  if(!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try{
    const cache = await caches.open('lamplight-shared');
    const res = await cache.match('shared-file');
    if(!res) return;
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'book.epub');
    const blob = await res.blob();
    await cache.delete('shared-file');
    handleFile(new File([blob], name, { type: blob.type }));
  } catch(err){ console.warn('Could not open the shared file:', err); }
}

// Status text from the voice layer, shown wherever the person might be looking.
Voice.onStatus(text => {
  el('engineStatus').textContent = text;
  el('engineStatusSettings').textContent = text;
  el('voiceSheetStatus').textContent = text;
  if(el('engineSelect').value !== Voice.settings.engine) syncSettings(); // Safari fallback switched engines
});

// ---------------- Boot ----------------
syncSettings();
Library.refresh().then(() => {
  openSharedFile();
  Folder.init();
  // Warm up the voice in the background so the first Play doesn't wait on it.
  if(Voice.settings.useServer || Voice.settings.engine === 'piper') Voice.ensureReady().then(() => Reader.updateChips()).catch(() => {});
  requestPersistentStorage();
});
