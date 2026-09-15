/**
 * The connect control, and what a connected address is actually for here.
 *
 * Connect only. The button asks a wallet for its addresses and nothing else — no
 * signature, no chain switch, no transaction, no delegated signing. There is nothing on
 * this site to authorise, so asking for authority would be asking for something we have
 * no use for.
 *
 * WHAT CONNECTING BUYS. One thing: the address is looked up in the tape. If it traded, the
 * button becomes a way into its own detail page. If it did not, the control says so
 * plainly rather than opening an empty page — 38,977 addresses on this chain traded
 * without ever closing a round-trip, and a great many more never traded at all.
 */

import { connect, discover, hasDetail } from './wallet.js';
import { openDetail } from './detail.js';

/** @param {string} a */
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * @param {HTMLElement} host
 * @param {{discover?: typeof discover, connect?: typeof connect,
 *   hasDetail?: typeof hasDetail, open?: typeof openDetail}} [deps]
 */
export function mountWallet(host, deps = {}) {
  const find = deps.discover ?? discover;
  const ask = deps.connect ?? connect;
  const look = deps.hasDetail ?? hasDetail;
  const open = deps.open ?? openDetail;

  /** @param {string} cls @param {string} text */
  function status(cls, text) {
    host.replaceChildren();
    host.append(node('span', `wallet-note ${cls}`, text));
  }

  function idle() {
    host.replaceChildren();
    const b = /** @type {HTMLButtonElement} */ (node('button', 'wallet-btn', 'Connect wallet'));
    b.type = 'button';
    b.onclick = () => { void run(b); };
    host.append(b);
  }

  /** @param {HTMLButtonElement} button */
  async function run(button) {
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      const providers = await find();
      if (!providers.length) {
        status('is-fail', 'No wallet found in this browser');
        return;
      }
      // One wallet connects straight through; more than one has to be chosen between,
      // because picking for the visitor is picking wrong for some of them.
      const chosen = providers.length === 1 ? providers[0] : await choose(providers);
      if (!chosen) { idle(); return; }
      const address = await ask(chosen.provider);
      await settle(address);
    } catch {
      // A refused prompt is the commonest outcome and is not an error state to dwell on.
      status('is-fail', 'Wallet did not connect');
      setTimeout(idle, 2400);
    }
  }

  /** @param {any[]} providers */
  function choose(providers) {
    return new Promise((resolve) => {
      host.replaceChildren();
      const menu = node('div', 'wallet-menu');
      for (const p of providers) {
        const b = /** @type {HTMLButtonElement} */ (node('button', 'wallet-pick', p.info.name));
        b.type = 'button';
        b.onclick = () => resolve(p);
        menu.append(b);
      }
      const cancel = /** @type {HTMLButtonElement} */ (node('button', 'wallet-pick', 'Cancel'));
      cancel.type = 'button';
      cancel.onclick = () => resolve(null);
      menu.append(cancel);
      host.append(menu);
    });
  }

  /** @param {string} address */
  async function settle(address) {
    host.replaceChildren();
    const known = await look(address).catch(() => false);
    const who = node('span', 'wallet-addr', shortAddr(address));
    who.title = address;
    host.append(who);
    if (known) {
      const b = /** @type {HTMLButtonElement} */ (node('button', 'wallet-btn', 'Your page'));
      b.type = 'button';
      b.onclick = () => { void open(address); };
      host.append(b);
    } else {
      host.append(node('span', 'wallet-note', 'Not in this tape'));
    }
  }

  idle();
  return { settle };
}
