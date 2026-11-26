// Keyboard helpers of core/dom.js: Enter (and Space) run the action only when the element itself has focus.
import assert from 'node:assert/strict';
import test from 'node:test';
import { onActivate, onEnter } from '../../www/js/core/dom.js';

// A keydown event on `target`, heard by `currentTarget`; records whether the default action was prevented.
const press = (key, { target = 'row', currentTarget = 'row' } = {}) => ({ key, target, currentTarget, prevented: false, preventDefault() { this.prevented = true; } });

test('onEnter runs on Enter only, and stops the default action', () => {
  let runs = 0;
  const listener = onEnter(() => { runs++; });
  const enter = press('Enter');
  listener(enter);
  listener(press(' '));
  listener(press('a'));
  assert.equal(runs, 1);
  assert.equal(enter.prevented, true);
});

test('onActivate runs on Enter and Space', () => {
  let runs = 0;
  const listener = onActivate(() => { runs++; });
  listener(press('Enter'));
  listener(press(' '));
  listener(press('Tab'));
  assert.equal(runs, 2);
});

test('a key pressed on a control inside the element is left alone', () => {
  let runs = 0;
  const inner = press('Enter', { target: 'button' });
  onActivate(() => { runs++; })(inner);
  onEnter(() => { runs++; })(inner);
  assert.equal(runs, 0);
  assert.equal(inner.prevented, false);
});
