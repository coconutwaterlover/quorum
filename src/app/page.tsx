import Desk from "@/components/Desk";

export default function Page() {
  return (
    <main className="shell">
      <header className="masthead">
        <p className="wordmark">Quorum</p>
        <h1>Don&rsquo;t pick a market. Pick how many of them have to be right.</h1>
        <p>
          A dreamDEX event contract is one Bernoulli draw: 15 minutes later it paid 1 or it paid 0, and
          that is the whole distribution. <strong>An index of them has a shape.</strong> One unit here is a
          slice of every live window at once — it costs the average of their prices and pays the fraction
          of them that win.
        </p>
        <p>
          There is no index token, no vault and no oracle of its own. A unit <em>is</em> its legs, so its
          NAV is a sum over prices already resting on the order book and anyone can recompute it from
          chain state. Buying the legs is creation; selling them is redemption. Nothing can trade away
          from fair value because there is no issuer standing between the two.
        </p>
        <p>
          Whether that actually reduces risk is an empirical question, not a slogan — so every number
          below is measured against this venue&rsquo;s own settled history, including the ones that make
          the idea look worse.
        </p>
      </header>

      <Desk />

      <footer className="foot">
        Built on the <a href="https://docs.dreamdex.io/developers/event-contracts">dreamDEX event
        contracts</a> via <code>@somnia-chain/markets-sdk</code>. Prices, books, correlations and
        settled outcomes are read live from Somnia — nothing on this page is simulated except the
        replay entry price, which is labelled where it is used. <code>npx tsx bots/census.ts</code>
        prints the same numbers from a terminal, and <code>bots/roll-sleeve.ts</code> is the same
        index as a bot you run with your own key.
      </footer>
    </main>
  );
}
