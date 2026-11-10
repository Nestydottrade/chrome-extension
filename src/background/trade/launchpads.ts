import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { act as label } from './actions';
import { erc20Abi } from '../chain/abis';
import { findLeg, quoteLeg } from './legs';
import type {
  BuyParams,
  Funding,
  PoolRef,
  SellParams,
  Side,
  TxDraft,
  Venue,
  VenueCtx,
} from './types';
import type { PoolKey } from './uniswap/codec';
import { chainQuotes, poolIdOf } from './uniswap/venue';
import { virtualsVenue } from './virtuals';
import {
  isOwn,
  type ExtraContractRule,
  type TxToValidate,
  type ValidationContext,
} from './validator';

/**
 * Bonding-curve launchpads. A token is only routed here while it is still on its
 * curve; after graduation it trades on a DEX and the AMM venues pick it up. Curves quoted
 * in an ERC-20 the launchpad cannot buy with native itself are funded through the best
 * native ↔ asset AMM pool (`legs.ts`).
 *
 * Contract facts were verified on-chain: four.meme/Flap selectors are present in the
 * deployed bytecode, the Pons curve ABI is verified on the explorer, and every flow
 * (buy → approve → sell) was simulated against mainnet state.
 */

/** A quote asset's symbol for route labels (plain text, shortened). */
async function symbolOf(ctx: VenueCtx, asset: Address): Promise<string> {
  const s = await ctx.client
    .readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' })
    .catch(() => '');
  return s.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 12) || 'quote';
}

/** native → asset, then asset → token (buy); token → asset, then asset → native (sell). */
function fundedQuote(
  ctx: VenueCtx,
  leg: PoolRef,
  curve: (side: Side, amounts: readonly bigint[]) => Promise<(bigint | null)[]>,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const swap = (s: Side) => (a: readonly bigint[]) => quoteLeg(ctx, leg, s, a);
  const own = (s: Side) => (a: readonly bigint[]) => curve(s, a);
  return side === 'buy'
    ? chainQuotes(amounts, swap('buy'), own('buy'))
    : chainQuotes(amounts, own('sell'), swap('sell'));
}

// ── four.meme (BSC) ──────────────────────────────────────────────────────────

export const FOUR_TM: Address = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
export const FOUR_HELPER: Address = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';
/** four.meme trades token amounts in whole multiples of 1e9 units. */
const FOUR_UNIT = 10n ** 9n;

interface FourPool {
  /**
   * A curve quoted in a BEP-20 asset (USDT, USD1, tokenised stocks...). four.meme's helper
   * swaps BNB into that asset and back inside the same call; `leg` only prices that swap.
   */
  quote?: Address;
  leg?: PoolRef;
  /**
   * four.meme's own fee on each curve trade, in basis points of its cost (getTokenInfo's
   * tradingFeeRate: 1% on every token seen, with no minimum), in the quote asset.
   */
  feeBps: number;
  tax?: FourTax | undefined;
}

/**
 * A tax token's rates (its feeRateBuy / feeRateSell, in percent there) in basis points of
 * each trade's value, the curve's cost. Its token takes them in its pool; on the curve the
 * manager takes them itself, in the quote asset and on top of its fee: a buy of F puts
 * F / (1 + fee + tax) into the curve, a sell gets cost × (1 − fee − tax). tryBuy and trySell
 * count only the fee.
 */
interface FourTax {
  buyBps: number;
  sellBps: number;
}

const fourPool = (ref: PoolRef) => (ref.data ?? {}) as FourPool;

const fourAbi = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
  'function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) payable',
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)',
  'function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable',
  // The manager pulls the tokens from tx.origin: only ever sent by the wallet itself.
  'function sellForEth(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)',
]);

const fourRule: ExtraContractRule = {
  label: 'four.meme',
  approvalSpender: true,
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: fourAbi, data: tx.data });
    } catch {
      return [label('four.meme call', 'Unknown function')];
    }
    if (call.functionName === 'buyTokenAMAP') {
      const [token, to, funds, minAmount] = call.args;
      const l = 'four.meme buy';
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (!isOwn(ctx, to)) return [label(l, 'Recipient is not one of your wallets')];
      if (minAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== funds) return [label(l, 'Value does not match funds')];
      return [label(l)];
    }
    if (call.functionName === 'sellToken') {
      const [origin, token, , minFunds] = call.args;
      const l = 'four.meme sell';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (minFunds === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      return [label(l)];
    }
    return [label(`four.meme ${call.functionName}`, 'Not a trade')];
  },
};

