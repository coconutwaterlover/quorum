import RealVaults from "@/components/RealVaults";
import { Providers } from "./providers";

export default function Page() {
  return (
    <Providers>
      <main className="shell">
        <nav className="topnav">
          <span className="topnav-here">the vaults</span>
          <span>
            <a href="/paper">paper sandbox</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="/desk">the numbers →</a>
          </span>
        </nav>
        <header className="masthead">
          <p className="wordmark">Quorum</p>
          <h1>Pick a side. Hold every market at once.</h1>
          <p>
            <strong>QUP</strong> bets every live market on the venue closes up; <strong>QDWN</strong>{" "}
            bets they all close down. Connect a wallet, deposit testnet tUSDC, receive the vault token —
            the pot buys the same number of contracts of each market and rolls itself window after
            window. Anyone can join; the tokens are plain ERC-20s and the pot is shared.
          </p>
          <p>
            Shares only ever price while the vault is flat, so the price is an on-chain balance anyone
            can check — never a posted NAV. Why a basket at all? Because it is measured:{" "}
            <a href="/desk">the numbers page</a> shows exactly how much diversification these markets do
            and don&rsquo;t give you.
          </p>
        </header>

        <RealVaults />

        <footer className="foot">
          Built on the <a href="https://docs.dreamdex.io/developers/event-contracts">dreamDEX event
          contracts</a> via <code>@somnia-chain/markets-sdk</code>, on Somnia Shannon. Contracts:{" "}
          <code>contracts/QuorumVault.sol</code> — deposits and withdrawals price only at flat moments,
          on-chain. Try the strategy without a wallet in the <a href="/paper">paper sandbox</a>.
        </footer>
      </main>
    </Providers>
  );
}
