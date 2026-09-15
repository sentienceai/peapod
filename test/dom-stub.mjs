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
  addEventListener() {}

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
