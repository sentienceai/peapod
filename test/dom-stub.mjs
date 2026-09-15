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
    this._text = '';
    this.clientWidth = 1400;
  }

  /** @param {string} value */
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  /** @returns {string} */
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  /** @param {(Node|string)[]} nodes */
  append(...nodes) {
    for (const n of nodes) {
      this.children.push(n);
      if (this.tag === 'select' && typeof n !== 'string' && n.tag === 'option' && !this.value) {
        this.value = n.value;
      }
    }
  }

  /** @param {(Node|string)[]} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  /** @param {string} name @param {unknown} value */
  setAttribute(name, value) { this.attributes[name] = String(value); }
  /** @param {string} name @returns {string} */
  getAttribute(name) { return this.attributes[name] ?? ''; }
  addEventListener() {}

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

  const document = {
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    createElement: (/** @type {string} */ tag) => new Node(tag),
    createTextNode: (/** @type {unknown} */ text) => String(text),
  };

  globalThis.document = /** @type {any} */ (document);
  globalThis.addEventListener = () => {};
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ path) => {
    const file = new URL(`../web${path}`, import.meta.url);
    const body = await readFile(file, 'utf8');
    return { ok: true, json: async () => JSON.parse(body), text: async () => body };
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
