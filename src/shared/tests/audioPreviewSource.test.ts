import { expect, test } from 'vitest';

import { getAudioMimeType, resolveAudioSource } from '@/shared/utils';

test.each([
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['opus', 'audio/opus'],
  ['oga', 'audio/ogg'],
  ['ogg', 'audio/ogg'],
  ['weba', 'audio/webm'],
])('audio extension %s has the same MIME type in chat and file previews', (extension, mimeType) => {
  expect(getAudioMimeType(`demo.${extension}`)).toBe(mimeType);
  expect(getAudioMimeType(`demo.${extension.toUpperCase()}`)).toBe(mimeType);
});

test.each(['mp3', 'README', 'demo.mp4', 'demo.png', 'demo.', 'constructor', 'toString'])('%s is not an audio filename', (filename) => {
  expect(getAudioMimeType(filename)).toBeUndefined();
});

test.each([
  ['output/demo.mp3', 'output/demo.mp3'],
  ['./output/demo.wav', './output/demo.wav'],
  ['../output/demo.m4a', '../output/demo.m4a'],
  ['/Users/owner/output/demo.mp3', '/Users/owner/output/demo.mp3'],
  ['output/%E8%AF%AD%E9%9F%B3%20%23one%3Ftwo.mp3', 'output/语音 #one?two.mp3'],
  ['output/100%2520.mp3', 'output/100%20.mp3'],
  ['output/demo.mp3?download=1#preview', 'output/demo.mp3'],
  ['file:///home/owner/demo.mp3', '/home/owner/demo.mp3'],
  ['file://localhost/home/owner/demo.mp3', '/home/owner/demo.mp3'],
  ['sandbox:/home/owner/demo.mp3', '/home/owner/demo.mp3'],
  ['C:/Users/owner/demo.mp3', 'C:/Users/owner/demo.mp3'],
  ['C:%5CUsers%5Cowner%5Cdemo.mp3', 'C:\\Users\\owner\\demo.mp3'],
  ['file:///C:/Users/owner/demo.mp3', 'C:/Users/owner/demo.mp3'],
])('resolves file audio %s exactly once for the existing project API', (href, path) => {
  expect(resolveAudioSource(href)).toMatchObject({ kind: 'file', value: path });
});

test.each([
  'https://cdn.example.test/demo.mp3?signature=abc#t=10',
  'http://cdn.example.test/demo.wav',
  '//cdn.example.test/%E8%AF%AD%E9%9F%B3.M4A',
])('keeps public audio URL %s intact without treating it as a node file', (href) => {
  expect(resolveAudioSource(href)).toMatchObject({ kind: 'remote', value: href });
});

test.each([
  undefined,
  '',
  '#demo.mp3',
  'javascript:demo.mp3',
  'data:audio/mpeg,demo.mp3',
  'blob:https://portal.test/demo.mp3',
  'ftp://example.test/demo.mp3',
  'file://other-node/demo.mp3',
  'sandbox://other-node/demo.mp3',
  'https://user:password@example.test/demo.mp3',
  'https://example.test/demo.html?file=demo.mp3',
  'http:demo.mp3',
  'C:demo.mp3',
  'output/%E0%A4.mp3',
  'output/%00demo.mp3',
  'https://example.test/%00demo.mp3',
  'output/\u0000demo.mp3',
  'output/demo.png',
])('rejects unsafe or non-audio source %s', (href) => {
  expect(resolveAudioSource(href)).toBeNull();
});