const fourHelperRule: ExtraContractRule = {
  label: 'four.meme helper',
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: fourAbi, data: tx.data });
    } catch {
      return [label('four.meme helper call', 'Unknown function')];
    }
    if (call.functionName === 'buyWithEth') {
      const [origin, token, to, funds, minAmount] = call.args;
      const l = 'four.meme buy';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (!isOwn(ctx, to)) return [label(l, 'Recipient is not one of your wallets')];
      if (minAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (tx.value !== funds) return [label(l, 'Value does not match funds')];
      return [label(l)];
    }
    if (call.functionName === 'sellForEth') {
      const [origin, token, , minFunds, feeRate, feeRecipient] = call.args;
      const l = 'four.meme sell';
      if (origin !== 0n) return [label(l, 'Unexpected origin')];
      if (!ctx.token || !isAddressEqual(token, ctx.token)) return [label(l, 'Different token')];
      if (minFunds === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (feeRate !== 0n || feeRecipient !== zeroAddress)
        return [label(l, 'Pays a fee to a third party')];
      if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      return [label(l)];
    }
    return [label(`four.meme ${call.functionName}`, 'Not a trade')];
  },
};

/** A tax token's rates; an older one has a single feeRate for both. */
const fourTaxAbi = parseAbi([
  'function feeRateBuy() view returns (uint256)',
  'function feeRateSell() view returns (uint256)',
  'function feeRate() view returns (uint256)',
]);

/** tryBuy: tokens for an amount of the quote asset; trySell: quote asset for tokens. */
function fourInfo(ctx: VenueCtx, token: Address) {
  return ctx.client
    .readContract({
      address: FOUR_HELPER,
      abi: fourAbi,
      functionName: 'getTokenInfo',
      args: [token],
    })
    .catch(() => null);
}

/** getTokenInfo and, for a tax token, its rates, in one request. */
async function fourState(ctx: VenueCtx, token: Address) {
  const [info, buy, sell, one] = await ctx.client
    .multicall({
      allowFailure: true,
      contracts: [
        { address: FOUR_HELPER, abi: fourAbi, functionName: 'getTokenInfo', args: [token] },
        { address: token, abi: fourTaxAbi, functionName: 'feeRateBuy' },
        { address: token, abi: fourTaxAbi, functionName: 'feeRateSell' },
        { address: token, abi: fourTaxAbi, functionName: 'feeRate' },
      ],
    })
    .catch(() => []);
  if (info?.status !== 'success') return null;
  const rate = (r: typeof buy) => (r?.status === 'success' ? r.result : null);
  const [b, s, o] = [rate(buy), rate(sell), rate(one)];
  const buyPct = b ?? o ?? 0n;
  const sellPct = b === null ? (o ?? 0n) : (s ?? 0n);
  const feeBps = Number(info.result[4]);
  const tax: FourTax | undefined =
    (buyPct > 0n || sellPct > 0n) && buyPct <= 100n && sellPct <= 100n && feeBps < 10_000
      ? { buyBps: Number(buyPct) * 100, sellBps: Number(sellPct) * 100 }
      : undefined;
  return { info: info.result, feeBps, tax };
}

/** What tryBuy must be given for `funds` to price the curve's real share of them. */
const fundsForTryBuy = (funds: bigint, feeBps: number, t: FourTax) =>
  (funds * BigInt(10_000 + feeBps)) / BigInt(10_000 + feeBps + t.buyBps);

/** trySell's funds less the tax, which is on the trade's cost: funds plus fee. */
function afterSellTax(funds: bigint, fee: bigint, t: FourTax): bigint {
  const net = funds - ((funds + fee) * BigInt(t.sellBps)) / 10_000n;
  return net > 0n ? net : 0n;
}

async function fourCurveQuote(
  ctx: VenueCtx,
  ref: PoolRef,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const { token } = ref;
  const { feeBps, tax } = fourPool(ref);
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: amounts.map((a) =>
      side === 'buy'
        ? ({
            address: FOUR_HELPER,
            abi: fourAbi,
            functionName: 'tryBuy',
            args: [token, 0n, tax ? fundsForTryBuy(a, feeBps, tax) : a],
          } as const)
        : ({
            address: FOUR_HELPER,
            abi: fourAbi,
            functionName: 'trySell',
            args: [token, (a / FOUR_UNIT) * FOUR_UNIT],
          } as const),
    ),
  });
  return res.map((r) => {
    if (r.status !== 'success') return null;
    const v = r.result as readonly unknown[];
    const out = v[2] as bigint;
    return side === 'sell' && tax ? afterSellTax(out, v[3] as bigint, tax) : out;
  });
}

