import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'VoidFall — Painel operacional',
  description: 'Painel administrativo do modpack e servidor VoidFall.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
