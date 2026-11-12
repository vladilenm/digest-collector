import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshNewsletterMedia, probeAsset } from '../src/media.js';
import { renderCommonDigest } from '../src/render.js';
const issue = JSON.parse(readFileSync(new URL('./fixtures/newsletter-issue-v1.json', import.meta.url)));
test('one failed image preserves the other cards, sources and video preview', async () => {
  const source = issue.cards[0];
  const good = { ...source, cardId: 'card-'+'b'.repeat(24), image: { ...source.image, url: 'https://example.com/good.jpg' } };
  const preview = { url: good.image.url, sourceUrl: good.image.sourceUrl, checkedAt: good.image.checkedAt };
  const bad = { ...source, videos: [{ url: 'https://example.com/video.mp4', sourceUrl: source.sources[0].url, checkedAt: issue.preparedAt, preview }] };
  const result = await refreshNewsletterMedia({ ...issue, cards: [bad, good] }, async url => {
    if (url === source.image.url) throw new Error('failed image');
    return true;
  });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].image.status, 'missing');
  assert.deepEqual(result.cards[1].image, good.image);
  assert.deepEqual(result.cards[0].sources, source.sources);
  assert.deepEqual(result.cards[0].videos[0].preview, preview);
  const rendered = renderCommonDigest({ issues: [result], ...issue.period });
  assert.match(rendered.html, /good\.jpg/);
  assert.match(rendered.html, /Видео/);
  for (const url of ['http://127.0.0.1/a.jpg','https://t.me/a.jpg','http://169.254.169.254/a.jpg'])
    assert.equal(await probeAsset(url,'image'), false);
});
