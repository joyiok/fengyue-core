import { OverviewPanel } from '@/components/OverviewPanel';

/**
 * `/admin` lands on the overview: the one screen that answers "is anyone using
 * this, and what is it costing". Settings and users are the tabs beside it —
 * running the service and using it are different jobs, and none of this belongs
 * on a user's account page.
 */
export default function AdminHome(): React.JSX.Element {
    return <OverviewPanel />;
}
