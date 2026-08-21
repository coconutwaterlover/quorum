import RealVaults from "@/components/RealVaults";
import { Providers } from "./providers";

export default function Page() {
  return (
    <Providers>
      <main className="shell">
        <RealVaults />

        <footer className="foot">
          built with 🥥 by{" "}
          <a href="https://github.com/coconutwaterlover/quorum" target="_blank" rel="noreferrer">
            coconutwaterlover
          </a>
        </footer>
      </main>
    </Providers>
  );
}