const fourVenue: Venue = {
  id: 'fourmeme',
  supports: (chainId) => chainId === 56,
  async discover(ctx, token) {
    const state = await fourState(ctx, token);
    if (!state) return [];
    const { info, feeBps, tax } = state;
    const [version, manager, quote, , , , , , , , , liquidityAdded] = info;
    if (version !== 2n || !isAddressEqual(manager, FOUR_TM) || liquidityAdded) return [];
    const id = `four:${token.toLowerCase()}`;
    if (quote === zeroAddress)
      return [
        {
          venueId: 'fourmeme',
          id,
          label: 'four.meme curve',
          token,
          data: { feeBps, tax } satisfies FourPool,
        },
      ];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    return [
      {
        venueId: 'fourmeme',
        id,
        label: `four.meme curve via ${await symbolOf(ctx, quote)}`,
        token,
        data: { quote, leg, feeBps, tax } satisfies FourPool,
      },
    ];
  },
  quote(ctx, ref, side, amounts) {
    const { leg } = fourPool(ref);
    const curve = (s: Side, a: readonly bigint[]) => fourCurveQuote(ctx, ref, s, a);
    return leg ? fundedQuote(ctx, leg, curve, side, amounts) : curve(side, amounts);
  },
  // Its token takes nothing itself before it moves to its pool (Token9 taxes only there): on
  // the curve the manager takes the rates, as venueTax.
  untaxedTransfers: true,
  // What the curve takes from each trade, all already in quotes and counted as tax: four.meme's
  // fee and a tax token's buy or sell rate.
  venueTax: async (_ctx, ref) => {
    const { feeBps, tax } = fourPool(ref);
    return { buyBps: feeBps + (tax?.buyBps ?? 0), sellBps: feeBps + (tax?.sellBps ?? 0) };
  },
  buildBuy(_ctx, ref, p) {
    if (fourPool(ref).quote)
      return {
        to: FOUR_HELPER,
        data: encodeFunctionData({
          abi: fourAbi,
          functionName: 'buyWithEth',
          args: [0n, ref.token, p.wallet, p.amountIn, p.minOut],
        }),
        value: p.amountIn,
      };
    return {
      to: FOUR_TM,
      data: encodeFunctionData({
        abi: fourAbi,
        functionName: 'buyTokenAMAP',
        args: [ref.token, p.wallet, p.amountIn, p.minOut],
      }),
      value: p.amountIn,
    };
  },
  buildSell(_ctx, ref, p) {
    const amount = (p.amountIn / FOUR_UNIT) * FOUR_UNIT;
    if (fourPool(ref).quote)
      return {
        to: FOUR_HELPER,
        data: encodeFunctionData({
          abi: fourAbi,
          functionName: 'sellForEth',
          args: [0n, ref.token, amount, p.minOut, 0n, zeroAddress],
        }),
        value: 0n,
      };
    return {
      to: FOUR_TM,
      data: encodeFunctionData({
        abi: fourAbi,
        functionName: 'sellToken',
        args: [0n, ref.token, amount, p.minOut],
      }),
      value: 0n,
    };
  },
  // A sold-out curve stops trading, and the token cannot move, until the manager adds
  // the PancakeSwap liquidity.
  async idle(ctx, token) {
    const info = await fourInfo(ctx, token);
    if (!info) return null;
    const [version, manager, , , , , , offers, , funds, maxFunds, liquidityAdded] = info;
    if (version !== 2n || !isAddressEqual(manager, FOUR_TM) || liquidityAdded) return null;
    return offers === 0n || funds >= maxFunds ? 'four.meme curve full · waiting for DEX' : null;
  },
  // The manager pulls the tokens either way.
  sellApproval: (_ctx, ref) => ({
    spender: FOUR_TM,
    viaPermit2: false,
    router: fourPool(ref).quote ? FOUR_HELPER : FOUR_TM,
  }),
  poolRules: (_ctx, ref) =>
    fourPool(ref).quote
      ? [
          [FOUR_TM, fourRule],
          [FOUR_HELPER, fourHelperRule],
        ]
      : [[FOUR_TM, fourRule]],
};

// ── Flap (BSC, Base, Robinhood) ──────────────────────────────────────────────

/** Portals per chain (Flap has redeployed on Base; older tokens stay on the old one). */
export const FLAP_PORTALS: Record<number, Address[]> = {
  56: ['0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0'],
  8453: [
    '0x0000bc1c4fd15dd79029af8f5d77d68ae4490000',
    '0x00214f8C22A076575f4B67f3B4AA62f99E166e36',
  ],
  4663: ['0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09'],
};

interface FlapPool {
  portal: Address;
  /**
   * Set for a curve quoted in an ERC-20 the portal cannot buy with native itself
   * (`nativeToQuoteSwapEnabled` false): it trades in that asset, funded through `leg`.
   */
  quote?: Address;
  symbol?: string;
  leg?: PoolRef;
}

