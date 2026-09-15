/**
 * A DOM small enough to run peapod's two pages in node.
 *
 * There is no browser in this environment, so "it renders" would otherwise be an
 * assumption. This stub implements only what web/app.js and web/calc.js actually touch,
 * which keeps it honest: if a page starts using a DOM feature this does not have, the
 * render test fails loudly rather than quietly testing less than it claims.
 *
 * It is not a browser. It does not lay out, style or paint, so it proves the pages build
 * the right content from the data — not that they look right.
 */

import { readFile } from 'node:fs/promises';

class Node {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {(Node|string)[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, string>} */
    this.style = {};
    /** @type {Record<string, string>} */
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.title = '';
    this.value = '';
    /** @type {{type: string, fn: (e: any) => void, capture: boolean}[]} */
    this.listeners = [];
    this.disabled = false;
    this.tabIndex = 0;
    /** @type {((e: any) => void)|null} */
    this.onclick = null;
    /** @type {((e: any) => void)|null} */
    this.onkeydown = null;
    this.scope = '';
    this.clientWidth = 1400;
    /** @type {Node|null} */
    this.parent = null;
  }

  /**
   * Setting textContent replaces the children with a single text node, exactly as the DOM
   * does. Storing the text beside the children instead loses it the moment anything is
   * appended — which silently emptied every sortable column header until it was caught.
   * @param {string} value
   */
  set textContent(value) {
    this.children = [String(value)];
  }

  /** @returns {string} */
  get textContent() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  /** @param {(Node|string)[]} nodes */
  prepend(...nodes) {
    for (const n of nodes.reverse()) {
      if (typeof n !== 'string') n.parent = this;
      this.children.unshift(n);
    }
  }

  /** Detach from the parent, as Element.remove does. */
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  /** @param {(Node|string)[]} nodes */
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n !== 'string') n.parent = this;
      this.children.push(n);
      if (this.tag === 'select' && typeof n !== 'string' && n.tag === 'option' && !this.value) {
        this.value = n.value;
      }
    }
  }

  /** @param {(Node|string)[]} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  /** @param {string} name @param {unknown} value */
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    // Real elements mirror class between the attribute and the property. SVG nodes are
    // built with setAttribute('class', …), so without this they are invisible to byClass.
    if (name === 'class') this.className = String(value);
  }
  /** @param {string} name @returns {string} */
  getAttribute(name) { return this.attributes[name] ?? ''; }
  /** @param {string} name */
  hasAttribute(name) { return this.attributes[name] !== undefined; }
  /** @param {string} name */
  removeAttribute(name) { delete this.attributes[name]; }

  get tagName() { return String(this.tag).toUpperCase(); }

  /**
   * @param {string} type @param {(e: any) => void} fn
   * @param {boolean | {capture?: boolean}} [opts]
   */
  addEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture);
    this.listeners.push({ type, fn, capture });
  }

  /**
   * Dispatch with a real capture phase.
   *
   * `error` on an image does NOT bubble, so a listener on an ancestor only ever sees it
   * during capture. A stub that called listeners on the target alone would let a page
   * that delegates image fallbacks pass while doing nothing in a browser, so the phases
   * are modelled rather than collapsed.
   *
   * @param {{type: string, bubbles?: boolean}} event
   */
  dispatchEvent(event) {
    /** @type {any[]} */
    const path = [];
    for (let n = /** @type {any} */ (this); n; n = n.parent) path.push(n);
    if (globalThis.document && path[path.length - 1] !== globalThis.document) {
      path.push(globalThis.document);
    }
    const e = { ...event, target: this };
    for (const n of path.slice(1).reverse()) {
      for (const l of n.listeners ?? []) if (l.capture && l.type === event.type) l.fn(e);
    }
    for (const l of this.listeners ?? []) if (l.type === event.type) l.fn(e);
    if (event.bubbles) {
      for (const n of path.slice(1)) {
        for (const l of n.listeners ?? []) if (!l.capture && l.type === event.type) l.fn(e);
      }
    }
    return true;
  }

  /** @param {string} sel */
  closest(sel) {
    // Only the attribute form the pages use, e.g. [data-unit].
    const m = sel.match(/^\[([\w-]+)\]$/);
    if (m) {
      const key = m[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
      return this.dataset[key] !== undefined || this.attributes[m[1]] !== undefined ? this : null;
    }
    return null;
  }

  /** @param {string} sel */
  querySelectorAll(sel) {
    const m = sel.match(/^\[([\w-]+)\]$/);
    if (!m) return [];
    const key = m[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return this.descendants().filter((n) => n.dataset[key] !== undefined
      || n.attributes[m[1]] !== undefined);
  }

  /** Every node beneath this one, for assertions. */
  descendants() {
    /** @type {Node[]} */
    const out = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      out.push(child, ...child.descendants());
    }
    return out;
  }

  /** Nodes whose class list contains `cls`. */
  /** @param {string} cls */
  byClass(cls) {
    return this.descendants().filter((n) => n.className.split(/\s+/).includes(cls));
  }

  /** Direct element children, with text nodes filtered out. @returns {Node[]} */
  elements() {
    return /** @type {Node[]} */ (this.children.filter((c) => typeof c !== 'string'));
  }

  /** @param {string} tag */
  byTag(tag) {
    return this.descendants().filter((n) => n.tag === tag);
  }
}

/**
 * Install a document containing one stub element per `id="..."` in the given HTML file,
 * plus a fetch that serves web/ from disk.
 * @param {URL} htmlUrl
 */
export async function install(htmlUrl) {
  const html = await readFile(htmlUrl, 'utf8');
  /** @type {Map<string, Node>} */
  const byId = new Map();
  for (const match of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Node(match[1]);
    // Carry the attributes the pages read back off the element, so a control declared
    // with value="10" in the markup behaves here as it would in a browser.
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      node.attributes[attr[1]] = attr[2];
      if (attr[1] === 'value') node.value = attr[2];
      if (attr[1] === 'class') node.className = attr[2];
    }
    byId.set(match[3], node);
  }

  globalThis.document = /** @type {any} */ ({});
  const document = {
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    createElement: (/** @type {string} */ tag) => new Node(tag),
    createTextNode: (/** @type {unknown} */ text) => String(text),
    createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => new Node(tag),
    /** @type {any[]} */
    listeners: [],
    /**
     * @param {string} type @param {(e: any) => void} fn
     * @param {boolean | {capture?: boolean}} [opts]
     */
    addEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts && opts.capture);
      document.listeners.push({ type, fn, capture });
    },
  };

  globalThis.document = /** @type {any} */ (document);
  globalThis.addEventListener = () => {};
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ path) => {
    const file = new URL(`../web${path}`, import.meta.url);
    try {
      const body = await readFile(file, 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    } catch {
      // Real fetch RESOLVES with ok:false on a 404; it does not reject. Throwing here
      // meant any not-found path looked like a crash instead of a handled state.
      return {
        ok: false, status: 404,
        json: async () => { throw new Error('404'); },
        text: async () => '',
      };
    }
  });

  /**
   * The element with this id, or a failure naming it. Tests assert on content, so a
   * missing id should say which one rather than surface as "possibly undefined".
   * @param {string} id
   * @returns {Node}
   */
  const get = (id) => {
    const node = byId.get(id);
    if (!node) throw new Error(`no element with id "${id}" in ${htmlUrl.pathname}`);
    return node;
  };

  return { byId, get, document };
}
