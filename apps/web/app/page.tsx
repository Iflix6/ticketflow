import { redirect } from 'next/navigation';

// The public experience starts at the catalog; keeping one copy of the list avoids two drifting
// "same" pages. `/` remains a stable, shareable entry point.
redirect('/events');
