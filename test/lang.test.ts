import assert from 'node:assert/strict';
import { test } from 'node:test';
import { langOf } from '../src/lang.ts';

test('text without Han, kana or hangul has no language', () => {
  assert.equal(langOf('Blonde', 'Frank Ocean'), undefined);
  assert.equal(langOf(), undefined);
  assert.equal(langOf(null, undefined, ''), undefined);
});

test('kana means Japanese, even beside Han characters', () => {
  assert.equal(langOf('ひこうき雲'), 'ja');
  assert.equal(langOf('風をあつめて'), 'ja');
  assert.equal(langOf('シャングリラ'), 'ja');
});

test('hangul means Korean', () => {
  assert.equal(langOf('밤편지'), 'ko');
  assert.equal(langOf('Love poem', '아이유'), 'ko');
});

test('kana wins over hangul when both appear', () => {
  assert.equal(langOf('사랑', 'あい'), 'ja');
});

test('simplified forms mean Simplified Chinese', () => {
  assert.equal(langOf('我们的爱'), 'zh-Hans');
  assert.equal(langOf('后来', '刘若英', '我等你'), 'zh-Hans');
});

test('traditional forms and Cantonese particles mean Traditional Chinese', () => {
  assert.equal(langOf('我們'), 'zh-Hant');
  assert.equal(langOf('聽海'), 'zh-Hant');
  assert.equal(langOf('唔該'), 'zh-Hant');
});

test('everyday Chinese words decide when the forms do not', () => {
  assert.equal(langOf('你好'), 'zh-Hans');
});

test('Han characters shared by every script are left untagged', () => {
  assert.equal(langOf('東京'), undefined);
  assert.equal(langOf('山'), undefined);
});

test('every text given is read together', () => {
  // A title alone says nothing; the lyrics beside it do.
  assert.equal(langOf('東京'), undefined);
  assert.equal(langOf('東京', 'きみを待つ'), 'ja');
});
