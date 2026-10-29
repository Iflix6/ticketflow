// TicketFlow flagship booking benchmark — Grafana k6 scenario (Phase 6, as-code).
//
// IMPORTANT — read before trusting any number: this file is the *declarative* benchmark for machines that
// have k6 installed. It was NOT executed on the Phase 6 development workstation because k6 is not present
// there and the environment forbids downloading binaries. The measured, documented results in
// docs/experiments/http-booking-benchmark.md were produced by the equivalent Node harness
// (`npm run bench` -> scripts/benchmark.ts), which drives the same reserve->checkout flow over the same
// real HTTP API. Run this script where k6 exists to reproduce the load profile independently.
//
//   k6 run load-tests/flagship-booking.js \
//     -e BASE_URL=http://127.0.0.1:4000 \
//     -e TIER_ID=<uuid> -e EMAIL=customer@local.test -e PASSWORD=local-demo-customer-2026 \
//     -e QUANTITY=1 -e VUS=100 -e DURATION=60s
//
// Like the Node harness, run it against an API with RATE_LIMIT_MAX raised, or the limiter (429) — not
// reservation contention — becomes the thing under measure.

import http from 'k6/http';
import { check, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const TIER_ID = __ENV.TIER_ID || '';
const EMAIL = __ENV.EMAIL || 'customer@local.test';
const PASSWORD = __ENV.PASSWORD || 'local-demo-customer-2026';
const QUANTITY = Number(__ENV.QUANTITY || '1');

// Custom metrics so the summary carries the same shape the Node harness reports.
const confirmed = new Counter('ticketflow_bench_confirmed');
const soldOut = new Counter('ticketflow_bench_sold_out');
const reserveLatency = new Trend('ticketflow_bench_reserve_latency_ms', true);

export const options = {
  vus: Number(__ENV.VUS || '100'),
  duration: __ENV.DURATION || '30s',
  // Correctness is the headline, latency the secondary. A p99 that fails a threshold is a finding, not a pass.
  thresholds: {
    http_req_failed: ['rate<0.01'], // transport failures should be ~none; oversells surface as 409 not 5xx
    ticketflow_bench_reserve_latency_ms: ['p99<2000'],
  },
};

export function setup() {
  const res = http.post(`${BASE}/api/v1/auth/token`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  });
  if (res.status !== 200) {
    throw new Error(`setup: login failed (HTTP ${res.status}); run npm run seed and set TIER_ID`);
  }
  const token = res.json('data.token');
  // Read starting capacity from the real tiers endpoint (never assume the fixture size).
  const events = http.get(`${BASE}/api/v1/events`).json('data');
  const eventId = TIER_ID ? undefined : (events && events[0] ? events[0].id : undefined);
  let tierId = TIER_ID;
  if (!tierId && eventId) {
    const tiers = http.get(`${BASE}/api/v1/events/${eventId}/tiers`).json('data');
    tierId = tiers && tiers[0] ? tiers[0].tier.id : undefined;
  }
  if (!tierId) throw new Error('setup: could not resolve a tier id (set TIER_ID)');
  return { token, tierId };
}

export default function (data) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${data.token}`,
  };

  let reservationId;
  group('reserve', function () {
    const res = http.post(
      `${BASE}/api/v1/reservations`,
      JSON.stringify({ tierId: data.tierId, quantity: QUANTITY }),
      { headers: { ...headers, 'idempotency-key': `k6-${__VU}-${__ITER}` }, tags: { name: 'reserve' } },
    );
    reserveLatency.add(res.timings.duration);
    if (res.status === 201) {
      reservationId = res.json('data.id');
    } else if (res.status === 409 && res.json('error.code') === 'sold_out') {
      soldOut.add(1);
    } else {
      check(res, { 'reserve status ok': (r) => r.status === 201 || r.status === 409 || r.status === 429 });
    }
  });

  if (reservationId) {
    group('checkout', function () {
      const res = http.post(
        `${BASE}/api/v1/reservations/${reservationId}/checkout`,
        JSON.stringify({ simulatedOutcome: 'success' }),
        { headers: { ...headers, 'idempotency-key': `k6-co-${__VU}-${__ITER}` }, tags: { name: 'checkout' } },
      );
      if (res.status === 201 && res.json('data.status') === 'CONFIRMED') confirmed.add(1);
    });
  }
}

export function handleSummary(summary) {
  const rows = [
    `metric,p50,p95,p99,avg,max`,
    `reserve_latency_ms,${summary.metrics.ticketflow_bench_reserve_latency_ms['p(50)']},${summary.metrics.ticketflow_bench_reserve_latency_ms['p(95)']},${summary.metrics.ticketflow_bench_reserve_latency_ms['p(99)']},${summary.metrics.ticketflow_bench_reserve_latency_ms.avg},${summary.metrics.ticketflow_bench_reserve_latency_ms.max}`,
    `confirmed,${summary.metrics.ticketflow_bench_confirmed.count}`,
    `sold_out,${summary.metrics.ticketflow_bench_sold_out.count}`,
  ].join('\n');
  return {
    'load-tests/results/k6-summary.json': JSON.stringify(summary.metrics, null, 2),
    'load-tests/results/k6-summary.csv': rows + '\n',
    stdout: `k6 run complete: ${rows}\n`,
  };
}
