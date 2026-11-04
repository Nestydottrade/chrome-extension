import { formatUnits, parseUnits } from 'viem';
import type { SendPrep, SolRecipientCheck, SolRecipientKind } from '../../shared/messages';
import type { TicketLeg, TradeTicket } from '../../shared/panel';
import {
  solanaPriorityFee,
  type GlobalSettings,
  type SolanaSettings,
} from '../../shared/settings/defaults';
import { SOLANA, SOLANA_CHAIN_ID, type SolAddress } from '../../shared/solana';
import { TradeError } from '../trade/engine/core';
import {
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  addressBytes,
  associatedTokenAddress,
  isOnCurve,
} from './address';
import { EXT, decodeTokenAccount } from './layouts';
import { isTokenProgram } from './pump';
import type { AccountInfo, SolRpc } from './rpc';
import type { SolanaDeps, SolanaService, SolTokenMeta, SolWallet } from './service';
import { createAtaIdempotent, transfer, transferChecked } from './spl';
import type { Instruction } from './tx';
import { validateSolanaTransfer, type SolTransferContext } from './validator';

/** Base fee of a transaction with one signature. */
const BASE_FEE = 5_000n;
/** Compute units to ask for before simulating: a SOL transfer, a token one opening an account. */
export const SOL_UNITS = 1_000;
export const TOKEN_UNITS = 80_000;
/** How long a rent exemption read from the chain is reused. */
const RENT_TTL_MS = 10 * 60_000;

/**
 * Size of the token account the associated token program opens: 165 bytes; under
 * Token-2022 also the account type and an ImmutableOwner entry (170), and the entries some
 * mint extensions require of every account (of the tokens Nesty sends, only Pausable's).
 */
export function tokenAccountSize(program: SolAddress, extensions: readonly number[] = []): number {
  if (program !== TOKEN_2022_PROGRAM) return 165;
  return 170 + (extensions.includes(EXT.pausable) ? 4 : 0);
}

const sol = (lamports: bigint) => formatUnits(lamports, SOLANA.nativeCurrency.decimals);

/** An amount of SOL as typed: at most 9 decimals. */
export const SOL_AMOUNT = /^\d{1,12}(\.\d{1,9})?$/;

/**
 * What one of these transactions costs: the base fee and the priority fee. runLeg prices
 * compute so the priority fee comes to exactly this, which lets a wallet send all it has.
 */
export const networkFee = (ss: SolanaSettings): bigint =>
  BASE_FEE + parseUnits(solanaPriorityFee(ss), SOLANA.nativeCurrency.decimals);

/**
 * Whether a wallet holding `lamports` can send `value` of its SOL: null when it can, or
 * why not. Solana takes the fee first and checks the balance then, and again after the
 * transfer: each time it must be zero or at least `minBalance`, the rent exemption.
 */
export function solSendBlock(
  lamports: bigint,
  value: bigint,
  fee: bigint,
  minBalance: bigint,
): string | null {
  const left = lamports - value - fee;
  if (left < 0n) return 'Amount plus fee is more than the balance.';
  if (left > 0n && left < minBalance)
    return `Send everything, or leave at least ${sol(minBalance)} SOL: Solana closes a wallet below that.`;
  // Emptying it: what the fee leaves must still be allowed, for the transfer to take.
  if (left === 0n && value < minBalance)
    return `Too little to empty this wallet: that takes at least ${sol(minBalance + fee)} SOL.`;
  return null;
}

/** Why Nesty cannot send this token: Token-2022 rules a plain transfer cannot follow. */
export function sendBlock(meta: SolTokenMeta): string | null {
  const ext = meta.extensions ?? [];
  if (ext.includes(EXT.nonTransferable)) return `${meta.symbol} cannot be transferred.`;
  if (ext.includes(EXT.transferHook))
    return `Nesty cannot send ${meta.symbol}: it runs a program of its own on every transfer.`;
  if (ext.includes(EXT.transferFeeConfig))
    return `Nesty cannot send ${meta.symbol}: it takes a fee on every transfer.`;
  return null;
}

