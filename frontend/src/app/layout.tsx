import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@xyflow/react/dist/style.css";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import LocaleHydrator from "@/components/LocaleHydrator";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const playfairDisplay = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Geny — Geny Execute, Not You",
  description: "Geny: Geny Execute, Not You — Agent session management and 3D city playground",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

/**
 * Inline init scripts — run synchronously before React hydrates so
 * the <html> class / lang attribute are correct on the very first
 * paint. Theme prevents FOUC; locale prevents a flash of English
 * for ko users on a hard reload.
 *
 * The localStorage keys here MUST match the constants used by the
 * theme provider and the i18n module respectively.
 */
const initScript = `
(function(){
  try {
    var theme = localStorage.getItem('geny-theme-preference');
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.remove('light','dark');
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  } catch(e) {
    document.documentElement.classList.add('dark');
  }
  try {
    var lang = localStorage.getItem('geny-locale');
    if (lang === 'en' || lang === 'ko') {
      document.documentElement.lang = lang;
    }
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: initScript }} />
      </head>
      <body className={`${inter.variable} ${playfairDisplay.variable} ${jetbrainsMono.variable} ${inter.className} antialiased`}>
        <ThemeProvider>
          <LocaleHydrator />
          <TooltipProvider delayDuration={300}>
            {children}
          </TooltipProvider>
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
