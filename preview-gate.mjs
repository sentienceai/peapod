/**
 * The preview flag: which paths exist only while PEAPOD_PREVIEW=1.
 *
 * Nothing is behind it today: the pages it used to hide are the site's own now. It stays
 * because the next thing built ahead of its backend needs somewhere to live, and because
 * "not in the nav" is not the same as not public: this server hands out any file
 * under web/ to anyone who types its path. So the preview files live outside web/, and
 * with the flag off every preview path answers exactly what a path that never existed
 * answers. A 403 or a "coming soon" would announce the feature it is hiding.
 *
 * The flag is the first layer, not the only one. The pages carry no invented values
 * either — every figure without a source renders as a named dependency — so a flag left on
 * by mistake exposes an unfinished page, never a false number.
 */

import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('./', import.meta.url));
export const previewRoot = resolve(repo, 'preview');

/** @param {NodeJS.ProcessEnv} env */
export const previewEnabled = (env) => env.PEAPOD_PREVIEW === '1';

/**
 * Every page path the preview serves, in the shape a person would type. There is no
 * /copy-setup: the setup wizard is a dialog on the pages below, deep-linked with
 * ?setup=<address> so it can still be opened, shared and reloaded.
 */
export const PREVIEW_ROUTES = ['/preview/<file>'];

/**
 * Whether a path belongs to the preview, and if so which file it serves.
 *
 * `/web/lib/*` is here because preview modules import the shared libraries as
 * `../web/lib/…`, a path that resolves identically for node (tests, tsc) and for a browser
 * loading `/preview/*.js`. Those files are already public at `/lib/*`; the alias is gated
 * anyway so that a flag-off server has no trace of the preview's layout.
 *
 * @param {string} path decoded URL pathname
 * @returns {null | { file: string | null }} null: not a preview path. file null: a preview
 *   path that resolves to nothing (bad symbol, traversal).
 */
export function previewRoute(path) {
  // The page routes this gate used to own — /copy-trade, /trader/<address>, /asset/<symbol>
  // — are the site's own pages now, built from the design frames and public. What is left is
  // the machinery: a flag that defaults off and a directory that is not in the image, ready
  // for the next thing that has to be built before its backend exists. Keeping it costs one
  // conditional and saves rebuilding the argument about where unfinished work lives.
  if (!path.startsWith('/preview/') && path !== '/preview') return null;
  const file = resolve(previewRoot, '.' + path.slice('/preview'.length));
  return { file: file.startsWith(previewRoot + sep) ? file : null };
}