/** What an address is on chain, from its account (null when it holds nothing). */
export function recipientKind(
  to: SolAddress,
  acc: AccountInfo | null,
): { kind: SolRecipientKind; owner: SolAddress | null } {
  // An address off the curve has no private key: only a program can move what it holds.
  if (!acc)
    return { kind: isOnCurve(addressBytes(to)) ? 'unused' : 'program-account', owner: null };
  if (acc.executable) return { kind: 'program', owner: null };
  if (acc.owner === SYSTEM_PROGRAM) return { kind: 'wallet', owner: null };
  if (isTokenProgram(acc.owner)) {
    // A token account is 165 bytes; under Token-2022 longer, with account type 2 at 165.
    const d = acc.data;
    if (d.length === 165 || (d.length > 165 && d[165] === 2))
      return { kind: 'token-account', owner: decodeTokenAccount(d)?.owner ?? null };
    return { kind: 'mint', owner: null };
  }
  return { kind: 'program-account', owner: null };
}

/** Kinds funds are lost at: Nesty refuses to send to them. */
export const LOSING: ReadonlySet<SolRecipientKind> = new Set(['program', 'mint', 'token-account']);

/** Send, distribute and collect on Solana, through the service's leg pipeline. */
export class SolTransferFlow {
  private readonly rents = new Map<number, { at: number; lamports: bigint }>();

  constructor(
    private readonly core: SolanaService,
    private readonly d: SolanaDeps,
  ) {}

  /**
   * The least an account of `size` bytes may hold other than nothing (its rent exemption),
   * read from the chain: Solana lowers it now and then. In October 2026 a wallet's was
   * 650,240 lamports, down from 890,880.
   */
  async rentExempt(rpc: SolRpc, size: number): Promise<bigint> {
    const hit = this.rents.get(size);
    if (hit && this.d.now() - hit.at < RENT_TTL_MS) return hit.lamports;
    const lamports = await rpc.minimumBalance(size);
    this.rents.set(size, { at: this.d.now(), lamports });
    return lamports;
  }

  /** The network fee, and the most a wallet can send of SOL or a token. */
  async sendPrep(req: { walletId: string; mint?: SolAddress | undefined }): Promise<SendPrep> {
    const ss = await this.d.settings.getSolana();
    const [wallet] = await this.core.tradeWallets([req.walletId]);
    const w = wallet as SolWallet;
    const rpc = this.core.rpcFor(ss);
    const fee = networkFee(ss);
    if (req.mint) {
      const meta = await this.core.tokenMeta(req.mint);
      if (!meta) throw new TradeError('not_found', 'Not a token on Solana.');
      const acc = await rpc.getAccount(
        associatedTokenAddress(w.solana, req.mint, meta.tokenProgram),
      );
      const held = (acc && decodeTokenAccount(acc.data)?.amount) ?? 0n;
      return { feeWei: fee.toString(), maxAmount: held.toString() };
    }
    // All of it may go: an empty wallet is allowed, unlike one below the rent exemption.
    // Unless what the fee leaves is already below it: then nothing can be sent at all.
    const [balance, minBalance] = await Promise.all([
      rpc.getBalance(w.solana),
      this.rentExempt(rpc, 0),
    ]);
    const max = balance - fee;
    return {
      feeWei: fee.toString(),
      maxAmount: (max >= minBalance ? max : 0n).toString(),
      minBalance: minBalance.toString(),
    };
  }

  /** Facts about a typed recipient, shown as checks in the Send form. */
  async checkRecipient(
    req: { to: SolAddress; mint?: SolAddress | undefined },
    history: readonly TradeTicket[],
  ): Promise<SolRecipientCheck> {
    const ss = await this.d.settings.getSolana();
    const rpc = this.core.rpcFor(ss);
    const meta = req.mint ? await this.core.tokenMeta(req.mint) : null;
    const [wallets, [acc, ata]] = await Promise.all([
      this.core.solWallets(),
      rpc.getMultipleAccounts([
        req.to,
        ...(meta && req.mint ? [associatedTokenAddress(req.to, req.mint, meta.tokenProgram)] : []),
      ]),
    ]);
    const { kind, owner } = recipientKind(req.to, acc ?? null);
    const mintSymbol =
      kind === 'mint'
        ? ((await this.core.tokenMeta(req.to).catch(() => null))?.symbol ?? null)
        : null;
    return {
      ownName: wallets.find((a) => a.solana === req.to)?.name ?? null,
      kind,
      owner,
      mintSymbol,
      sentBefore: history.some(
        (t) =>
          t.status === 'done' &&
          (t.kind === 'send'
            ? t.chainId === SOLANA_CHAIN_ID && t.recipient === req.to
            : t.kind === 'bridge' &&
              t.bridge?.toChainId === SOLANA_CHAIN_ID &&
              t.bridge.recipient === req.to),
      ),
      ...(meta
        ? {
            tokenAccountRent: ata
              ? '0'
              : (
                  await this.rentExempt(rpc, tokenAccountSize(meta.tokenProgram, meta.extensions))
                ).toString(),
          }
        : {}),
    };
  }