const flapPool = (ref: PoolRef) => ref.data as FlapPool;
/** getTokenV3 status: 1 = trading on the curve. */
const FLAP_TRADABLE = 1;
/** Flap's fee on each curve trade (TokenBought / TokenSold `fee`: 1% of the trade's value). */
const FLAP_FEE_BPS = 100;
/**
 * getTokenV8Safe's version of an untaxed TokenV3: its curve takes no Flap fee but 1.25% for
 * its tax processor (TaxV2OnBondingCurvePaid), which shares it with Flap.
 */
const FLAP_UNTAXED_V3 = 7;
const FLAP_UNTAXED_V3_FEE_BPS = 125;

const flapAbi = parseAbi([
  'function getTokenV3(address token) view returns (uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 dexSupplyThresh, address quoteToken, bool nativeToQuoteSwapEnabled)',
  // The portal's record of a token: a tax token's buy and sell rates, for every token version.
  'function getTokenV8Safe(address token) view returns ((uint8 status, uint256 reserve, uint256 circulatingSupply, uint256 price, uint8 tokenVersion, uint256 r, uint256 h, uint256 k, uint256 dexSupplyThresh, address quoteTokenAddress, bool nativeToQuoteSwapEnabled, bytes32 extensionID, uint256 buyTaxRate, uint256 sellTaxRate, address pool, uint256 progress, uint8 lpFeeProfile, uint8 dexId))',
  'function quoteExactInput((address inputToken, address outputToken, uint256 inputAmount)) returns (uint256)',
  'function swapExactInput((address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, bytes permitData)) payable returns (uint256)',
]);

function flapRule(quote: Address | undefined): ExtraContractRule {
  // What the curve trades against: native (address 0) or the pool's ERC-20.
  const asset = quote ?? zeroAddress;
  return {
    label: 'Flap',
    approvalSpender: true,
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: flapAbi, data: tx.data });
      } catch {
        return [label('Flap call', 'Unknown function')];
      }
      if (call.functionName !== 'swapExactInput')
        return [label(`Flap ${call.functionName}`, 'Not a trade')];
      const [s] = call.args;
      const l = 'Flap swap';
      const isTok = (a: Address) => !!ctx.token && isAddressEqual(a, ctx.token);
      const buy = isAddressEqual(s.inputToken, asset) && isTok(s.outputToken);
      const sell = isTok(s.inputToken) && isAddressEqual(s.outputToken, asset);
      if (!buy && !sell) return [label(l, 'Unexpected assets')];
      if (s.permitData !== '0x') return [label(l, 'Embedded permits are not allowed')];
      if (s.minOutputAmount === 0n) return [label(l, 'No minimum output (no slippage protection)')];
      if (buy && tx.value !== (quote ? 0n : s.inputAmount))
        return [label(l, 'Value does not match input')];
      if (sell && tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
      // Output goes to msg.sender (the validated `from`).
      return [label(l)];
    },
  };
}

/** Curve quotes in the curve's own asset (native, or the pool's ERC-20). */
async function flapCurveQuote(
  ctx: VenueCtx,
  ref: PoolRef,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const { portal, quote } = flapPool(ref);
  const asset = quote ?? zeroAddress;
  const [inputToken, outputToken] = side === 'buy' ? [asset, ref.token] : [ref.token, asset];
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: amounts.map(
      (inputAmount) =>
        ({
          address: portal,
          abi: flapAbi,
          functionName: 'quoteExactInput',
          args: [{ inputToken, outputToken, inputAmount }],
        }) as const,
    ),
  });
  return res.map((r) => (r.status === 'success' ? (r.result as bigint) : null));
}

function flapSwap(ref: PoolRef, side: Side, p: BuyParams): TxDraft {
  const { portal, quote } = flapPool(ref);
  const asset = quote ?? zeroAddress;
  const [inputToken, outputToken] = side === 'buy' ? [asset, ref.token] : [ref.token, asset];
  return {
    to: portal,
    data: encodeFunctionData({
      abi: flapAbi,
      functionName: 'swapExactInput',
      args: [
        {
          inputToken,
          outputToken,
          inputAmount: p.amountIn,
          minOutputAmount: p.minOut,
          permitData: '0x',
        },
      ],
    }),
    value: side === 'buy' && !quote ? p.amountIn : 0n,
  };
}

