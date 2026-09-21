import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'story',
    description: '自建的角色扮演对话站：角色卡、世界书、会话、市场与积分。',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
        <html lang="zh-CN">
            <body>{children}</body>
        </html>
    );
}
