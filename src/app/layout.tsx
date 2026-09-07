import type { Metadata } from "next";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "gate — Claude Gateway",
  description: "Personal Claude gateway with context-aware model routing.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Before first paint, or the page flashes the wrong theme on every
            load. Kept inline and dependency-free for the same reason: anything
            that has to be fetched or hydrated is already too late. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var c=localStorage.getItem('gate-theme')||'dark';var d=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
        {/* Fixed to the corner rather than dropped into each page: there is no
            shared top bar to hang it on, and a control that moves depending on
            which page you are looking at is one you have to hunt for. It sits
            in the strip above every page's own header padding, so it lands on
            nothing. */}
        <div className="fixed right-3 top-2 z-50">
          <ThemeToggle />
        </div>
      </body>
    </html>
  );
}
