import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    metadataBase: new URL(`${protocol}://${host}`),
    title: "Watch List — 私の鑑賞リスト",
    description: "読みたい、聴きたい、観たいものを管理する個人用リスト。",
    openGraph: { title: "Watch List", description: "あとで、ちゃんと楽しむ。", images: [{ url: "/og.png", width: 1800, height: 1024, alt: "Watch List" }] },
    twitter: { card: "summary_large_image", title: "Watch List", description: "あとで、ちゃんと楽しむ。", images: ["/og.png"] },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
