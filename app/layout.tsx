import type { Metadata } from "next";

import "./globals.css";
import { WalletProvider } from "@/components/wallet-provider";
import { Toaster } from "sonner";

import { Inter, Hanken_Grotesk, Roboto_Mono } from "next/font/google";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-heading",
  subsets: ["latin"],
});

const robotoMono = Roboto_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "expaynse — Privacy-First Payroll for Solana",
  description:
    "Run payroll with complete financial privacy. Per-second streaming, MagicBlock private settlements, and complete salary confidentiality on Solana.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${hankenGrotesk.variable} ${robotoMono.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="min-h-full flex flex-col relative bg-black text-white"
      >
        <WalletProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" />
        </WalletProvider>
      </body>
    </html>
  );
}
