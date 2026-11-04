import { useEffect, useState } from 'preact/hooks';
import { MAX_WALLET_GROUPS, type WalletGroup } from '../../shared/settings/defaults';
import type { WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';

const MODE_TEXT = { each: 'Amount in each', split: 'Amount split' } as const;

/**
 * Saved wallet groups: the panel shows them as chips above the position, and Alt + their
 * number switches to them. Order here is that number.
 */
export function Groups({ accounts }: { accounts: WalletAccount[] }) {
  const [groups, setGroups] = useState<WalletGroup[] | null>(null);
  /** The group being edited (a new one has an id not yet in the list). */
  const [draft, setDraft] = useState<WalletGroup | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void send({ type: 'settings.get' }).then((r) =>
      r.ok ? setGroups(r.data.walletGroups) : setMsg(errorText(r)),
    );
  }, []);

  const save = async (next: WalletGroup[]) => {
    setMsg(null);
    const r = await send({ type: 'settings.update', patch: { walletGroups: next } });
    if (!r.ok) {
      setMsg(errorText(r));
      return false;
    }
    setGroups(r.data.walletGroups);
    return true;
  };

  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name;
  const move = (i: number, by: -1 | 1) => {
    if (!groups) return;
    const next = [...groups];
    const [g] = next.splice(i, 1);
    if (!g) return;
    next.splice(i + by, 0, g);
    void save(next);
  };

  if (groups === null)
    return (
      <div class="stack" aria-busy="true">
        <span class="skel grp-skel" />
        <span class="skel grp-skel" />
      </div>
    );

  if (draft) {
    const isNew = !groups.some((g) => g.id === draft.id);
    const toggle = (id: string) =>
      setDraft({
        ...draft,
        walletIds: draft.walletIds.includes(id)
          ? draft.walletIds.filter((x) => x !== id)
          : [...draft.walletIds, id],
      });
    const valid = draft.name.trim().length > 0 && draft.walletIds.length > 0;
    return (
      <form
        class="stack grp-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const g = { ...draft, name: draft.name.trim() };
          void save(isNew ? [...groups, g] : groups.map((x) => (x.id === g.id ? g : x))).then(
            (ok) => ok && setDraft(null),
          );
        }}
      >
        <h2 class="section-title">{isNew ? 'New group' : 'Edit group'}</h2>
        <label class="field">
          <span class="label">Name</span>
          <input
            class="input"
            maxLength={24}
            placeholder="Sniper"
            value={draft.name}
            onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          />
        </label>

        <div class="field">
          <span class="label">With several wallets</span>
          <div class="grp-modes" role="radiogroup" aria-label="Amount with several wallets">
            {(
              [
                [undefined, 'Use my setting'],
                ['each', 'In each'],
                ['split', 'Split'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={draft.mode === mode}
                onClick={() => {
                  const next = { ...draft };
                  if (mode) next.mode = mode;
                  else delete next.mode;
                  setDraft(next);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div class="field">
          <span class="label">
            Wallets · {draft.walletIds.length} of {accounts.length}
            <span class="spacer" />
            <button
              type="button"
              class="link"
              onClick={() =>
                setDraft({
                  ...draft,
                  walletIds:
                    draft.walletIds.length === accounts.length ? [] : accounts.map((a) => a.id),
                })
              }
            >
              {draft.walletIds.length === accounts.length ? 'None' : 'All'}
            </button>
          </span>
          <div class="grp-wallets">
            {accounts.map((a) => (
              <label key={a.id} class={`grp-w${draft.walletIds.includes(a.id) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={draft.walletIds.includes(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span>{a.name}</span>
                {a.hidden && <span class="tag">Hidden</span>}
              </label>
            ))}
          </div>
        </div>

        {msg && <p class="error">{msg}</p>}
        <div class="row grp-acts">
          {!isNew && (
            <button
              type="button"
              class="btn btn--danger"
              onClick={() =>
                void save(groups.filter((g) => g.id !== draft.id)).then(
                  (ok) => ok && setDraft(null),
                )
              }
            >
              Delete
            </button>
          )}
          <span class="spacer" />
          <button type="button" class="btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button type="submit" class="btn btn--primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    );
  }

  return (
    <div class="stack grp">
      <div class="row">
        <h2 class="section-title">Wallet groups</h2>
        <span class="spacer" />
        {groups.length < MAX_WALLET_GROUPS && (
          <button
            type="button"
            class="link"
            onClick={() => setDraft({ id: crypto.randomUUID(), name: '', walletIds: [] })}
          >
            + New group
          </button>
        )}
      </div>
      <p class="hint">
        Groups show as chips in the trading panel. Alt + the number switches to a group; it never
        trades on its own.
      </p>
      {groups.length === 0 ? (
        <p class="notice">
          No groups yet. Create one here, or pick wallets in the panel and choose Save as group.
        </p>
      ) : (
        <ul class="grp-list">
          {groups.map((g, i) => {
            const names = g.walletIds.map(nameOf).filter((n): n is string => !!n);
            return (
              <li key={g.id} class="grp-row">
                <kbd class="grp-key" title={`Alt + ${i + 1} in the panel`}>
                  {i + 1}
                </kbd>
                <button type="button" class="grp-main" onClick={() => setDraft(g)}>
                  <span class="grp-name">{g.name}</span>
                  <small>
                    {names.length} wallet{names.length === 1 ? '' : 's'}
                    {g.mode ? ` · ${MODE_TEXT[g.mode]}` : ''} · {names.slice(0, 3).join(', ')}
                    {names.length > 3 ? '…' : ''}
                  </small>
                </button>
                <span class="grp-move">
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={`Move ${g.name} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={`Move ${g.name} down`}
                    disabled={i === groups.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {msg && <p class="error">{msg}</p>}
    </div>
  );
}
