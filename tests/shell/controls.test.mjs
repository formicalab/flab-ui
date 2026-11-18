// Shared command-bar controls: accessibility and keyboard behavior of the segmented tab strip.
import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
  }

  append(...children) {
    this.children.push(...children.flat(Infinity).filter(child => child != null && child !== false));
  }

  replaceChildren(...children) {
    this.children = children.flat(Infinity).filter(child => child != null && child !== false);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  querySelector(selector) {
    if (selector === '[aria-selected="true"]')
      return this.children.find(child => child.ariaSelected === 'true');
    return null;
  }

  focus() {
    globalThis.focused = this;
  }
}

globalThis.document = { createElement: tag => new Element(tag) };
const { tabsControl } = await import('../../www/js/core/controls.js');
const { routeForTab } = await import('../../www/js/pages/dns/index.js');

test('DNS tabs have stable navigation routes', () => {
  assert.equal(routeForTab('resolver'), '#dns');
  assert.equal(routeForTab('dynamic'), '#ddns');
});

test('tabs expose one active tab, a panel relation and arrow/Home/End keyboard navigation', async () => {
  const state = { tab: 'resolver' };
  const changed = [];
  const tabs = tabsControl(state, 'tab', value => changed.push(value));
  tabs.setOptions([['resolver', 'Resolver'], ['dynamic', 'Dynamic DNS'], ['other', 'Other']]);

  assert.equal(tabs.node.role, 'tablist');
  assert.equal(tabs.node.ariaLabel, 'Views');
  assert.deepEqual(tabs.node.children.map(button => [button.tabIndex, button.ariaSelected, button.ariaControls]),
    [[0, 'true', 'page-content'], [-1, 'false', 'page-content'], [-1, 'false', 'page-content']]);

  const active = tabs.node.children[0];
  let prevented = false;
  active.onkeydown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(prevented, true);
  assert.equal(state.tab, 'dynamic');
  assert.equal(changed.at(-1), 'dynamic');
  assert.equal(globalThis.focused, tabs.node.children[1]);

  tabs.node.children[1].onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(state.tab, 'other');
  tabs.node.children[2].onkeydown({ key: 'Home', preventDefault() {} });
  assert.equal(state.tab, 'resolver');
  tabs.node.children[0].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(state.tab, 'other', 'left wraps to the final tab');
});
