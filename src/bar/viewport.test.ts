import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OFFSET } from './styles.js';
import { shortenViewportUnits } from './viewport.js';

describe('shortenViewportUnits', () => {
  test('takes the offset off a full-height length', () => {
    assert.equal(shortenViewportUnits('100vh'), `calc(100vh - ${OFFSET})`);
    assert.equal(shortenViewportUnits('100dvh'), `calc(100dvh - ${OFFSET})`);
    assert.equal(shortenViewportUnits('100svh'), `calc(100svh - ${OFFSET})`);
    assert.equal(shortenViewportUnits('100LVH'), `calc(100LVH - ${OFFSET})`);
    assert.equal(shortenViewportUnits('1e2vh'), `calc(1e2vh - ${OFFSET})`);
  });

  test('takes off in proportion, so a fraction of the viewport stays that fraction', () => {
    assert.equal(shortenViewportUnits('50vh'), `calc(50vh - ${OFFSET} * 50 / 100)`);
    assert.equal(shortenViewportUnits('33.333vh'), `calc(33.333vh - ${OFFSET} * 33.333 / 100)`);
    assert.equal(shortenViewportUnits('.5vh'), `calc(.5vh - ${OFFSET} * .5 / 100)`);
    assert.equal(shortenViewportUnits('-10vh'), `calc(-10vh - ${OFFSET} * -10 / 100)`);
  });

  test('rewrites every length in a value, inside calc() or not', () => {
    assert.equal(shortenViewportUnits('calc(100vh - 51px)'), `calc(calc(100vh - ${OFFSET}) - 51px)`);
    assert.equal(
      shortenViewportUnits('10vh 1fr 20vh'),
      `calc(10vh - ${OFFSET} * 10 / 100) 1fr calc(20vh - ${OFFSET} * 20 / 100)`,
    );
    assert.equal(shortenViewportUnits('min(600px, 80vh)'), `min(600px, calc(80vh - ${OFFSET} * 80 / 100))`);
  });

  test('leaves alone what is not a viewport height', () => {
    for (const value of ['0vh', '100vw', '100%', '44px', '10vmin', 'auto', 'var(--gap-10vh)', '-webkit-fill-available']) {
      assert.equal(shortenViewportUnits(value), value);
    }
  });

  test('steps over urls and strings', () => {
    assert.equal(shortenViewportUnits('url(/img/100vh.png)'), 'url(/img/100vh.png)');
    assert.equal(shortenViewportUnits('url("hero 100vh.png") 100vh'), `url("hero 100vh.png") calc(100vh - ${OFFSET})`);
    assert.equal(shortenViewportUnits('"100vh"'), '"100vh"');
  });
});