const flapVenue: Venue = {
  id: 'flap',
  supports: (chainId) => chainId in FLAP_PORTALS,
  async discover(ctx, token) {
    const portals = FLAP_PORTALS[ctx.chain.id] ?? [];
    const infos = await Promise.all(
      portals.map((portal) =>
        ctx.client
          .readContract({
            address: portal,
            abi: flapAbi,
            functionName: 'getTokenV3',
            args: [token],
          })
          .catch(() => null),
      ),
    );
    const live = infos.map((info) => (info && info[0] === FLAP_TRADABLE ? info : null));
    const id = `flap:${token.toLowerCase()}`;
    // Native in and out: native-quoted, or the portal swaps native into the quote itself.
    const direct = live.findIndex((i) => !!i && (i[7] === zeroAddress || i[8]));
    const directPortal = portals[direct];
    if (directPortal) {
      const data: FlapPool = { portal: directPortal };
      return [{ venueId: 'flap', id, label: 'Flap curve', token, data }];
    }
    const at = live.findIndex((i) => !!i);
    const info = live[at];
    const portal = portals[at];
    if (!info || !portal) return [];
    const quote = info[7];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    const symbol = await symbolOf(ctx, quote);
    return [
      {
        venueId: 'flap',
        id,
        label: `Flap curve via ${symbol}`,
        token,
        data: { portal, quote, symbol, leg } satisfies FlapPool,
      },
    ];
  },
  /**
   * What the curve takes from each trade, all already in its quotes and counted as tax: Flap's
   * fee and a tax token's buy or sell rate, in the quote asset (the token itself only taxes its
   * pool), or an untaxed TokenV3's fee. Read from the portal, which keeps the rates for every
   * token version; the oldest tax tokens have no getter of their own for them.
   */
  // Every token kind transfers untaxed on its curve: the portal takes it all, as venueTax.
  untaxedTransfers: true,
  async venueTax(ctx, ref) {
    const s = await ctx.client.readContract({
      address: flapPool(ref).portal,
      abi: flapAbi,
      functionName: 'getTokenV8Safe',
      args: [ref.token],
    });
    if (s.tokenVersion === FLAP_UNTAXED_V3)
      return { buyBps: FLAP_UNTAXED_V3_FEE_BPS, sellBps: FLAP_UNTAXED_V3_FEE_BPS };
    const rate = (bps: bigint) => Number(bps < 10_000n ? bps : 10_000n);
    return {
      buyBps: FLAP_FEE_BPS + rate(s.buyTaxRate),
      sellBps: FLAP_FEE_BPS + rate(s.sellTaxRate),
    };
  },
  quote(ctx, ref, side, amounts) {
    const { leg } = flapPool(ref);
    const curve = (s: Side, a: readonly bigint[]) => flapCurveQuote(ctx, ref, s, a);
    return leg ? fundedQuote(ctx, leg, curve, side, amounts) : curve(side, amounts);
  },
  // On a funded pool, amounts are in the quote asset (buy) or tokens (sell).
  buildBuy: (_ctx, ref, p) => flapSwap(ref, 'buy', p),
  buildSell: (_ctx, ref, p) => flapSwap(ref, 'sell', p),
  sellApproval: (_ctx, ref) => {
    const { portal } = flapPool(ref);
    return { spender: portal, viaPermit2: false, router: portal };
  },
  funding(_ctx, ref): Funding | undefined {
    const { quote, symbol, leg } = flapPool(ref);
    if (!quote || !leg) return undefined;
    return {
      asset: quote,
      symbol: symbol ?? 'quote',
      leg,
      quoteAsset: (ctx, side, amounts) => flapCurveQuote(ctx, ref, side, amounts),
    };
  },
  poolRules: (_ctx, ref) => {
    const { portal, quote } = flapPool(ref);
    return [[portal, flapRule(quote)]];
  },
};

// ── Pons (Robinhood Chain) ───────────────────────────────────────────────────

export const PONS_FACTORY: Address = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

