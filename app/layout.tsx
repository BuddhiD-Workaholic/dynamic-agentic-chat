import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Script Canvas POC",
  description: "Stream isolation, render isolation, selective edits, intent gating",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
