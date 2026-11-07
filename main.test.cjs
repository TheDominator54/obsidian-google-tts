const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const path = require('node:path');
const notices = [];
class MockFolder {}
const sandbox = { module: { exports: {} }, Buffer, Intl, process,
  require: name => name === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {}, TFolder: MockFolder, Notice: class { constructor(message) { notices.push(message); } } } : require(name) };
vm.runInNewContext(require('node:fs').readFileSync(path.join(__dirname, 'main.js'), 'utf8'), sandbox);
const Plugin = sandbox.module.exports;
const { splitText, speechText, wavDuration } = Plugin;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('Timed out'); }
function wav(seconds = 10) {
  const bytes = Buffer.alloc(44 + seconds * 48000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
function plugin() {
  const p = new Plugin(); p.settings = { language: 'en-US', model: 'gemini-2.5-flash-tts' }; p.generation = 0; p.children = new Set();
  for (const name of ['generateButton', 'pauseButton', 'stopButton', 'rewindButton', 'forwardButton', 'label']) p[name] = { setText() {} };
  p.setControlIcon = () => {};
  p.setStatus = text => { p.statusText = text; };
  return p;
}
test('Markdown becomes spoken text while headings, emphasis, and link labels survive', () => {
  const note = '---\ntitle: hidden\n---\n## A subtitle ##\n\n**Bold** and _italic_ with [[Note|a friend]] and [a link](https://example.com/x(y)).\n- [x] Done\n> [!note] Remember\n> Keep this.\n%%hidden%%\n```js\nsecret();\n```';
  const text = speechText(note);
  assert.match(text, /A subtitle/); assert.match(text, /Bold and italic with a friend and a link\./);
  assert.match(text, /Done/); assert.match(text, /Remember/); assert.match(text, /Keep this\./);
  assert.doesNotMatch(text, /hidden|secret|https|##|\*\*|\[!|\[x\]/);
  assert.equal(speechText('| Name | Value |\n| --- | --- |\n| Dom | One |'), 'Name, Value\n\nDom, One');
  assert.equal(speechText('***\n<!-- hidden -->\n'), '');
});
test('startup chunks are sentences; later chunks preserve every sentence and Unicode', () => {
  const text = 'First short sentence. Second short sentence! ' + 'Olá, esta é uma frase completa. '.repeat(80);
  const chunks = Array.from(splitText(text));
  assert.equal(chunks[0], 'First short sentence.'); assert.equal(chunks[1], 'Second short sentence!');
  assert.equal(chunks.join(' '), text.trim());
  assert.ok(chunks.slice(2).every(chunk => Buffer.byteLength(chunk) <= 900 && /[.!?]$/.test(chunk)));
  assert.deepEqual(Array.from(splitText('Value 3.14 stays together. Next sentence.')), ['Value 3.14 stays together.', 'Next sentence.']);
  assert.equal(splitText('a'.repeat(1000) + '.')[0].length, 1001);
  assert.throws(() => splitText('é'.repeat(2001) + '.'), /4,000/);
});
test('WAV duration is decoded from the header and invalid files fail', () => {
  assert.equal(wavDuration(wav(12)), 12); assert.throws(() => wavDuration(Buffer.alloc(44)), /invalid/);
  assert.throws(() => wavDuration(wav().subarray(0, 50)), /truncated/);
});
test('all synthesis starts before first playback; out-of-order completion plays in order; seek crosses chunks', async () => {
  const p = plugin(), requests = [], played = [];
  p.synthesize = (input, output, settings) => new Promise(resolve => {
    requests.push({ input, output, settings, finish: async () => { await fs.writeFile(output, wav()); resolve(); } });
  });
  p.play = (bytes, position, offset, paused) => new Promise(resolve => {
    played.push({ position, offset, paused });
    p.audio = { currentTime: offset, paused };
    p.finishAudio = () => { p.audio = null; p.finishAudio = null; resolve(); };
  });
  const reading = p.speak('# Heading\n\nFirst sentence. Second sentence. ' + 'Longer prose for the buffered passage. '.repeat(40));
  await until(() => requests.length >= 4);
  assert.equal(played.length, 0);
  assert.ok(requests.every(r => r.settings.model === 'gemini-2.5-flash-tts'));
  await Promise.all(requests.slice(1).map(r => r.finish()));
  assert.equal(played.length, 0);
  await requests[0].finish(); await until(() => played.length === 1);
  assert.equal(played[0].position, '1/' + requests.length);
  p.audio.currentTime = 2; await p.seek(15); await until(() => played.length === 2);
  assert.equal(played[1].position, '2/' + requests.length); assert.equal(played[1].offset, 7);
  p.audio.paused = true; await p.seek(-10); await until(() => played.length === 3);
  assert.equal(played[2].position, '1/' + requests.length); assert.equal(played[2].offset, 7); assert.equal(played[2].paused, true);
  p.stop(); await reading;
  assert.equal(p.playback, null); assert.equal(p.forwardButton.disabled, true);
  await assert.rejects(fs.access(path.dirname(requests[0].input)));
});
test('stop cancels every active synthesis and removes temporary files', async () => {
  const p = plugin(), requests = [];
  p.synthesize = (input, output, settings, children) => new Promise((resolve, reject) => {
    const child = { kill() { children.delete(child); p.children.delete(child); reject(new Error('Cancelled')); } };
    children.add(child); p.children.add(child); requests.push(input);
  });
  const reading = p.speak('First. Second. Third.');
  await until(() => requests.length === 3); p.stop(); await reading;
  assert.equal(p.children.size, 0);
  await assert.rejects(fs.access(path.dirname(requests[0])));
  assert.equal(p.statusText, 'Ready');
});

const { audioFolder, passageInsertion } = Plugin;
test('folder paths stay inside the vault and embeds preserve frontmatter and selected prose', () => {
  assert.equal(audioFolder('Articles/Audio'), 'Articles/Audio');
  assert.equal(audioFolder(''), '');
  for (const folder of ['../outside', '/tmp/outside', '.obsidian/audio', 'Audio/../Other', 'bad|link']) assert.throws(() => audioFolder(folder));
  const note = '---\ntitle: My article\n---\n# Article\nBody.';
  const insertion = passageInsertion(note, null, '![[Audio/article.mp3]]');
  assert.equal(note.slice(0, insertion.offset) + insertion.text + note.slice(insertion.offset), '---\ntitle: My article\n---\n![[Audio/article.mp3]]\n\n# Article\nBody.');
  assert.equal(passageInsertion('Before. Selected.', 8, '![[audio.mp3]]').text, '\n\n![[audio.mp3]]\n\n');
});

function exportFixture(selection = '') {
  const p = plugin();
  p.exportButton = {};
  p.settings.audioFolder = '';
  p.settings.ffmpeg = '/opt/homebrew/bin/ffmpeg';
  const file = { path: 'Article.md', basename: 'Article' };
  let note = '---\ntitle: Article\n---\n# Article\n\nFirst sentence. Second sentence.';
  const saved = [], sent = [];
  const editor = {
    getValue: () => note,
    getSelection: () => selection,
    getCursor: () => ({ offset: note.indexOf(selection) }),
    posToOffset: pos => pos.offset,
    offsetToPos: offset => ({ offset }),
    replaceRange: (text, pos) => { note = note.slice(0, pos.offset) + text + note.slice(pos.offset); }
  };
  const view = { file, editor };
  p.app = { workspace: { getActiveViewOfType: () => view }, vault: {
    createBinary: async (name, bytes) => { saved.push({ name, bytes: Buffer.from(bytes) }); return { path: name }; },
    process: async (target, fn) => { assert.equal(target, file); note = fn(note); }
  } };
  p.synthesize = async (input, output) => {
    sent[Number(path.basename(input).match(/text-(\d+)/)[1])] = await fs.readFile(input, 'utf8');
    const bytes = wav(1);
    for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(Math.round(6000 * Math.sin((i - 44) / 2 * 2 * Math.PI * 220 / 24000)), i);
    await fs.writeFile(output, bytes);
  };
  return { p, file, saved, sent, note: () => note, change: text => { note = text; } };
}

test('article export joins every ordered chunk into one real decodable MP3 and attaches below frontmatter', async () => {
  const f = exportFixture();
  await f.p.generateArticleAudio();
  assert.equal(f.saved.length, 1);
  assert.match(f.saved[0].name, /^Article - audio .*\.mp3$/);
  assert.equal(f.sent.join(' '), 'Article First sentence. Second sentence.');
  assert.match(f.note(), /^---\ntitle: Article\n---\n!\[\[Article - audio .*\.mp3\]\]\n\n# Article/);
  const directory = await fs.mkdtemp(path.join(require('os').tmpdir(), 'test-article-export-'));
  try {
    const output = path.join(directory, 'audio.mp3'); await fs.writeFile(output, f.saved[0].bytes);
    const { execFileSync } = require('child_process');
    const probe = JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    assert.equal(probe.streams[0].codec_name, 'mp3');
    assert.equal(probe.streams[0].sample_rate, '24000');
    assert.ok(Math.abs(Number(probe.format.duration) - f.sent.length) < 0.2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  assert.equal(f.p.exporting, false); assert.equal(f.p.exportButton.disabled, false);
});

test('selected passage is exported and attached at the original selection', async () => {
  const f = exportFixture('Second sentence.');
  await f.p.generateArticleAudio();
  assert.deepEqual(f.sent, ['Second sentence.']);
  assert.equal(f.saved.length, 1);
  assert.match(f.note(), /First sentence\. \n\n!\[\[.*\.mp3\]\]\n\nSecond sentence\.$/);
});

test('changes made during export preserve the current text and retain saved audio', async () => {
  const f = exportFixture();
  const synthesize = f.p.synthesize;
  f.p.synthesize = async (...args) => { await synthesize(...args); f.change('Edited while generating.'); };
  await f.p.generateArticleAudio();
  assert.equal(f.saved.length, 1); assert.equal(f.note(), 'Edited while generating.');
  assert.match(notices.at(-1), /passage changed/);
});

test('failed synthesis saves no partial MP3 and never changes the passage', async () => {
  const f = exportFixture(), original = f.note();
  f.p.synthesize = async () => { throw new Error('Quota reached'); };
  await f.p.generateArticleAudio();
  assert.equal(f.saved.length, 0); assert.equal(f.note(), original);
  assert.match(notices.at(-1), /Quota reached/);
});

test('missing encoder fails before any synthesis request', async () => {
  const f = exportFixture(); f.p.settings.ffmpeg = '/nonexistent/ffmpeg';
  await f.p.generateArticleAudio();
  assert.equal(f.sent.length, 0); assert.equal(f.saved.length, 0);
  assert.match(notices.at(-1), /FFmpeg/);
});

test('the chosen nested folder is created and its vault-relative path is embedded', async () => {
  const f = exportFixture();
  f.p.settings.audioFolder = 'Articles/Audio';
  const folders = new Map(), created = [];
  f.p.app.vault.getAbstractFileByPath = name => folders.get(name);
  f.p.app.vault.createFolder = async name => { folders.set(name, new MockFolder()); created.push(name); };
  await f.p.generateArticleAudio();
  assert.deepEqual(created, ['Articles', 'Articles/Audio']);
  assert.equal(f.saved.length, 1); assert.ok(f.saved[0].name.startsWith('Articles/Audio/'));
  assert.ok(f.note().includes('![[' + f.saved[0].name + ']]'));
});

test('Stop during article synthesis cancels every job and leaves no note edit or partial saved file', async () => {
  const f = exportFixture(), requests = [], original = f.note();
  f.p.synthesize = (input, output, settings, children) => new Promise((resolve, reject) => {
    const child = { kill() { children.delete(child); f.p.children.delete(child); reject(new Error('Cancelled')); } };
    children.add(child); f.p.children.add(child); requests.push(input);
  });
  const operation = f.p.generateArticleAudio();
  await until(() => requests.length === 3);
  f.p.stop(); await operation;
  assert.equal(f.saved.length, 0); assert.equal(f.note(), original); assert.equal(f.p.children.size, 0);
  assert.equal(f.p.exporting, false); assert.equal(f.p.exportButton.disabled, false);
  await assert.rejects(fs.access(path.dirname(requests[0])));
});
