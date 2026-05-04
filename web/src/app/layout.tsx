import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { TopNav } from "@/components/top-nav";

export const metadata: Metadata = {
  title: "images-generate",
  description: "images-generate mobile image workspace",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className="antialiased"
        style={{
          fontFamily:
            '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
        }}
      >
        <Toaster position="top-center" richColors offset={48} duration={1600} />
        <main className="min-h-dvh overflow-hidden bg-stone-50 px-0 py-0 text-stone-900 sm:bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_rgba(245,239,231,0.96)_42%,_rgba(240,235,227,0.99)_100%)] sm:px-6 sm:py-2 lg:px-8">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-0 sm:gap-5">
            <TopNav />
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
