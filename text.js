// Lamplight — text processing. Sentence splitting, the language filter, the
// pronunciation dictionary, and the small rewrites that make a voice read more
// naturally. Pure functions plus the three settings they read.
let filterEnabled = true;
let customBadWords = [];
let pronunciationRules = []; // [{find, replace, matchCase}] — applied to speech only

// ---------------- Sentence splitting ----------------
// Small TTS models like Kokoro can clip the end of very long inputs (their duration
// prediction isn't reliable that far out), so beyond MAX_TTS_CHARS we further split
// at natural pause points — this affects TTS/highlight granularity only, not meaning.
const MAX_TTS_CHARS = 200;

function splitOnPunct(text, punct){
  const re = new RegExp('[^' + punct + ']+' + punct + '+(?:\\s+|$)|[^' + punct + ']+$', 'g');
  const m = text.match(re);
  if(!m || m.length < 2) return [text];
  return m.map(s => s.trim()).filter(Boolean);
}

function hardWrap(text, maxChars){
  const words = text.split(' ');
  const out = [];
  let cur = '';
  words.forEach(w => {
    if(cur && (cur.length + 1 + w.length) > maxChars){
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  });
  if(cur) out.push(cur);
  return out;
}

function splitLongClause(text, maxChars){
  if(text.length <= maxChars) return [text];
  let parts = splitOnPunct(text, ';');
  if(parts.length === 1) parts = splitOnPunct(text, ',');
  if(parts.length === 1) return hardWrap(text, maxChars);
  const out = [];
  parts.forEach(p => out.push(...splitLongClause(p.trim(), maxChars)));
  return out;
}

// Protects common abbreviations and initials (Mr. Mrs. Dr. St. — and things like "C. S. Lewis")
// from being mistaken for sentence endings, by temporarily hiding their periods.
const ABBR_RE = /\b(Mr|Mrs|Ms|Dr|St|Mt|Prof|Rev|Gen|Col|Capt|Lt|Sgt|Sr|Jr|vs|etc|Ph\.D|i\.e|e\.g)\./g;
const INITIAL_RE = /\b([A-Z])\.(?=\s*[A-Z]\.|\s+[A-Z]\b)/g;
function protectAbbreviations(text){
  return text.replace(ABBR_RE, (m, word) => word + '\u0001')
             .replace(INITIAL_RE, (m, letter) => letter + '\u0001');
}
function restoreAbbreviations(text){
  return text.replace(/\u0001/g, '.');
}

// A sentence terminator is very often followed immediately by a closing quote or
// bracket with no space ("...that means." with no gap before the closing quote) —
// without allowing for that, the regex below fails to match at all and silently
// drops the whole sentence.
const SENT_RE = /[^.!?]+[.!?]+[)\]'"\u2019\u201D]*(?:\s+|$)|[^.!?]+$/g;

// Common verbs used in dialogue attribution tags ("...," said Peter / "...?" asked Susan).
const DIALOGUE_TAG_VERBS = 'said|asked|replied|answered|cried|shouted|whispered|muttered|exclaimed|continued|added|began|called|retorted|murmured|sighed|snapped|gasped|sobbed|roared|growled|chuckled|laughed|wondered|declared|announced|remarked|grumbled|protested|went on';

// A quoted question or exclamation immediately followed by its attribution tag
// ("Are you coming?" asked Peter.) is one continuous thought, not two sentences —
// but SENT_RE would otherwise treat the ?/! as a hard sentence break, giving it
// its own separate TTS chunk with an audible gap before "asked Peter." Hide the
// punctuation here (same trick as protectAbbreviations) so it stays one chunk;
// the real ? or ! is restored below, so its intonation still comes through.
const DIALOGUE_END_RE = new RegExp('([?!])([\'"\u2019\u201D]+)(\\s+)(?=(?:\\w+\\s+)?(?:' + DIALOGUE_TAG_VERBS + ')\\b)', 'gi');
function protectDialogueEndings(text){
  return text.replace(DIALOGUE_END_RE, (m, punct, quote, space) => (punct === '?' ? '\u0002' : '\u0003') + quote + space);
}
function restoreDialogueEndings(text){
  return text.replace(/\u0002/g, '?').replace(/\u0003/g, '!');
}

// A sentence ending in terminal punctuation immediately followed by a closing quote
// mark, with nothing else after it, means quoted dialogue is finishing here with no
// attribution tag trailing it — a natural "end of the exchange" moment where a
// narrator would actually take a slightly longer beat before continuing. Cases where
// a tag *does* follow right away ("...?" asked Peter.) were already merged into one
// sentence by protectDialogueEndings above, so they never reach this check — only
// genuine ends of a line of dialogue match.
const QUOTED_SENTENCE_END_RE = /[.!?][)\]'"\u2019\u201D]+\s*$/;
function endsQuotedDialogue(text){
  return QUOTED_SENTENCE_END_RE.test((text || '').trim());
}
const DIALOGUE_END_PAUSE_MS = 220; // extra pause after quoted dialogue ends, on top of the normal between-sentence gap

