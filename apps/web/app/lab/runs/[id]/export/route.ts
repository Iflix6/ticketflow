import { serverApi, isApiCallError } from '../../../../../lib/server-api';
import type { ExperimentResultWire } from '../../../../../lib/types';

/**
 * CSV export of a run's results (the pack asks for CSV *and* JSON; JSON is the documented endpoint
 * itself). Server-side so the download carries the FULL row set in one response — the same
 * documented endpoint and the same 5,000-row maximum the page shows. Session cookie is forwarded
 * by `serverApi`, so exporting requires the same authorization as viewing: no privileged back door.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;

  let results: ExperimentResultWire[];
  try {
    const res = await serverApi<{ data: ExperimentResultWire[] }>(`/api/v1/lab/runs/${id}/results?limit=5000`);
    results = res.data;
  } catch (error) {
    if (isApiCallError(error)) {
      return new Response(`${error.code}: ${error.message}\n`, { status: error.status });
    }
    return new Response('results could not be fetched\n', { status: 502 });
  }

  const header = ['id', 'requestIndex', 'actorLabel', 'outcome', 'httpStatus', 'latencyMicros', 'failureClass', 'correlationId', 'createdAt'];
  // RFC-4180 quoting: wrap every field, double embedded quotes. Actor labels are synthetic but
  // commas in future columns must not silently shift a spreadsheet.
  const escape = (v: unknown): string => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = results.map((r) => header.map((k) => escape(r[k as keyof ExperimentResultWire])).join(','));
  const csv = [header.join(','), ...rows].join('\r\n');

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="run-${id.slice(0, 8)}-results.csv"`,
      'cache-control': 'no-store',
    },
  });
}
