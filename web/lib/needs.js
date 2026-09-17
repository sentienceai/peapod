/**
 * What each unwired figure on the preview pages is waiting for.
 *
 * One registry, so the page, the tests and the plan cannot disagree. A slot the data cannot
 * fill renders its entry here — what it needs, in words — and never a placeholder number,
 * a dash, or a sample value. A dash in a financial field reads as a measured zero; a sample
 * value reads as a measurement.
 *
 * The dependencies are deliberately few, because they are different timelines:
 *   execution       the copy backend: orders, fills, copy wallets. Its own schedule.
 *   transfer-index  every ERC-20 Transfer on the chain and a balance engine over it.
 *                   ~275M events for RWA alone; the engine is weeks of work.
 *   definition      a published criterion. A product decision before it is a data one.
 *   asset-api       an endpoint over the swap tape the build already holds. No new data.
 *   history         a window longer than the tape the build currently folds.
 */

/** @typedef {'execution' | 'transfer-index' | 'definition' | 'asset-api' | 'history'} Dependency */

/** @type {Record<Dependency, string>} */
export const DEPENDENCIES = {
  execution: 'Needs execution',
  'transfer-index': 'Needs the transfer index',
  definition: 'Needs a published definition',
  'asset-api': 'Needs an asset endpoint',
  history: 'Needs a longer tape',
};

/**
 * @type {Record<string, { label: string, needs: Dependency[], why: string }>}
 */
export const NEEDS = {
  copyScore: {
    label: 'Copy score',
    needs: ['definition', 'execution'],
    why: 'A score has to say what it measures before it can be shown, and a score for '
      + 'copying has to be measured against copies: the slippage and delay a follower '
      + 'actually got. Until then it would be a ranking with a new name.',
  },
  simulatedReturn: {
    label: 'Simulated return',
    needs: ['execution'],
    why: 'The replay can be modelled from the swap tape and pool depth, but a simulation '
      + 'is only publishable once it has been checked against real fills.',
  },
  copying: {
    label: 'Copying',
    needs: ['execution'],
    why: 'There are no copies to count until trades can be copied.',
  },
  walletConnect: {
    label: 'Wallet',
    needs: ['execution'],
    why: 'There is no wallet flow here yet: nothing in this frontend asks a provider for an '
      + 'address, a signature or a transaction. Connecting is only useful once there is '
      + 'something to sign for, which is execution.',
  },
  walletBalance: {
    label: 'Available',
    needs: ['execution'],
    why: 'Funding reads the copy wallet, which the execution backend creates.',
  },
  accountValue: {
    label: 'Account value',
    needs: ['transfer-index'],
    why: 'Most holdings here arrived by transfer, issuance or bridge, not by swap. '
      + 'Swaps alone would show a fraction of the account and call it the whole.',
  },
  holdings: {
    label: 'Holdings',
    needs: ['transfer-index'],
    why: 'Balances need every transfer. Cost basis for transferred-in units stays out '
      + 'of scope even then: there is no on-chain buy to read it from.',
  },
  roi: {
    label: 'Account ROI',
    needs: ['transfer-index'],
    why: 'A return needs the capital it was made on, net of deposits and withdrawals. '
      + 'Return on matched cost is shown instead where it fits: it is the return on the '
      + 'money that went through closed round-trips, which is not the same denominator.',
  },
  drawdown: {
    label: 'Account drawdown',
    needs: ['transfer-index'],
    why: 'Account drawdown is measured on account value over time, which needs balances '
      + 'over time. The realized drawdown shown beside it is a different figure: the '
      + 'deepest fall of the closed-round-trip curve, which holds no open position.',
  },
  sharpe: {
    label: 'Sharpe',
    needs: ['transfer-index', 'history'],
    why: 'Sharpe needs a daily return series on account value, and far more than seven '
      + 'days of it to mean anything.',
  },
  price: {
    label: 'Price',
    needs: ['asset-api'],
    why: 'The swap tape holds every trade price; nothing serves it per asset yet.',
  },
  volume24h: {
    label: '24H volume',
    needs: ['asset-api'],
    why: 'Computable from the swap tape; nothing serves it per asset yet.',
  },
  recentTrades: {
    label: 'Recent trades',
    needs: ['asset-api'],
    why: 'The trades are in the tape; nothing serves them per asset yet.',
  },
  holders: {
    label: 'Holders',
    needs: ['transfer-index'],
    why: 'A holder may never have swapped. Only transfers say who holds a token.',
  },
  avgEntry: {
    label: 'Avg entry',
    needs: ['transfer-index'],
    why: 'Entry prices exist only for units bought on-chain. Even with the index, '
      + 'transferred-in units have no entry, so this will be a partial figure and say so.',
  },
  inProfit: {
    label: 'Holders in profit',
    needs: ['transfer-index'],
    why: 'Needs every holder\'s balance and an entry price for it; the second is partial '
      + 'for the same reason as average entry.',
  },
};

/**
 * The element an unwired slot renders: the label, and what it needs. No number, ever.
 * @param {keyof typeof NEEDS} key
 * @param {{ compact?: boolean }} [opts]
 */
export function unwired(key, opts = {}) {
  const need = NEEDS[key];
  const el = document.createElement('div');
  el.className = opts.compact ? 'unwired unwired--compact' : 'unwired';
  el.dataset.needs = need.needs.join(' ');
  el.dataset.metric = String(key);
  const label = document.createElement('span');
  label.className = 'unwired-label';
  label.textContent = need.label;
  const what = document.createElement('span');
  what.className = 'unwired-needs';
  what.textContent = DEPENDENCIES[need.needs[0]];
  el.title = need.why;
  el.append(label, what);
  return el;
}
