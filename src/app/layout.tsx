import type { Metadata } from "next";
import "./globals.css";
import { PreferencesProvider } from "@/components/preferences";

export const metadata: Metadata = {
  title: "استودیوی روایت — نوشتن رمان و اقتباس مانگا",
  description: "میزکار محلی نوشتن رمان وب و اقتباس آن به پنل مانگا/مانهوا",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl" data-theme="system">
      <body>
        <a className="skip-link" href="#main">
          رفتن به محتوای اصلی
        </a>
        <PreferencesProvider>{children}</PreferencesProvider>
      </body>
    </html>
  );
}
