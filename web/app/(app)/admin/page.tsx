import { redirect } from 'next/navigation';

/** `/admin` opens on settings; the tabs live in the layout above. */
export default function AdminHome(): never {
    redirect('/admin/settings');
}
