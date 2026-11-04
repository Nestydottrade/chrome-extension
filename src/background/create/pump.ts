import type { SolAddress } from '../../shared/solana';
import {
  ATA_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL_MINT,
  addressBytes,
  associatedTokenAddress,
  findProgramAddress,
  seed,
} from '../solana/address';
import {
  ALL_FEES,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  SOL_QUOTE,
  bondingCurveAddress,
  buyInstructions,
  curveBuyQuote,
  pumpEventAuthority,
  type CurveVenue,
  type FeeConfig,
  type LaunchTerms,
  type PumpGlobal,
  type PumpRoute,
  type TradeRecipients,
} from '../solana/pump';
import { concat, meta, u32, u64, type Instruction } from '../solana/tx';

/**
 * A new pump.fun coin: create_v2 (a Token-2022 coin on a SOL curve, no mayhem mode,
 * pump.fun's default fees), then the dev buy in the same transaction, on the curve exactly
 * as create_v2 leaves it. The website builds it to send; the extension builds it again
 * from the same intent and Global to check what it signs.
 */

export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
const CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180];
/** pump.fun coins have 6 decimals. */
export const PUMP_DECIMALS = 6;

const mintAuthority = () => findProgramAddress([seed('mint-authority')], PUMP_PROGRAM);
const mayhemGlobalParams = () => findProgramAddress([seed('global-params')], MAYHEM_PROGRAM);
const mayhemSolVault = () => findProgramAddress([seed('sol-vault')], MAYHEM_PROGRAM);
const mayhemState = (mint: SolAddress) =>
  findProgramAddress([seed('mayhem-state'), mint], MAYHEM_PROGRAM);

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(u32(bytes.length), bytes);
}

export interface PumpCreate {
  user: SolAddress;
  mint: SolAddress;
  name: string;
  symbol: string;
  uri: string;
}

/** The create_v2 instruction: `user` pays, signs and is the coin's creator. */
export function createV2Instruction(p: PumpCreate): Instruction {
  const curve = bondingCurveAddress(p.mint);
  return {
    programId: PUMP_PROGRAM,
    keys: [
      meta(p.mint, true, true),
      meta(mintAuthority()),
      meta(curve, true),
      meta(associatedTokenAddress(curve, p.mint, TOKEN_2022_PROGRAM), true),
      meta(PUMP_GLOBAL),
      meta(p.user, true, true),
      meta(SYSTEM_PROGRAM),
      meta(TOKEN_2022_PROGRAM),
      meta(ATA_PROGRAM),
      meta(MAYHEM_PROGRAM, true),
      meta(mayhemGlobalParams()),
      meta(mayhemSolVault(), true),
      meta(mayhemState(p.mint), true),
      meta(associatedTokenAddress(mayhemSolVault(), p.mint, TOKEN_2022_PROGRAM), true),
      meta(pumpEventAuthority()),
      meta(PUMP_PROGRAM),
    ],
    data: concat(
      CREATE_V2,
      borshString(p.name),
      borshString(p.symbol),
      borshString(p.uri),
      addressBytes(p.user),
      // is_mayhem_mode, is_cashback_enabled, creator_fee_bps (pump.fun's own), is_holder_reward.
      [0, 0],
      u64(0n),
      [0],
    ),
  };
}

/** The curve create_v2 leaves for `mint`, as a route for its dev buy. */
export function freshRoute(
  mint: SolAddress,
  creator: SolAddress,
  global: PumpGlobal,
  terms: LaunchTerms,
  feeConfig: FeeConfig,
): PumpRoute {
  const venue: CurveVenue = {
    kind: 'curve',
    mint,
    tokenProgram: TOKEN_2022_PROGRAM,
    quote: SOL_QUOTE,
    curve: {
      virtualTokenReserves: terms.initialVirtualTokenReserves,
      virtualQuoteReserves: terms.initialVirtualSolReserves,
      realTokenReserves: terms.initialRealTokenReserves,
      realQuoteReserves: 0n,
      tokenTotalSupply: terms.tokenTotalSupply,
      complete: false,
      creator,
      isMayhemMode: false,
      isCashbackCoin: false,
      quoteMint: WSOL_MINT,
      creatorFeeBps: 0n,
    },
    // The curve holds the whole supply until the first buy.
    curveTokenBalance: terms.tokenTotalSupply,
    global,
    feeConfig,
    mintSupply: terms.tokenTotalSupply,
  };
  return { pay: SOL_QUOTE, hops: [venue] };
}

/** What a dev buy of `lamports` takes off the fresh curve; 0 when it would sell it out. */
export function devBuyQuote(route: PumpRoute, lamports: bigint): bigint {
  const v = route.hops[0];
  return v?.kind === 'curve' ? curveBuyQuote(v, lamports, ALL_FEES, false) : 0n;
}

/** The coin's create_v2, then (with a dev buy) its account and the buy on its curve. */
export function createInstructions(
  p: PumpCreate & { devBuy: bigint; minOut: bigint },
  route: PumpRoute,
  rec: TradeRecipients | null,
): Instruction[] {
  const create = createV2Instruction(p);
  if (p.devBuy === 0n) return [create];
  if (!rec) throw new Error('A dev buy needs its fee recipients.');
  return [create, ...buyInstructions(route, p.user, p.devBuy, p.minOut, rec).instructions];
}