  /**
   * Sends SOL or a token to an outside address typed in the popup. Not reachable from the
   * trading panel. Above the confirmation threshold (or when the value is unknown) the
   * password is required again.
   */
  async send(req: {
    walletId: string;
    to: SolAddress;
    mint?: SolAddress | undefined;
    amount: string;
    password?: string | undefined;
  }): Promise<TradeTicket> {
    const startedAt = this.d.now();
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const [wallet] = await this.core.tradeWallets([req.walletId]);
    const w = wallet as SolWallet;
    if (req.to === w.solana)
      throw new TradeError('blocked', 'This is the wallet you are sending from.');
    const solUsd = await this.solUsd();

    let meta: SolTokenMeta | null = null;
    let value: bigint;
    let usd: number | null;
    if (req.mint) {
      meta = await this.core.tokenMeta(req.mint);
      if (!meta) throw new TradeError('not_found', 'Not a token on Solana.');
      const block = sendBlock(meta);
      if (block) throw new TradeError('blocked', block);
      value = parseUnits(req.amount, meta.decimals);
      const price = await this.core.tokenUsd(req.mint, gs.usePoolIndex).catch(() => null);
      usd = price !== null ? Number(formatUnits(value, meta.decimals)) * price : null;
    } else {
      value = parseUnits(req.amount, SOLANA.nativeCurrency.decimals);
      usd = Number(sol(value)) * solUsd;
    }
    if (value <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');

    if (usd === null || usd > gs.confirmAboveUsd) {
      if (!req.password)
        throw new TradeError('needs_password', usd === null ? '' : `${usd.toFixed(2)}`);
      await this.d.vault.verifyPassword(req.password);
    }

    const rpc = this.core.rpcFor(ss);
    const fee = networkFee(ss);
    const program = meta?.tokenProgram;
    const [[own, toAcc, fromAta, toAta], minBalance] = await Promise.all([
      rpc.getMultipleAccounts([
        w.solana,
        req.to,
        ...(req.mint && program
          ? [
              associatedTokenAddress(w.solana, req.mint, program),
              associatedTokenAddress(req.to, req.mint, program),
            ]
          : []),
      ]),
      this.rentExempt(rpc, 0),
    ]);
    const { kind } = recipientKind(req.to, toAcc ?? null);
    if (LOSING.has(kind))
      throw new TradeError('blocked', 'This address is not a wallet: funds sent there are lost.');
    const lamports = own?.lamports ?? 0n;

    let instructions: Instruction[];
    if (req.mint && meta && program) {
      const held = (fromAta && decodeTokenAccount(fromAta.data)?.amount) ?? 0n;
      if (held < value) throw new TradeError('insufficient_funds', `Not enough ${meta.symbol}.`);
      const rent = toAta
        ? 0n
        : await this.rentExempt(rpc, tokenAccountSize(program, meta.extensions));
      // The SOL left must still be zero or enough for the wallet to exist.
      const after = lamports - fee - rent;
      if (after < 0n || (after > 0n && after < minBalance))
        throw new TradeError(
          'insufficient_funds',
          `Not enough SOL: the fee${rent ? ' and the recipient’s token account' : ''} take ${sol(fee + rent)} SOL, and a wallet must keep at least ${sol(minBalance)}.`,
        );
      // Opened if missing (idempotent): the recipient may close it before this lands.
      instructions = [
        createAtaIdempotent(req.to, req.mint, program, w.solana),
        transferChecked(w.solana, req.to, req.mint, program, value, meta.decimals),
      ];
    } else {
      const block = solSendBlock(lamports, value, fee, minBalance);
      if (block) throw new TradeError('insufficient_funds', block);
      if (!toAcc && value < minBalance)
        throw new TradeError(
          'insufficient_funds',
          `A new address needs at least ${sol(minBalance)} SOL to exist.`,
        );
      instructions = [transfer(w.solana, req.to, value)];
    }

    const legs: TicketLeg[] = [
      {
        walletId: w.id,
        walletName: w.name,
        kind: 'transfer',
        status: 'queued',
        amountIn: value.toString(),
      },
    ];
    const st = this.core.newTicket('send', legs, undefined, req.mint, meta);
    st.startedAt = startedAt;
    st.ticket.recipient = req.to;
    st.ticket.nativeUsd = solUsd;
    const ctx: SolTransferContext = {
      wallet: w.solana,
      to: req.to,
      asset:
        meta && req.mint && program
          ? { mint: req.mint, program, decimals: meta.decimals, symbol: meta.symbol }
          : null,
      amount: value,
      maxPriorityLamports: this.maxPriority(gs, solUsd),
    };
    void this.core.runLeg(st, 0, {
      wallet: w,
      instructions,
      units: req.mint ? TOKEN_UNITS : SOL_UNITS,
      validate: (ixs) => validateSolanaTransfer(ixs, ctx),
      gs,
      ss,
    });
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /**
   * The same amount of SOL from one wallet to each of the others, one transaction each.
   * The USD limits apply, per transfer and for the whole click.
   */
  async distribute(req: {
    hubId: string;
    walletIds: string[];
    amountEach: string;
  }): Promise<TradeTicket> {
    if (!SOL_AMOUNT.test(req.amountEach))
      throw new TradeError('blocked', 'SOL has at most 9 decimals.');
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const hub = await this.hub(req.hubId);
    const targets = (await this.core.tradeWallets(req.walletIds)).filter((w) => w.id !== hub.id);
    if (targets.length === 0) throw new TradeError('not_found', 'No wallet selected.');
    const each = parseUnits(req.amountEach, SOLANA.nativeCurrency.decimals);
    if (each <= 0n) throw new TradeError('insufficient_funds', 'Amount too small.');
    const solUsd = await this.solUsd();
    const usd = (lamports: bigint) => Number(sol(lamports)) * solUsd;
    if (usd(each) > gs.maxUsdPerTx)
      throw new TradeError('limit_exceeded', 'Per-transfer amount above your limit.');
    if (usd(each * BigInt(targets.length)) > gs.maxUsdPerClick)
      throw new TradeError('limit_exceeded', 'Total above your per-click limit.');

    const fee = networkFee(ss);
    const rpc = this.core.rpcFor(ss);
    const [[hubAcc, ...targetAccs], minBalance] = await Promise.all([
      rpc.getMultipleAccounts([hub.solana, ...targets.map((w) => w.solana)]),
      this.rentExempt(rpc, 0),
    ]);
    const legs: TicketLeg[] = targets.map((w, i) => {
      // A wallet that holds no SOL yet must receive enough to exist.
      const tooLittle = !targetAccs[i] && each < minBalance;
      return {
        walletId: hub.id,
        walletName: `${hub.name} → ${w.name}`,
        kind: 'transfer',
        status: tooLittle ? 'skipped' : 'queued',
        amountIn: each.toString(),
        ...(tooLittle ? { error: `A new wallet needs at least ${sol(minBalance)} SOL` } : {}),
      };
    });
    const queued = BigInt(legs.filter((l) => l.status === 'queued').length);
    if (queued === 0n)
      throw new TradeError(
        'insufficient_funds',
        `A new wallet needs at least ${sol(minBalance)} SOL to exist.`,
      );
    // Checked for all of them now: they go out one after another without waiting for the
    // last to land. Whatever order they land in, the hub's balance must stay zero or enough
    // to exist, after each fee too. The lowest before the end is the last transfer's: the
    // amount, plus what is left.
    const need = (each + fee) * queued;
    const lamports = hubAcc?.lamports ?? 0n;
    if (lamports < need)
      throw new TradeError(
        'insufficient_funds',
        `About ${sol(need)} SOL is needed, fees included.`,
      );
    const left = lamports - need;
    if (left > 0n ? left < minBalance : each < minBalance)
      throw new TradeError(
        'insufficient_funds',
        `Leave at least ${sol(minBalance)} SOL in ${hub.name}: Solana closes a wallet below that.`,
      );

    const st = this.core.newTicket('distribute', legs);
    st.ticket.nativeUsd = solUsd;
    const maxPriorityLamports = this.maxPriority(gs, solUsd);
    void (async () => {
      for (let i = 0; i < targets.length; i++) {
        if (legs[i]?.status !== 'queued') continue;
        const to = (targets[i] as SolWallet).solana;
        const ctx: SolTransferContext = {
          wallet: hub.solana,
          to,
          asset: null,
          amount: each,
          maxPriorityLamports,
        };
        await this.core.runLeg(st, i, {
          wallet: hub,
          instructions: [transfer(hub.solana, to, each)],
          units: SOL_UNITS,
          validate: (ixs) => validateSolanaTransfer(ixs, ctx),
          gs,
          ss,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /**
   * All the SOL of each wallet into one, one transaction each, leaving them empty. Not
   * capped by the USD limits: the funds stay yours.
   */
  async collect(req: { hubId: string; walletIds: string[] }): Promise<TradeTicket> {
    const [gs, ss] = await Promise.all([this.d.settings.get(), this.d.settings.getSolana()]);
    const hub = await this.hub(req.hubId);
    const sources = (await this.core.tradeWallets(req.walletIds)).filter((w) => w.id !== hub.id);
    if (sources.length === 0) throw new TradeError('not_found', 'No wallet selected.');
    const solUsd = await this.solUsd();
    const fee = networkFee(ss);
    const rpc = this.core.rpcFor(ss);
    const [accs, minBalance] = await Promise.all([
      rpc.getMultipleAccounts(sources.map((w) => w.solana)),
      this.rentExempt(rpc, 0),
    ]);
    const legs: TicketLeg[] = sources.map((w, i) => {
      const lamports = accs[i]?.lamports ?? 0n;
      const value = lamports - fee;
      // At least the rent exemption either way, so a receiving wallet that does not exist
      // yet is funded by whichever lands first.
      const skip =
        value <= 0n ? 'Nothing to collect' : solSendBlock(lamports, value, fee, minBalance);
      return {
        walletId: w.id,
        walletName: `${w.name} → ${hub.name}`,
        kind: 'transfer',
        status: skip ? 'skipped' : 'queued',
        ...(skip ? { error: skip } : { amountIn: value.toString() }),
      };
    });
    const st = this.core.newTicket('collect', legs);
    st.ticket.nativeUsd = solUsd;
    const maxPriorityLamports = this.maxPriority(gs, solUsd);
    void (async () => {
      for (let i = 0; i < sources.length; i++) {
        const leg = legs[i] as TicketLeg;
        if (leg.status !== 'queued') continue;
        const w = sources[i] as SolWallet;
        const value = BigInt(leg.amountIn ?? '0');
        const ctx: SolTransferContext = {
          wallet: w.solana,
          to: hub.solana,
          asset: null,
          amount: value,
          maxPriorityLamports,
        };
        await this.core.runLeg(st, i, {
          wallet: w,
          instructions: [transfer(w.solana, hub.solana, value)],
          units: SOL_UNITS,
          validate: (ixs) => validateSolanaTransfer(ixs, ctx),
          gs,
          ss,
        });
      }
    })();
    this.core.update(st);
    return structuredClone(st.ticket);
  }

  /** The wallet funds come from or go to: one with a Solana address. */
  private async hub(id: string): Promise<SolWallet> {
    const hub = (await this.core.solWallets()).find((a) => a.id === id);
    if (!hub) throw new TradeError('not_found', 'That wallet has no Solana address.');
    return hub;
  }

  /**
   * The SOL price: the max network fee is set in USD, so nothing is signed without it.
   * Internal: also used by SolBridgeFlow.
   */
  async solUsd(): Promise<number> {
    const usd = await this.core.price.usd().catch(() => null);
    if (usd === null)
      throw new TradeError('limit_exceeded', 'USD price unavailable, cannot check limits.');
    return usd;
  }

  private maxPriority(gs: GlobalSettings, solUsd: number): bigint {
    return this.core.limits(gs, { usd: solUsd, decimals: SOLANA.nativeCurrency.decimals }, solUsd)
      .maxPriorityLamports;
  }
}
