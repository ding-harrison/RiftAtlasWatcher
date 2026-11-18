// Run with:  node --test tests/
// No dependencies: uses Node's built-in test runner (Node 18+).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONFIG, normalize, isLineText, withTimeSpace, splitLine, relation, mergeWindow } = require('../content.js');
const { toTxt, toJson, allToTxt, formatTime } = require('../popup.js');

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'));
}

test('fixture log lines are recognised', () => {
  const lines = fixture('log-lines.txt');
  assert.ok(lines.length > 10);
  for (const line of lines) assert.ok(isLineText(normalize(line)), `should match: ${line}`);
});

test('headers and UI strings are rejected', () => {
  for (const line of fixture('non-lines.txt')) {
    assert.ok(!isLineText(normalize(line)), `should not match: ${line}`);
  }
});

test('whitespace is normalised before matching', () => {
  assert.equal(normalize('  22:38 \n   Moved   Recruit\tto trash. '), '22:38 Moved Recruit to trash.');
  assert.ok(isLineText(normalize('\n  22:38\n  Moved Recruit to trash.\n')));
});

test('containers longer than maxLineLength are not lines', () => {
  const long = '22:38 ' + 'x'.repeat(CONFIG.maxLineLength);
  assert.ok(!isLineText(long));
  assert.ok(isLineText(long.slice(0, CONFIG.maxLineLength)));
});

test('relation: amendments vs recycled nodes', () => {
  assert.equal(relation('22:46 Drew 1 card.', '22:46 Drew 1 card.'), 'same');
  assert.equal(relation('22:46 Drew 1 card.', '22:46 Drew 1 card.×2'), 'amend');
  assert.equal(relation('22:46 Drew 1 card.×2', '22:46 Drew 1 card.×3'), 'amend');
  assert.equal(relation('22:46 Drew 1 card.×9', '22:46 Drew 1 card.×10'), 'amend');
  assert.equal(relation('22:46 Drew 1 card.×2', '22:46 Drew 2 cards.×2'), 'new');
  assert.equal(relation('22:46 Drew 1 card.×2', '22:46 Drew 1 card.'), 'amend');
  assert.equal(relation('22:46 Drew 1 card.', '22:47 Played Scuttle Crab from hand to base.'), 'new');
});

test('time in its own element gets its space back', () => {
  // RiftAtlas renders <span>22:38</span><span>Moved …</span> with a CSS margin, no space.
  assert.equal(withTimeSpace('22:38Moved Recruit to trash.', '22:38'), '22:38 Moved Recruit to trash.');
  assert.equal(withTimeSpace('22:38 Moved Recruit to trash.', '22:38'), '22:38 Moved Recruit to trash.');
  assert.equal(withTimeSpace('22:382 cards drawn.', '22:38'), '22:38 2 cards drawn.');
  assert.equal(withTimeSpace('22:38 Moved Recruit to trash.', '22:38 Moved Recruit to trash.'), '22:38 Moved Recruit to trash.');
  assert.equal(withTimeSpace('Turn 3', 'Turn 3'), 'Turn 3');
  assert.ok(isLineText(withTimeSpace('22:46Drew 1 card.×2', '22:46')));
});

test('splitLine separates time, body and repeat counter', () => {
  assert.deepEqual(splitLine('22:46 Drew 1 card.×3'), { base: '22:46 Drew 1 card.', body: 'Drew 1 card.', count: 3 });
  assert.deepEqual(splitLine('22:46 Drew 1 card.'), { base: '22:46 Drew 1 card.', body: 'Drew 1 card.', count: 1 });
});

// --- mergeWindow: the log shows "the newest rows right now"; history only grows ---

const texts = (entries) => entries.map((e) => e.text);
function feed(entries, win) {
  return mergeWindow(entries, win, 1000 + entries.length);
}

test('merge: first window is taken as-is', () => {
  const h = [];
  assert.equal(feed(h, ['22:00 A', '22:01 B']), true);
  assert.deepEqual(texts(h), ['22:00 A', '22:01 B']);
  assert.equal(feed(h, ['22:00 A', '22:01 B']), false);
});

test('merge: a sliding window appends only the new rows', () => {
  const h = [];
  feed(h, ['22:00 A', '22:01 B', '22:02 C']);
  feed(h, ['22:01 B', '22:02 C', '22:03 D']); // A fell out of the rolling buffer
  feed(h, ['22:03 D', '22:04 E']);
  assert.deepEqual(texts(h), ['22:00 A', '22:01 B', '22:02 C', '22:03 D', '22:04 E']);
});