const ponsTokenAbi = parseAbi(['function curve() view returns (address)']);
const ponsCurveAbi = parseAbi([
  'function token() view returns (address)',
  'function factory() view returns (address)',
  'function graduated() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);

interface PonsPool {
  curve: Address;
  /** Set for a curve quoted in an ERC-20 (e.g. USDG): it trades in that asset, funded through `leg`. */
  quote?: Address;
  symbol?: string;
  leg?: PoolRef;
}

function ponsRule(nativeQuote: boolean): ExtraContractRule {
  return {
    label: 'Pons curve',
    approvalSpender: true,
    validate(tx, ctx) {
      let call;
      try {
        call = decodeFunctionData({ abi: ponsCurveAbi, data: tx.data });
      } catch {
        return [label('Pons call', 'Unknown function')];
      }
      if (call.functionName === 'buy') {
        const [quoteIn, minOut, recipient] = call.args;
        const l = 'Pons buy';
        if (!isOwn(ctx, recipient)) return [label(l, 'Recipient is not one of your wallets')];
        if (minOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
        if (tx.value !== (nativeQuote ? quoteIn : 0n))
          return [label(l, 'Value does not match input')];
        return [label(l)];
      }
      if (call.functionName === 'sell') {
        const [, minOut, recipient] = call.args;
        const l = 'Pons sell';
        if (!isOwn(ctx, recipient)) return [label(l, 'Recipient is not one of your wallets')];
        if (minOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
        if (tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
        return [label(l)];
      }
      return [label(`Pons ${call.functionName}`, 'Not a trade')];
    },
  };
}

/** Constant product on the curve's (virtual) reserves, after fee + taxes. */
function ponsQuote(
  side: Side,
  amountIn: bigint,
  quoteReserve: bigint,
  tokenReserve: bigint,
  totalFeeBps: bigint,
): bigint {
  if (amountIn <= 0n || quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  if (side === 'buy') {
    const net = (amountIn * (10_000n - totalFeeBps)) / 10_000n;
    return (tokenReserve * net) / (quoteReserve + net);
  }
  const gross = (quoteReserve * amountIn) / (tokenReserve + amountIn);
  return (gross * (10_000n - totalFeeBps)) / 10_000n;
}

/** Curve quotes in the curve's own asset (native, or the pool's ERC-20). */
async function ponsCurveQuote(
  ctx: VenueCtx,
  curve: Address,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const [res, fee, tax, snipe] = await ctx.client.multicall({
    allowFailure: false,
    contracts: [
      { address: curve, abi: ponsCurveAbi, functionName: 'getReserves' },
      { address: curve, abi: ponsCurveAbi, functionName: 'feeBps' },
      { address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' },
      {
        address: curve,
        abi: ponsCurveAbi,
        functionName: 'currentSnipeTaxBps',
        args: [zeroAddress],
      },
    ],
  });
  const [q, t] = res as readonly [bigint, bigint];
  const totalFee = (fee as bigint) + (tax as bigint) + (snipe as bigint);
  return amounts.map((a) => ponsQuote(side, a, q, t, totalFee));
}

const ponsVenue: Venue = {
  id: 'pons',
  supports: (chainId) => chainId === 4663,
  async discover(ctx, token) {
    const curve = await ctx.client
      .readContract({ address: token, abi: ponsTokenAbi, functionName: 'curve' })
      .catch(() => null);
    if (!curve || curve === zeroAddress) return [];
    const r = await ctx.client.multicall({
      allowFailure: true,
      contracts: [
        { address: curve, abi: ponsCurveAbi, functionName: 'token' },
        { address: curve, abi: ponsCurveAbi, functionName: 'factory' },
        { address: curve, abi: ponsCurveAbi, functionName: 'graduated' },
        { address: curve, abi: ponsCurveAbi, functionName: 'isNativeQuote' },
        { address: curve, abi: ponsCurveAbi, functionName: 'pairToken' },
      ],
    });
    const [t, f, g, n, q] = r.map((x) => (x.status === 'success' ? x.result : null));
    if (!t || !isAddressEqual(t as Address, token)) return [];
    if (!f || !isAddressEqual(f as Address, PONS_FACTORY)) return [];
    if (g !== false || typeof n !== 'boolean') return [];
    const id = `pons:${curve.toLowerCase()}`;
    if (n) {
      const data: PonsPool = { curve };
      return [{ venueId: 'pons', id, label: 'Pons curve', token, data }];
    }
    const quote = q as Address | null;
    if (!quote || quote === zeroAddress) return [];
    const leg = await findLeg(ctx, quote);
    if (!leg) return [];
    const symbol = await symbolOf(ctx, quote);
    return [
      {
        venueId: 'pons',
        id,
        label: `Pons curve via ${symbol}`,
        token,
        data: { curve, quote, symbol, leg } satisfies PonsPool,
      },
    ];
  },
  quote(ctx, ref, side, amounts) {
    const { curve, leg } = ref.data as PonsPool;
    const own = (s: Side, a: readonly bigint[]) => ponsCurveQuote(ctx, curve, s, a);
    return leg ? fundedQuote(ctx, leg, own, side, amounts) : own(side, amounts);
  },
  // On a funded pool, amounts are in the quote asset (buy) or tokens (sell).
  buildBuy(_ctx, ref, p) {
    const { curve, quote } = ref.data as PonsPool;
    return {
      to: curve,
      data: encodeFunctionData({
        abi: ponsCurveAbi,
        functionName: 'buy',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: quote ? 0n : p.amountIn,
    };
  },
  buildSell(_ctx, ref, p) {
    const { curve } = ref.data as PonsPool;
    return {
      to: curve,
      data: encodeFunctionData({
        abi: ponsCurveAbi,
        functionName: 'sell',
        args: [p.amountIn, p.minOut, p.wallet],
      }),
      value: 0n,
    };
  },
  sellApproval: (_ctx, ref) => {
    const { curve } = ref.data as PonsPool;
    return { spender: curve, viaPermit2: false, router: curve };
  },
  funding(_ctx, ref): Funding | undefined {
    const { curve, quote, symbol, leg } = ref.data as PonsPool;
    if (!quote || !leg) return undefined;
    return {
      asset: quote,
      symbol: symbol ?? 'quote',
      leg,
      quoteAsset: (ctx, side, amounts) => ponsCurveQuote(ctx, curve, side, amounts),
    };
  },
  async venueTax(ctx, ref) {
    const { curve } = ref.data as PonsPool;
    const [fee, tax, snipe] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: curve, abi: ponsCurveAbi, functionName: 'feeBps' },
        { address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' },
        {
          address: curve,
          abi: ponsCurveAbi,
          functionName: 'currentSnipeTaxBps',
          args: [zeroAddress],
        },
      ],
    });
    // All three apply to either side (see quote()). The platform fee is counted too, as
    // terminals such as GMGN show it in the total.
    const bps = Number((fee as bigint) + (tax as bigint) + (snipe as bigint));
    return { buyBps: bps, sellBps: bps };
  },
  poolRules: (_ctx, ref) => {
    const { curve, quote } = ref.data as PonsPool;
    return [[curve, ponsRule(!quote)]];
  },
};

// ── Montra (Elysium) ─────────────────────────────────────────────────────────

/**
 * Montra has no curve: a coin trades for life in one Uniswap v4 pool carrying Montra's
 * hook, its whole supply seeded as a single position. The hook takes the pool's fee (1 to
 * 10%, more on buys in an anti-snipe window) inside the swap, and the token itself has
 * no tax. Trades go through Montra's LaunchRouter: one exact-input swap with a minimum,
 * a recipient and a deadline, native HYPE sent as value, a sale approved to the router.
 * ABIs from Montra's published contracts; the flows were simulated against mainnet.
 */
export const MONTRA_FACTORY: Address = '0x38D3ef3A06D18fA3286Fb5dEAfe611be725fcD15';
export const MONTRA_ROUTER: Address = '0xc6E9a8E1a99023B67067B8A3605403b8d7B3A157';
/** The hooks Montra's registry lists (`hooks()`); a pool with any other hook is not Montra's. */
export const MONTRA_HOOKS: readonly Address[] = ['0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC'];
const MONTRA_CHAIN = 99901;
/** Every Montra key has the dynamic-fee flag (the hook sets the fee) and its quote's spacing. */
const MONTRA_FEE = 0x800000;
const MONTRA_SPACINGS = [200, 100, 60, 10, 1];
const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_DEADLINE_S = 30 * 60;

const montraTokenAbi = parseAbi([
  'function factory() view returns (address)',
  'function hook() view returns (address)',
  'function poolId() view returns (bytes32)',
  'function buyTaxRate() view returns (uint256)',
  'function sellTaxRate() view returns (uint256)',
]);
const montraRouterAbi = parseAbi([
  'function quoteExactIn((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn) returns (uint256)',
  'function swapExactIn(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient, uint256 deadline) s) payable returns (uint256)',
]);

interface MontraPool {
  key: PoolKey;
}

const isMontraHook = (a: Address) => MONTRA_HOOKS.some((h) => isAddressEqual(h, a));

const montraRule: ExtraContractRule = {
  label: 'Montra router',
  approvalSpender: true,
  validate(tx, ctx) {
    let call;
    try {
      call = decodeFunctionData({ abi: montraRouterAbi, data: tx.data });
    } catch {
      return [label('Montra call', 'Unknown function')];
    }
    if (call.functionName !== 'swapExactIn')
      return [label(`Montra ${call.functionName}`, 'Not a trade')];
    const [s] = call.args;
    const buy = s.zeroForOne;
    const l = buy ? 'Montra buy' : 'Montra sell';
    if (!isMontraHook(s.key.hooks)) return [label(l, 'Not a Montra pool')];
    if (!isAddressEqual(s.key.currency0, zeroAddress))
      return [label(l, 'Pool is not paired with native')];
    if (ctx.token && !isAddressEqual(s.key.currency1, ctx.token))
      return [label(l, 'Pool is not the token being traded')];
    if (!isOwn(ctx, s.recipient)) return [label(l, 'Recipient is not one of your wallets')];
    if (s.minAmountOut === 0n) return [label(l, 'No minimum output (no slippage protection)')];
    if (s.deadline < BigInt(ctx.nowS) || s.deadline > BigInt(ctx.nowS + MAX_DEADLINE_S))
      return [label(l, 'Deadline out of range')];
    if (buy && tx.value !== s.amountIn) return [label(l, 'Value does not match input')];
    if (!buy && tx.value !== 0n) return [label(l, 'Sell must not carry native value')];
    return [label(l)];
  },
};

function montraSwap(ref: PoolRef, zeroForOne: boolean, p: BuyParams): TxDraft {
  const { key } = ref.data as MontraPool;
  return {
    to: MONTRA_ROUTER,
    data: encodeFunctionData({
      abi: montraRouterAbi,
      functionName: 'swapExactIn',
      args: [
        {
          key,
          zeroForOne,
          amountIn: p.amountIn,
          minAmountOut: p.minOut,
          recipient: p.wallet,
          deadline: p.deadline,
        },
      ],
    }),
    value: zeroForOne ? p.amountIn : 0n,
  };
}

export const montraVenue: Venue = {
  id: 'montra',
  supports: (chainId) => chainId === MONTRA_CHAIN,
  async discover(ctx, token) {
    const r = await ctx.client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: montraTokenAbi, functionName: 'factory' },
        { address: token, abi: montraTokenAbi, functionName: 'hook' },
        { address: token, abi: montraTokenAbi, functionName: 'poolId' },
      ],
    });
    const [factory, hook, poolId] = r.map((x) => (x.status === 'success' ? x.result : null));
    if (typeof factory !== 'string' || !isAddressEqual(factory as Address, MONTRA_FACTORY))
      return [];
    if (typeof hook !== 'string' || !isMontraHook(hook as Address)) return [];
    if (typeof poolId !== 'string') return [];
    // Native-quoted pools only: HYPE (address 0) is always currency0, and the key is
    // proved by hashing it to the token's own pool id. A pool quoted in KNTQ would need
    // a native ↔ KNTQ leg, and Elysium's deep ones are v4 pools, which legs leave out.
    const key = MONTRA_SPACINGS.map((tickSpacing): PoolKey => ({
      currency0: zeroAddress,
      currency1: token,
      fee: MONTRA_FEE,
      tickSpacing,
      hooks: hook as Address,
    })).find((k) => poolIdOf(k) === poolId.toLowerCase());
    if (!key) return [];
    const data: MontraPool = { key };
    return [
      { venueId: 'montra', id: `montra:${poolId.toLowerCase()}`, label: 'Montra', token, data },
    ];
  },
  async quote(ctx, ref, side, amounts) {
    const { key } = ref.data as MontraPool;
    const usable = amounts.map((a) => a > 0n && a <= MAX_UINT128);
    const asked = amounts.filter((_, i) => usable[i]);
    if (asked.length === 0) return amounts.map(() => null);
    // quoteExactIn runs the swap inside the PoolManager and undoes it: not a view, so an
    // eth_call. Its answer is what swapExactIn then pays, every fee included.
    const r = await ctx.client.multicall({
      allowFailure: true,
      contracts: asked.map((a) => ({
        address: MONTRA_ROUTER,
        abi: montraRouterAbi,
        functionName: 'quoteExactIn' as const,
        args: [key, side === 'buy', a] as const,
      })),
    });
    let next = 0;
    return usable.map((ok) => {
      if (!ok) return null;
      const x = r[next++];
      return x?.status === 'success' ? x.result : null;
    });
  },
  buildBuy: (_ctx, ref, p) => montraSwap(ref, true, p),
  buildSell: (_ctx, ref, p) => montraSwap(ref, false, p),
  sellApproval: () => ({ spender: MONTRA_ROUTER, viaPermit2: false, router: MONTRA_ROUTER }),
  async venueTax(ctx, ref) {
    // The token reads its pool's rates in basis points, rounded up: a buy's is higher
    // inside an anti-snipe window. The protocol's part is in both, as terminals show it.
    const [buy, sell] = await ctx.client.multicall({
      allowFailure: false,
      contracts: [
        { address: ref.token, abi: montraTokenAbi, functionName: 'buyTaxRate' },
        { address: ref.token, abi: montraTokenAbi, functionName: 'sellTaxRate' },
      ],
    });
    return { buyBps: Number(buy), sellBps: Number(sell) };
  },
  untaxedTransfers: true,
  poolRules: () => [[MONTRA_ROUTER, montraRule]],
};

export const launchpadVenues: Venue[] = [
  fourVenue,
  flapVenue,
  ponsVenue,
  virtualsVenue,
  montraVenue,
];

/** Static rules (none: launchpad rules come with the pool via Venue.poolRules). */
export function launchpadRules(chainId: number): ReadonlyMap<string, ExtraContractRule> {
  void chainId;
  return new Map();
}

export type { BuyParams, PoolRef, SellParams, TxDraft, TxToValidate, ValidationContext, VenueCtx };
