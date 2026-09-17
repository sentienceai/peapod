/**
 * The connect control, and what a connected address is actually for here.
 *
 * CONNECT ONLY. The button asks a wallet for its addresses and nothing else: no signature,
 * no chain switch, no transaction, no delegated signing. There is nothing on this site to
 * authorise, so asking for authority would be asking for something we have no use for —
 * and a signature request is the one prompt that makes a read-only site look like it wants
 * something. lib/wallet.js is the whole provider surface, and eth_requestAccounts is the
 * whole of that.
 *
 * WHAT CONNECTING BUYS. One thing: the address is looked up in the tape. If it traded, the
 * control becomes a way into its own profile. If it did not, it says so plainly rather than
 * opening an empty page — most addresses on this chain never closed a round-trip, and a
 * great many never traded at all.
 *
 * WHEN EXECUTION LANDS this is the control that grows a session. It does not grow one now,
 * because there is nothing to sign for yet.
 */

import { connect, discover } from './wallet.js';
import { trader } from './data.js';
import { openProfile } from './profile.js';
import { node, shortAddr } from './format.js';

/** @param {string} address */
async function tradedHere(address) {
  try {
    return Boolean(await trader(address));
  } catch {
    // A lookup that failed is not the same as an address that never traded, and the button
    // must not claim the second when it only knows the first.
    return null;
  }
}

/**
 * @param {HTMLElement} host
 * @param {{discover?: typeof discover, connect?: typeof connect,
 *   lookup?: (address: string) => Promise<boolean | null>,
 *   open?: (address: string) => void}} [deps]
 */
export function mountWallet(host, deps = {}) {
  const find = deps.discover ?? discover;
  const ask = deps.connect ?? connect;
  const look = deps.lookup ?? tradedHere;
  const open = deps.open ?? ((/** @type {string} */ a) => openProfile(a));

  host.className = 'wallet';
  /** @param {string} text @param {string} [cls] */
  const button = (text, cls) => {
    const b = node('button', cls ?? 'btn btn-primary wallet-btn', text);
    /** @type {HTMLButtonElement} */ (b).type = 'button';
    return b;
  };

  /** @param {string} message */
  function say(message) {
    host.replaceChildren(node('span', 'wallet-note', message));
    // The note replaces the button for a moment, then the button comes back: a dead end is
    // worse than a retry.
    setTimeout(render, 2600);
  }

  function render() {
    const b = button('Connect wallet');
    b.setAttribute('aria-label', 'Connect a wallet to find your own address');
    b.onclick = async () => {
      b.textContent = 'Connecting…';
      /** @type {HTMLButtonElement} */ (b).disabled = true;
      try {
        const found = await find();
        if (!found.length) { say('No wallet found'); return; }
        // The first announced provider. A picker belongs here when there is a reason to
        // choose — a session, a chain — and there is not one yet.
        const address = await ask(found[0].provider);
        await connected(address);
      } catch (e) {
        // Dismissing the prompt is a refusal, not a failure, and reads as one.
        say(/no account authorised/i.test(String(/** @type {Error} */ (e).message))
          ? 'Not connected' : 'Wallet refused');
      }
    };
    host.replaceChildren(b);
  }

  /** @param {string} address */
  async function connected(address) {
    const known = await look(address);
    const b = button(shortAddr(address), 'btn wallet-btn wallet-btn--connected');
    b.title = address;
    if (known) {
      b.setAttribute('aria-label', `Open the profile for ${address}`);
      b.onclick = () => open(address);
    } else {
      // Connected, and the tape has nothing for it. Saying that beats opening a page with
      // nothing on it, and beats pretending the button does something.
      b.setAttribute('aria-label', `${address} has not traded in this window`);
      b.onclick = () => say(known === null ? 'Could not check this address' : 'Not in this tape');
    }
    host.replaceChildren(b);
  }

  render();
}
