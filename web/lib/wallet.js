/**
 * Wallet connection. Connect only: no signing, no delegation, no transactions.
 *
 * WHY THIS IS NOT PRIVY YET. Privy's vanilla SDK, @privy-io/js-sdk-core, is the only one
 * that works without a build step, and it does not connect external injected wallets — it
 * provisions embedded wallets and authenticates by email, OAuth or SIWE against a provider
 * you already hold. So even with Privy in place, discovering and connecting the visitor's
 * existing wallet is this code. Privy would sit on top, turning a connected address into a
 * session. It also needs an app ID and a client ID from a Privy dashboard account, which
 * this repository does not have, so the adapter below stays inert until it does.
 *
 * WHAT THIS DOES INSTEAD. EIP-6963 announces every injected provider on the page, which is
 * the standard that replaced fighting over window.ethereum when more than one wallet is
 * installed. Providers announce themselves in response to a request event; anything that
 * only sets window.ethereum is picked up as a fallback so a single older wallet still
 * works.
 *
 * eth_requestAccounts is the whole permission surface used here. It asks for addresses and
 * nothing else. No signature is requested, because there is nothing here to authenticate:
 * the page shows public chain data and the address is used to look up a public record.
 */

/** @typedef {{info: {uuid: string, name: string, icon: string, rdns: string}, provider: any}} Announced */

const DISCOVERY_MS = 300;

/** @returns {Promise<Announced[]>} */
export function discover() {
  const found = /** @type {Map<string, Announced>} */ (new Map());
  const w = /** @type {any} */ (globalThis);
  if (!w.addEventListener) return Promise.resolve([]);
  return new Promise((resolve) => {
    /** @param {any} e */
    const onAnnounce = (e) => {
      const d = e?.detail;
      if (d?.info?.uuid && d.provider) found.set(d.info.uuid, d);
    };
    w.addEventListener('eip6963:announceProvider', onAnnounce);
    w.dispatchEvent?.(new (w.CustomEvent ?? Object)('eip6963:requestProvider'));
    setTimeout(() => {
      w.removeEventListener?.('eip6963:announceProvider', onAnnounce);
      // A wallet that predates EIP-6963 only sets window.ethereum. Including it means one
      // old wallet still connects; it is added last so announced providers win.
      if (!found.size && w.ethereum?.request) {
        found.set('injected', {
          info: { uuid: 'injected', name: 'Injected wallet', icon: '', rdns: 'unknown' },
          provider: w.ethereum,
        });
      }
      resolve([...found.values()]);
    }, DISCOVERY_MS);
  });
}

/**
 * Ask a provider for its addresses.
 * @param {any} provider
 * @returns {Promise<string>} the first address, lowercased
 */
export async function connect(provider) {
  if (!provider?.request) throw new Error('no wallet provider');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const first = Array.isArray(accounts) ? accounts[0] : null;
  // A provider can resolve with an empty list when the visitor dismisses the prompt. That
  // is a refusal, not a connection, and it must not read as one.
  if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new Error('no account authorised');
  }
  return first.toLowerCase();
}

/**
 * Does this address have a detail file?
 * @param {string} address
 * @param {(url: string) => Promise<any>} [fetcher]
 * @returns {Promise<boolean>}
 */
export async function hasDetail(address, fetcher) {
  const get = fetcher ?? ((/** @type {string} */ u) => fetch(u));
  const res = await get(`/api/address/${address}`);
  return Boolean(res?.ok);
}
