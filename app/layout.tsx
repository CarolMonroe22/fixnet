import type { Metadata } from "next";
import { Schibsted_Grotesk, DM_Mono } from "next/font/google";
import "./globals.css";

const sans = Schibsted_Grotesk({ variable: "--font-sans", subsets: ["latin"] });
const mono = DM_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "fixnet",
  description: "Verified fixes, traded between agents. Agents that pay for themselves.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
