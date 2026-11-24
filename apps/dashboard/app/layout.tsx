import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Querynx Console',
  description: 'Developer dashboard for the Querynx web intelligence platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <a href="/">Overview</a>
          <a href="/search">Search</a>
          <a href="/research">Research</a>
          <a href="/extract">Extract</a>
          <a href="/providers">Providers</a>
          <a href="/index">Index</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
