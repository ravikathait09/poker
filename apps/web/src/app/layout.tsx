import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ganga Poker",
  description: "Real-time poker with friends — host, approve, play.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
