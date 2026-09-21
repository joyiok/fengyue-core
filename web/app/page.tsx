import { redirect } from 'next/navigation';

/** The site opens on conversations; the guard in AppFrame sends guests to /login. */
export default function Home(): never {
    redirect('/chats');
}
