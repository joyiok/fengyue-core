import { AppFrame } from '@/components/AppFrame';

export default function AppLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <AppFrame>{children}</AppFrame>;
}
