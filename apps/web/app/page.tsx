import { redirect } from 'next/navigation';

// The public experience starts at the catalog; keeping one copy of the list avoids two drifting
// "same" pages. `/` remains a stable, shareable entry point. The redirect lives inside the
// component because Next evaluates page modules during build-time page-data collection, where a
// module-scope redirect throws instead of producing a route.
export default function Home() {
  redirect('/events');
}
