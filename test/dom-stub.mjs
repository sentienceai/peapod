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
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

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

  /**
   * Standard DOM, and the sixth method this stub has turned out not to have. Each one has
   * been found the same way — by real page code calling it and the test reporting "not a
   * function" rather than reporting on the page. A stub that only implements what the page
   * happened to use yesterday fails on whatever it uses tomorrow.
   * @param {Node|string} node @param {Node|null} ref
   */
  insertBefore(node, ref) {
    if (typeof node !== 'string') node.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
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
   * title mirrors its attribute, the way a browser does.
   *
   * It was a plain field, so `el.title = '…'` set a property nothing could read back
   * through getAttribute — a test asserting on the attribute saw undefined while the page
   * was perfectly correct. Same shape as setAttribute('class') not reaching className.
   */
  get title() { return this.attributes.title ?? ''; }

  set title(value) { this.attributes.title = String(value); }

  /**
   * A real classList, kept in sync with className both ways.
   *
   * Pages use classList; a stub without one fails at the first `.add`, and a stub whose
   * classList did not write back to className would let byClass miss the very class the
   * page just set.
   */
  get classList() {
    const owner = this;
    const parts = () => String(owner.className).split(/\s+/).filter(Boolean);
    const write = (/** @type {string[]} */ list) => {
      owner.className = [...new Set(list)].join(' ');
      if (owner.attributes.class !== undefined) owner.attributes.class = owner.className;
    };
    return {
      /** @param {string[]} names */
      add(...names) { write([...parts(), ...names]); },
      /** @param {string[]} names */
      remove(...names) { write(parts().filter((c) => !names.includes(c))); },
      /** @param {string} name */
      contains(name) { return parts().includes(name); },
      /** @param {string} name @param {boolean} [on] */
      toggle(name, on) {
        const has = parts().includes(name);
        const want = on === undefined ? !has : on;
        if (want) this.add(name); else this.remove(name);
        return want;
      },
      get length() { return parts().length; },
    };
  }

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

  /**
   * Attribute selectors, tag names, and comma-separated lists of either.
   *
   * The modal's focus trap asks for 'button, a[href], input, select, textarea, [tabindex]'.
   * A stub that returned [] for that would report an empty trap and pass every assertion
   * about it while the real page trapped nothing.
   * @param {string} sel
   */
  querySelectorAll(sel) {
    /** @param {Node} n @param {string} part */
    const matches = (n, part) => {
      const attr = part.match(/^([\w-]*)\[([\w-]+)\]$/);
      if (attr) {
        return (!attr[1] || n.tag === attr[1])
          && (n.attributes[attr[2]] !== undefined
            || n.dataset[attr[2].replace(/^data-/, '').replace(/-(\w)/g,
              (_, c) => c.toUpperCase())] !== undefined);
      }
      return /^[\w-]+$/.test(part) && n.tag === part;
    };
    const parts = sel.split(',').map((x) => x.trim()).filter(Boolean);
    return this.descendants().filter((n) => parts.some((part) => matches(n, part)));
  }

  /** Focus, as the browser tracks it, so focus return can be asserted. */
  focus() {
    const d = /** @type {any} */ (globalThis.document);
    if (d) d.activeElement = this;
  }

  blur() {
    const d = /** @type {any} */ (globalThis.document);
    if (d && d.activeElement === this) d.activeElement = null;
  }

  /** Text inputs select their contents when a shortcut focuses them. */
  select() {}

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

  /**
   * Build the tree of id'd elements, not just a flat map of them.
   *
   * This used to create one detached node per id="...", so el('modal').descendants() was
   * empty and anything that searched inside a container found nothing. A focus trap tested
   * that way reports zero focusable elements and passes every assertion about it, and a
   * backdrop-click test passes because the click never reaches the backdrop either. The
   * scan now tracks open and close tags and nests each id'd element inside the nearest
   * id'd element enclosing it, which is the structure the pages actually query.
   */
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr']);
  /** @type {{tag: string, node: Node|null}[]} */
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const id = attrs.match(/\bid="([^"]+)"/);
    /** @type {Node|null} */
    let node = null;
    if (id) {
      node = new Node(tag);
      // Carry the attributes the pages read back off the element, so a control declared
      // with value="10" in the markup behaves here as it would in a browser.
      for (const attr of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
        node.attributes[attr[1]] = attr[2];
        if (attr[1] === 'value') node.value = attr[2];
        if (attr[1] === 'class') node.className = attr[2];
      }
      if (/\bhidden\b/.test(attrs)) node.hidden = true;
      const parent = [...stack].reverse().find((f) => f.node)?.node;
      if (parent) parent.append(node);
      byId.set(id[1], node);
    }
    if (!VOID.has(tag) && !selfClose) stack.push({ tag, node });
  }

  globalThis.document = /** @type {any} */ ({});
  const document = {
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    createElement: (/** @type {string} */ tag) => new Node(tag),
    createTextNode: (/** @type {unknown} */ text) => String(text),
    createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => new Node(tag),
    /** @type {Node | null} */
    activeElement: null,
    /** @param {{type: string}} event */
    dispatchEvent(event) {
      for (const l of document.listeners) if (l.type === event.type) l.fn({ ...event });
      return true;
    },
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
  // The pages read through /api, so the stub answers /api the way the server does —
  // from the same store, not from a parallel set of fixture files. A stub that served
  // JSON the server no longer produces would test a page that cannot run.
  /** @type {any} */
  let api = null;
  const apiFor = async () => {
    if (api) return api;
    const mod = await import('../web-api.mjs');
    api = { ...mod, inst: new mod.Api(
      process.env.PEAPOD_DB
      || fileURLToPath(new URL('../var/peapod.db', import.meta.url))) };
    return api;
  };

  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ path) => {
    if (path.startsWith('/api')) {
      const a = await apiFor();
      const out = a.route(a.inst, new URL(`http://stub${path}`));
      const text = out.gzip
        ? gunzipSync(Buffer.from(out.body)).toString('utf8') : String(out.body);
      return {
        ok: out.status < 400, status: out.status,
        json: async () => JSON.parse(text), text: async () => text,
      };
    }
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
   * A clipboard that records what was written and can be made to fail.
   *
   * `navigator.clipboard` is undefined on an insecure origin and its writeText rejects
   * when permission is refused. Both are ordinary states for a real visitor, so the stub
   * can produce them on demand — otherwise the only path ever tested is the happy one and
   * a silent failure ships.
   */
  const clipboard = {
    /** @type {string[]} */
    writes: [],
    /** @type {'ok' | 'reject' | 'absent'} */
    mode: 'ok',
    /** @param {string} text */
    async writeText(text) {
      if (clipboard.mode === 'reject') throw new Error('NotAllowedError');
      clipboard.writes.push(text);
    },
  };
  // Node 22 defines globalThis.navigator itself, as a getter-only property, so it has to
  // be redefined rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { get clipboard() { return clipboard.mode === 'absent' ? undefined : clipboard; } },
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

  return { byId, get, document, clipboard };
}
