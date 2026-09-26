// Lamplight — book parsing. Turns an EPUB or PDF into chapters of sentences, and
// reads the cover and metadata an EPUB carries. Nothing here touches the page.
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---------------- Shared: build a chapter from an ordered list of paragraph strings ----------------
function buildChapterFromParagraphTexts(title, paraTexts){
  const sentences = [];
  const sentenceParagraph = [];
  const paragraphs = [];
  paraTexts.forEach(pText => {
    const sents = splitSentences(pText);
    if(!sents.length) return;
    const startIdx = sentences.length;
    sents.forEach(s => { sentences.push(s); sentenceParagraph.push(paragraphs.length); });
    paragraphs.push({ sentenceIndices: sents.map((_, k) => startIdx + k) });
  });
  if(!sentences.length) return null;
  return { title, sentences, sentenceParagraph, paragraphs };
}

// ---------------- EPUB parsing ----------------
// Resolves a possibly-relative href against a base directory the same way a browser
// resolves relative URLs (handling "./", "../", etc.), without ever hitting the network —
// the "file:///" scheme just gives URL something absolute to resolve against.
function resolveEpubPath(baseDir, href){
  const clean = href.split('#')[0];
  try{
    const resolved = new URL(clean, 'file:///' + baseDir).pathname;
    return decodeURIComponent(resolved.replace(/^\//, ''));
  } catch(e){
    return (baseDir + clean).replace(/\/\.\//g, '/');
  }
}

// Real chapter titles live in the EPUB's own navigation document — nav.xhtml (EPUB3)
// or toc.ncx (EPUB2) — not in each content file's own <title>/<h1>. (Per-file <title>
// tags are frequently just the book's own title repeated in every single file, which
// is why using them was producing an identical "chapter title" over and over.)
// Returns a Map from resolved-file-path -> chapter title, keyed by the first spine
// file that title's TOC entry points to.
async function loadEpubTocMap(zip, opfDoc, opfDir, manifest){
  const tocMap = new Map();

  const navItem = Array.from(opfDoc.querySelectorAll('manifest > item'))
    .find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  const ncxId = opfDoc.querySelector('spine')?.getAttribute('toc');
  const ncxHref = ncxId ? manifest[ncxId] : Object.values(manifest).find(h => /\.ncx$/i.test(h));

  async function readZipEntry(path){
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    return f ? await f.async('string') : null;
  }

  if(navItem){
    const navHref = navItem.getAttribute('href');
    const navDir = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/')+1) : '';
    const navFullDir = opfDir + navDir;
    const xml = await readZipEntry(opfDir + navHref);
    if(xml){
      const navDoc = new DOMParser().parseFromString(xml, 'text/html'); // lenient parser handles epub:type fine
      const tocNav = Array.from(navDoc.querySelectorAll('nav')).find(n => {
        const t = (n.getAttribute('epub:type') || n.getAttribute('type') || '').toLowerCase();
        return t.includes('toc');
      }) || navDoc.querySelector('nav');
      if(tocNav){
        tocNav.querySelectorAll('a[href]').forEach(a => {
          const text = a.textContent.replace(/\s+/g, ' ').trim();
          if(!text) return;
          const resolved = resolveEpubPath(navFullDir, a.getAttribute('href'));
          if(!tocMap.has(resolved)) tocMap.set(resolved, text);
        });
      }
    }
  }
  if(!tocMap.size && ncxHref){
    const ncxDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/')+1) : '';
    const ncxFullDir = opfDir + ncxDir;
    const xml = await readZipEntry(opfDir + ncxHref);
    if(xml){
      const ncxDoc = new DOMParser().parseFromString(xml, 'application/xml');
      ncxDoc.querySelectorAll('navPoint').forEach(np => {
        const text = (np.querySelector('navLabel > text') || {}).textContent;
        const src = (np.querySelector('content') || {}).getAttribute?.('src');
        if(!text || !src) return;
        const resolved = resolveEpubPath(ncxFullDir, src);
        if(!tocMap.has(resolved)) tocMap.set(resolved, text.replace(/\s+/g, ' ').trim());
      });
    }
  }
  return tocMap;
}

async function parseEpub(buf){
  const zip = await JSZip.loadAsync(buf);
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';
  const opfXml = await zip.file(opfPath).async('string');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item => {
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  });
  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(i => i.getAttribute('idref'));
  const tocMap = await loadEpubTocMap(zip, opfDoc, opfDir, manifest);

  // Chapters are grouped by TOC entry, not by spine file — many real EPUBs split one
  // logical chapter across several physical files (e.g. "chNN_split_001.html",
  // "chNN_split_002.html"), which used to each show up as their own separate,
  // identically-titled "chapter". A spine file with no TOC entry of its own is a
  // continuation of whichever chapter came before it.
  const groups = [];

  for(const id of spineIds){
    const href = manifest[id];
    if(!href) continue;
    const path = opfDir + href;
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    if(!f) continue;
    const html = await f.async('string');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style').forEach(n => n.remove());
    if(!doc.body) continue;

    // <br> carries no text of its own, so without this two lines joined by a <br>
    // would get glued together into one word once we read textContent below.
    doc.querySelectorAll('br').forEach(br => br.replaceWith(' '));

    // Drop elements explicitly hidden in the markup (some EPUBs hide duplicate/
    // accessibility-only text this way) so it doesn't get read aloud.
    doc.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(n => n.remove());
    doc.querySelectorAll('[style]').forEach(n => {
      if(/display\s*:\s*none/i.test(n.getAttribute('style') || '')) n.remove();
    });

    // Some EPUBs mark paragraphs with <p>, others just use <div>. Match both, but
    // keep only the innermost ("leaf") matches so a wrapper <div> around several
    // <p> tags doesn't get counted as its own paragraph on top of its children.
    const blockSelector = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, div';
    let blocks = Array.from(doc.body.querySelectorAll(blockSelector));
    blocks = blocks.filter(b => !b.querySelector(blockSelector));

    // textContent (unlike innerText) doesn't depend on the page actually being
    // rendered/laid out — this document never gets attached to the page, and
    // innerText silently returns empty text for detached nodes in some browsers.
    let paraTexts = blocks.map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(t => t.length > 0);
    if(!paraTexts.length){
      const rawWithBreaks = doc.body.textContent; // keep original newlines for a rough paragraph split
      paraTexts = rawWithBreaks.split(/\n\s*\n+/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if(!paraTexts.length){
        const raw = rawWithBreaks.replace(/\s+/g, ' ').trim();
        paraTexts = raw.length ? [raw] : [];
      }
    }
    if(!paraTexts.length) continue;

    const tocTitle = tocMap.get(path);
    if(tocTitle){
      // A real TOC entry always starts a fresh chapter, even if (rarely) its title
      // text happens to repeat an earlier one.
      groups.push({ title: tocTitle, paraTexts: [] });
    } else if(!groups.length){
      // No TOC entry has matched yet at all — front matter (cover, title page, etc.)
      // ahead of the book's first real TOC-listed chapter. Prefer an actual heading
      // in the body over the document's <title> (which is often just the book's own
      // title repeated in every file, not this file's own heading).
      const heading = (doc.body.querySelector('h1,h2,h3') || {}).textContent;
      groups.push({ title: (heading || '').trim() || 'Front Matter', paraTexts: [] });
    }
    // else: continuation file of whichever TOC chapter is currently open — falls
    // through and gets appended to it below, with no new chapter created.
    groups[groups.length - 1].paraTexts.push(...paraTexts);
  }

  const result = [];
  groups.forEach(g => {
    const chapterObj = buildChapterFromParagraphTexts(g.title, g.paraTexts);
    if(chapterObj) result.push(chapterObj);
  });
  return result;
}

// ---------------- PDF parsing ----------------
// Groups a page's text items into lines by vertical position, then splits those
// lines into paragraphs wherever the gap between lines is noticeably bigger than
// the page's own typical line spacing.
async function extractPdfPageParagraphs(page){
  const content = await page.getTextContent();
  const items = content.items;

  const lines = [];
  let curLine = null;
  items.forEach(it => {
    const y = Math.round(it.transform[5]);
    if(curLine && Math.abs(y - curLine.y) <= 2){
      curLine.text += it.str;
    } else {
      curLine = { y, text: it.str };
      lines.push(curLine);
    }
  });

  const gaps = [];
  for(let k=1;k<lines.length;k++) gaps.push(Math.abs(lines[k-1].y - lines[k].y));
  const sortedGaps = gaps.slice().sort((a,b)=>a-b);
  const median = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length/2)] : 14;

  const paras = [];
  let paraLines = [];
  lines.forEach((ln, idx) => {
    if(idx > 0){
      const gap = Math.abs(lines[idx-1].y - ln.y);
      if(gap > median * 1.6 && paraLines.length){
        paras.push(paraLines.join(' '));
        paraLines = [];
      }
    }
    if(ln.text.trim()) paraLines.push(ln.text.trim());
  });
  if(paraLines.length) paras.push(paraLines.join(' '));
  return paras;
}

// Resolves an outline entry's destination to a 1-indexed page number. `dest` is
// either an explicit destination array already, or a named destination string that
// has to be looked up first — either way it ultimately points at a page reference.
async function resolvePdfOutlineDest(pdf, dest){
  try{
    let d = dest;
    if(typeof d === 'string') d = await pdf.getDestination(d);
    if(!d || !d[0]) return null;
    const pageIndex = await pdf.getPageIndex(d[0]);
    return pageIndex + 1;
  } catch(e){ return null; }
}

async function parsePdf(buf){
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;
  const result = [];

  // Real chapter titles and boundaries live in the PDF's own outline/bookmarks when
  // the publisher included one (most converted ebooks do) — far more useful than an
  // arbitrary page count, and gives real chapter names instead of "Pages 9–16". Only
  // top-level entries are used, not nested sub-headings, so this stays at chapter
  // granularity rather than every subsection.
  let plannedChapters = null;
  try{
    let outline = await pdf.getOutline();
    // Some PDFs wrap their entire outline under a single root bookmark named after
    // the book itself, with the real chapter-level entries one level down as its
    // children — unwrap that (repeatedly, in case of more than one such wrapper)
    // rather than treating that lone root as the only "chapter".
    while(outline && outline.length === 1 && outline[0].items && outline[0].items.length){
      outline = outline[0].items;
    }
    if(outline && outline.length){
      const resolved = [];
      for(const item of outline){
        if(!item.dest) continue;
        const page = await resolvePdfOutlineDest(pdf, item.dest);
        const title = (item.title || '').replace(/\s+/g, ' ').trim();
        if(page && title) resolved.push({ title, page });
      }
      resolved.sort((a,b) => a.page - b.page);
      // Some PDFs point several outline entries at the exact same page (e.g. a
      // cover/title page listed twice) — keep only the first for any given page.
      const deduped = resolved.filter((r,i) => i === 0 || r.page !== resolved[i-1].page);
      if(deduped.length){
        plannedChapters = deduped.map((r,i) => ({
          title: r.title,
          startPage: r.page,
          endPage: (i+1 < deduped.length) ? deduped[i+1].page - 1 : pdf.numPages,
        }));
        // Anything before the first bookmark (unlisted front matter) still gets read —
        // just not silently dropped — rather than assuming it's always skippable.
        if(plannedChapters[0].startPage > 1){
          plannedChapters.unshift({ title: 'Front Matter', startPage: 1, endPage: plannedChapters[0].startPage - 1 });
        }
      }
    }
  } catch(e){ console.warn('PDF outline unavailable, falling back to page buckets:', e); }

  if(plannedChapters){
    for(const ch of plannedChapters){
      const paras = [];
      for(let i = ch.startPage; i <= ch.endPage; i++){
        const page = await pdf.getPage(i);
        paras.push(...(await extractPdfPageParagraphs(page)));
      }
      const chapterObj = buildChapterFromParagraphTexts(ch.title, paras);
      if(chapterObj) result.push(chapterObj);
    }
    return result;
  }

  // Fallback for PDFs with no usable outline: bucket every few pages together.
  const PAGES_PER_CHAPTER = 8;
  let bucketParas = [];
  let bucketStart = 1;
  for(let i=1; i<=pdf.numPages; i++){
    const page = await pdf.getPage(i);
    bucketParas.push(...(await extractPdfPageParagraphs(page)));
    if(i % PAGES_PER_CHAPTER === 0 || i === pdf.numPages){
      const label = bucketStart === i ? ('Page ' + i) : ('Pages ' + bucketStart + '–' + i);
      const chapterObj = buildChapterFromParagraphTexts(label, bucketParas);
      if(chapterObj) result.push(chapterObj);
      bucketParas = [];
      bucketStart = i+1;
    }
  }
  return result;
}


// ---------------- EPUB metadata: title, author, subjects, cover ----------------
// Read separately from parseEpub so the parser above stays as it was. Returns
// whatever it can find; every field is optional.
async function readEpubMeta(buf){
  const meta = { title: '', author: '', subjects: [], cover: null };
  try{
    const zip = await JSZip.loadAsync(buf);
    const containerXml = await zip.file('META-INF/container.xml').async('string');
    const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';
    const opfDoc = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
    const text = sel => { const n = opfDoc.getElementsByTagNameNS('*', sel)[0]; return n ? n.textContent.replace(/\s+/g, ' ').trim() : ''; };
    meta.title = text('title');
    meta.author = text('creator');
    meta.subjects = Array.from(opfDoc.getElementsByTagNameNS('*', 'subject')).map(n => n.textContent.trim()).filter(Boolean);

    // The cover is either the manifest item marked properties="cover-image" (EPUB 3)
    // or the item named by <meta name="cover" content="id"> (EPUB 2).
    const items = Array.from(opfDoc.querySelectorAll('manifest > item'));
    let coverItem = items.find(i => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
    if(!coverItem){
      const coverMeta = Array.from(opfDoc.querySelectorAll('metadata > meta')).find(m => (m.getAttribute('name') || '').toLowerCase() === 'cover');
      const coverId = coverMeta && coverMeta.getAttribute('content');
      if(coverId) coverItem = items.find(i => i.getAttribute('id') === coverId);
    }
    if(!coverItem) coverItem = items.find(i => /image\//.test(i.getAttribute('media-type') || '') && /cover/i.test(i.getAttribute('href') || ''));
    if(coverItem){
      const path = resolveEpubPath(opfDir, coverItem.getAttribute('href'));
      const f = zip.file(path) || zip.file(decodeURIComponent(path));
      if(f){
        const bytes = await f.async('uint8array');
        if(bytes.length < 4 * 1024 * 1024) meta.cover = new Blob([bytes], { type: coverItem.getAttribute('media-type') || 'image/jpeg' });
      }
    }
  } catch(err){ console.warn('EPUB metadata unavailable:', err); }
  return meta;
}
