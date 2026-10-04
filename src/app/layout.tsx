import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SonicCanvas — Procedural Music Video Generator",
  description: "Upload a music file and watch a procedural visual performance react in real time. All processing happens locally in your browser.",
  keywords: ["SonicCanvas", "music visualizer", "procedural", "WebGL", "Web Audio", "Three.js"],
  authors: [{ name: "SonicCanvas" }],
  verification: {
    google: "La7ThTy5RAYuNonNZCKSaT0IdAf7YozGQ1Ld1SdlMaU",
  },
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "SonicCanvas",
    description: "Procedural music-video generator — runs entirely in your browser.",
    siteName: "SonicCanvas",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SonicCanvas",
    description: "Procedural music-video generator — runs entirely in your browser.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