test('merge: repeat counters update in place and never shrink', () => {
  const h = [];
  feed(h, ['22:00 A', '22:01 Drew 1 card.']);
  feed(h, ['22:00 A', '22:01 Drew 1 card.×2']);
  feed(h, ['22:00 A', '22:01 Drew 1 card.×3', '22:02 B']);
  // the row is now at the edge of the window and only shows part of its run
  feed(h, ['22:01 Drew 1 card.', '22:02 B', '22:03 C']);
  assert.deepEqual(texts(h), ['22:00 A', '22:01 Drew 1 card.×3', '22:02 B', '22:03 C']);
});

test('merge: a repeat in a later minute updates the same line', () => {
  const h = [];
  feed(h, ['22:00 A', '22:01 Drew 1 card.']);
  feed(h, ['22:00 A', '22:02 Drew 1 card.×2']);
  assert.deepEqual(texts(h), ['22:00 A', '22:02 Drew 1 card.×2']);
});

test('merge: identical lines from two players are both kept', () => {
  const h = [];
  feed(h, ['22:00 Locked in a battlefield.']);
  feed(h, ['22:00 Locked in a battlefield.', '22:00 Locked in a battlefield.']);
  feed(h, ['22:00 Locked in a battlefield.', '22:00 Locked in a battlefield.', '22:01 B']);
  assert.deepEqual(texts(h), ['22:00 Locked in a battlefield.', '22:00 Locked in a battlefield.', '22:01 B']);
});

test('merge: re-drawn and scrolled-back rows are not captured twice', () => {
  const h = [];
  feed(h, ['22:00 A', '22:01 B', '22:02 C', '22:03 D']);
  feed(h, ['22:02 C', '22:03 D']);
  feed(h, ['22:00 A', '22:01 B', '22:02 C', '22:03 D']); // player scrolled back
  assert.equal(feed(h, ['22:03 D']), false);
  assert.deepEqual(texts(h), ['22:00 A', '22:01 B', '22:02 C', '22:03 D']);
});

test('merge: lines undone by a rewind stay in the history', () => {
  const h = [];
  feed(h, ['22:00 A', '22:01 B', '22:02 C']);
  feed(h, ['22:00 A', '22:01 B', '22:03 Rewound to before their last action.']);
  feed(h, ['22:00 A', '22:01 B', '22:03 Rewound to before their last action.', '22:04 D']);
  assert.deepEqual(texts(h), ['22:00 A', '22:01 B', '22:02 C', '22:03 Rewound to before their last action.', '22:04 D']);
});

test('merge: older rows revealed by scrolling go before what is already saved', () => {
  const h = [];
  feed(h, ['22:05 E', '22:06 F']); // joined mid-match
  feed(h, ['22:03 C', '22:04 D', '22:05 E', '22:06 F']);
  assert.deepEqual(texts(h), ['22:03 C', '22:04 D', '22:05 E', '22:06 F']);
});

test('merge: new rows keep their capture time, old rows keep theirs', () => {
  const h = [];
  mergeWindow(h, ['22:00 A'], 111);
  mergeWindow(h, ['22:00 A', '22:01 B'], 222);
  assert.deepEqual(h, [{ capturedAt: 111, text: '22:00 A' }, { capturedAt: 222, text: '22:01 B' }]);
});

const session = {
  id: '2026-11-17T05-46-12-345Z#a1b2c3',
  startedAt: 1763358372345,
  url: 'https://play.riftatlas.com/room/abc',
  entries: [
    { capturedAt: 1763358380120, text: '22:46 Played Scuttle Crab from hand to base.' },
    { capturedAt: 1763358381000, text: '22:46 Drew 1 card.×2' },
  ],
};

test('.txt export is one line per entry, verbatim, header-less', () => {
  assert.equal(toTxt(session), '22:46 Played Scuttle Crab from hand to base.\n22:46 Drew 1 card.×2\n');
});

test('.json export parses and uses ISO-8601 timestamps', () => {
  const parsed = JSON.parse(toJson(session));
  assert.deepEqual(Object.keys(parsed), ['id', 'startedAt', 'url', 'entries']);
  assert.equal(parsed.entries.length, 2);
  for (const e of parsed.entries) {
    assert.equal(new Date(e.capturedAt).toISOString(), e.capturedAt);
    assert.equal(typeof e.text, 'string');
  }
  assert.equal(parsed.entries[0].capturedAt, '2025-11-17T05:46:20.120Z');
});

test('"export all" is oldest-first with session separators', () => {
  const later = { ...session, startedAt: session.startedAt + 60_000, entries: [{ capturedAt: 1, text: '22:50 Drew 1 card.' }] };
  const out = allToTxt([later, session]);
  assert.equal(
    out,
    `==== Session started ${formatTime(session.startedAt)} ====\n` +
      toTxt(session) +
      `\n==== Session started ${formatTime(later.startedAt)} ====\n` +
      '22:50 Drew 1 card.\n'
  );
});
