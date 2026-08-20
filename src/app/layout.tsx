import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quorum — index contracts on dreamDEX",
  description:
    "Stop calling coin flips. Buy the average of every live event contract at once, with a NAV anyone can recompute from the order book.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
