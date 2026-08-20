import Vault from "@/components/Vault";

export default function Page() {
  return (
    <main className="shell">
      <nav className="topnav">
        <span className="topnav-here">the UP vault</span>
        <a href="/desk">the numbers →</a>
      </nav>
      <header className="masthead">
        <p className="wordmark">Quorum</p>
        <h1>UP — one token that bets up on every market here.</h1>
        <p>
          Deposit once. The vault splits your money across <strong>every live market on the venue</strong> —
          the same number of contracts of each — and as each window settles, the payout rolls itself into
          that market&rsquo;s next window. Withdraw whenever you like.
        </p>
        <p>
          It runs on paper money against the real order books: real prices in, real oracle outcomes back.
          Wondering whether the diversification is real? It is measured, not assumed —{" "}
          <a href="/desk">the numbers page</a> shows the evidence either way.
        </p>
      </header>

      <Vault />

      <footer className="foot">
        Built on the <a href="https://docs.dreamdex.io/developers/event-contracts">dreamDEX event
        contracts</a> via <code>@somnia-chain/markets-sdk</code>. Your ledger lives in this browser —
        no account, no server-side state. The same strategy with a real funded key is{" "}
        <code>bots/roll-sleeve.ts</code> in the repo.
      </footer>
    </main>
  );
}
