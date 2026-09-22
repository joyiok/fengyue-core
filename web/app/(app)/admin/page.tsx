import { SettingsPanel } from '@/components/SettingsPanel';

/**
 * `/admin` lands on settings — the thing you come here to change most often.
 *
 * This is a real page rather than a redirect to `/admin/settings`: `redirect()`
 * under a client layout comes back as a 200 plus client-side navigation, which
 * is one more thing that can fail silently. Both URLs render the same view.
 */
export default function AdminHome(): React.JSX.Element {
    return <SettingsPanel />;
}
