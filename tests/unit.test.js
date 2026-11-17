// Run with:  node --test tests/
// No dependencies: uses Node's built-in test runner (Node 18+).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONFIG, normalize, isLineText, relation } = require('../content.js');
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