function splitSentences(text){
  const cleaned = protectDialogueEndings(protectAbbreviations(text.replace(/\s+/g, ' ').trim()));
  if(!cleaned) return [];
  const matches = cleaned.match(SENT_RE) || [cleaned];
  const rough = matches.map(s => restoreDialogueEndings(restoreAbbreviations(s.trim()))).filter(s => s.length > 1);
  const out = [];
  rough.forEach(s => out.push(...splitLongClause(s, MAX_TTS_CHARS)));
  return out;
}

// ---------------- Language filter ----------------
const DEFAULT_BAD_WORDS = ['fuck','shit','bitch','bastard','asshole','cunt','slut','whore','dick','cock','pussy','twat','douche','goddamn','bullshit'];

function loadFilterSettings(){
  try{
    const raw = localStorage.getItem('lamplight:filterSettings');
    if(raw){
      const obj = JSON.parse(raw);
      filterEnabled = !!obj.enabled;
      customBadWords = Array.isArray(obj.custom) ? obj.custom : [];
    }
  } catch(e){ /* ignore */ }
}
function saveFilterSettings(){
  try{
    localStorage.setItem('lamplight:filterSettings', JSON.stringify({enabled: filterEnabled, custom: customBadWords}));
  } catch(e){ /* ignore */ }
}

function badWordsRegex(){
  const words = [...DEFAULT_BAD_WORDS, ...customBadWords].map(w => w.trim()).filter(Boolean);
  if(!words.length) return null;
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + escaped.join('|') + ')\\w*', 'gi');
}

function displayFilteredText(text){
  if(!filterEnabled) return text;
  const re = badWordsRegex();
  if(!re) return text;
  return text.replace(re, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
}

// Em dashes and opening parentheses read naturally with a short breath-pause,
// but VITS/Kokoro/system voices don't treat those marks as pause cues on their
// own — they either glide straight through or (for open-paren) go silent for a
// beat. Swapping in a comma gives the model a pause cue it already knows how to
// render, without being as long as a full sentence break. Speech only — the
// on-screen text is untouched.
function insertNaturalPauses(text){
  return text.replace(/\s*—\s*/g, ', ').replace(/\(/g, ', ');
}

// A title like "Mr." or "Dr." keeps its period once restored from the sentence-
// splitting stage, and a voice model has no way to tell that period apart from a
// real sentence break — it reads the same length pause either way. Expanding to
// the full spoken word removes the period entirely, so there's nothing left to
// misread as a stop. Limited to titles with one unambiguous spoken form (skips
// "St."/"Mt." — Saint or Street, Mount — and "vs."/"etc.", which read fine as-is).
const TITLE_EXPANSIONS = {
  Mr: 'Mister', Mrs: 'Missus', Dr: 'Doctor', Prof: 'Professor',
  Gen: 'General', Col: 'Colonel', Capt: 'Captain', Lt: 'Lieutenant',
  Sgt: 'Sergeant', Rev: 'Reverend', Sr: 'Senior', Jr: 'Junior'
};
const TITLE_RE = new RegExp('\\b(' + Object.keys(TITLE_EXPANSIONS).join('|') + ')\\.', 'g');
function expandSpokenTitles(text){
  return text.replace(TITLE_RE, (m, word) => TITLE_EXPANSIONS[word]);
}

function speechFilteredText(text){
  let out = applyPronunciationRules(text);
  out = expandSpokenTitles(out);
  if(filterEnabled){
    const re = badWordsRegex();
    if(re) out = out.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  }
  out = insertNaturalPauses(out);
  return smoothDialogueTags(out);
}

// ---------------- Pronunciation dictionary ----------------
// Lets the person fix names/words the voice mispronounces — matches the "as
// written" text anywhere it appears and swaps in the "say instead" text, for
// speech only. Blank "say instead" means skip that word/phrase entirely.
function loadPronunciationRules(){
  try{
    const raw = localStorage.getItem('lamplight:pronunciationRules');
    pronunciationRules = raw ? (JSON.parse(raw) || []) : [];
  } catch(e){ pronunciationRules = []; }
}
function savePronunciationRules(){
  try{ localStorage.setItem('lamplight:pronunciationRules', JSON.stringify(pronunciationRules)); } catch(e){ /* ignore */ }
}
function applyPronunciationRules(text){
  if(!pronunciationRules.length) return text;
  let out = text;
  pronunciationRules.forEach(rule => {
    if(!rule || !rule.find) return;
    const escaped = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, rule.matchCase ? 'g' : 'gi');
    out = out.replace(re, rule.replace || '');
  });
  return out.replace(/\s{2,}/g, ' ').trim();
}



// A comma right before a closing quote and a speech-tag verb ("...won't," said Peter.)
// is just grammatical glue, not a place anyone would actually pause when speaking —
// but TTS models read it as an ordinary comma pause. Strip it for speech only; the
// displayed text keeps its normal, correctly-punctuated form.
const DIALOGUE_COMMA_RE = new RegExp(',(\\s*[\'"\u2019\u201D]+)(\\s+)(?=(?:\\w+\\s+)?(?:' + DIALOGUE_TAG_VERBS + ')\\b)', 'gi');
function smoothDialogueTags(text){
  return text.replace(DIALOGUE_COMMA_RE, '$1$2');
}
