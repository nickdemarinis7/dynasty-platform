import type { Metadata, Viewport } from "next";
import { Sidebar } from "@/components/sidebar";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Fantasy GM",
  title: { default: "Fantasy GM", template: "%s · Fantasy GM" },
  description: "Fantasy football trade simulator and recommendation platform for dynasty and redraft leagues",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Fantasy GM" },
  formatDetection: { telephone: false },
  icons: { icon: "/favicon.ico", apple: "/favicon.ico" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#17191d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased dark"
    >
      <body className="min-h-full bg-background text-foreground">
        <ToastProvider>
          <Sidebar />
          <main className="app-main min-w-0 p-4 pb-24 sm:p-6 sm:pb-24 lg:ml-64 lg:p-8">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
