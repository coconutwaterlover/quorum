import Vault from "@/components/Vault";

export default function PaperPage() {
  return (
    <main className="shell">
      <nav className="topnav">
        <a href="/">← the real vaults</a>
        <span className="topnav-here">paper sandbox</span>
        <a href="/desk">the numbers →</a>
      </nav>
      <header className="masthead">
        <p className="wordmark">Quorum</p>
        <h1>The paper sandbox — same strategy, nothing at stake.</h1>
        <p>
          No wallet, no gas, no queue: a private paper ledger in this browser runs the same
          every-market-up basket against the real order books, with real oracle outcomes. Good for
          feeling the rhythm before putting testnet money into <a href="/">QUP or QDWN</a>.
        </p>
      </header>
      <Vault />
      <footer className="foot">
        Your ledger lives in this browser — no account, no server-side state. The real shared vaults
        are on the <a href="/">front page</a>.
      </footer>
    </main>
  );
}
