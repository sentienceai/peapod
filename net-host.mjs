/**
 * Which address to listen on.
 *
 * 127.0.0.1 is the right default on a laptop: `npm run dev` should not expose the site to
 * everyone on the cafe wifi. It is the wrong default in a container, where the only client
 * is the platform's proxy arriving over the container network — binding loopback there
 * means a deploy that reports success and answers every healthcheck run inside the
 * container, while every request from outside gets a 502.
 *
 * So the default follows the environment rather than being one value that is wrong half
 * the time. An explicit HOST always wins.
 */

import { existsSync } from 'node:fs';

/**
 * @param {Record<string, string | undefined>} env
 * @param {() => boolean} [inContainer]
 * @returns {{host: string, why: string}}
 */
export function resolveHost(env = process.env, inContainer = dockerised) {
  if (env.HOST) return { host: env.HOST, why: 'HOST is set' };
  // Railway, Fly, Render and friends all set their own marker; the dockerenv file covers
  // a plain `docker run`. Any of them means the client is outside this network namespace.
  const platform = ['RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'FLY_APP_NAME',
    'RENDER', 'KUBERNETES_SERVICE_HOST', 'DYNO']
    .find((k) => env[k]);
  if (platform) return { host: '0.0.0.0', why: `${platform} is set` };
  if (inContainer()) return { host: '0.0.0.0', why: 'running in a container' };
  return { host: '127.0.0.1', why: 'local default' };
}

/** @returns {boolean} */
export function dockerised() {
  return existsSync('/.dockerenv');
}
