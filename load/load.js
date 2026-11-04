import http from 'k6/http';
import { Counter } from 'k6/metrics';

const API_URL = __ENV.API_URL || 'http://api:3000';
const PATIENTS = 5000;
const TYPES = ['heart_rate', 'blood_pressure', 'temperature'];
const DUPLICATE_RATE = 0.1;
const MAX_TS_JITTER_MS = 30_000;

const acceptedNew = new Counter('accepted_new');
const duplicates = new Counter('duplicates');

export const options = {
  scenarios: {
    ingest: {
      // Fixed arrival rate: a slow response does not slow the sender down, like real traffic.
      executor: 'constant-arrival-rate',
      // The assignment load: 1,000 events/min.
      rate: 1000,
      timeUnit: '1m',
      duration: __ENV.DURATION || '10m',
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<100'],
    http_req_failed: ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

// Each VU keeps what it sent, so a duplicate is a byte-identical resend.
const sent = [];

function newEvent() {
  return JSON.stringify({
    patientId: `patient-${Math.floor(Math.random() * PATIENTS)}`,
    type: TYPES[Math.floor(Math.random() * TYPES.length)],
    data: { value: Math.round(Math.random() * 1000) / 10 },
    // Random delay up to 30s: events of one patient arrive out of ts order, some after a later one is done.
    ts: new Date(Date.now() - Math.random() * MAX_TS_JITTER_MS).toISOString(),
  });
}

export default function () {
  const resend = sent.length > 0 && Math.random() < DUPLICATE_RATE;
  const body = resend
    ? sent[Math.floor(Math.random() * sent.length)]
    : newEvent();
  if (!resend) sent.push(body);

  const res = http.post(`${API_URL}/events`, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 202) {
    acceptedNew.add(1);
    // One id per line in load/accepted.log (--console-output): verify checks each one is stored.
    console.log(res.json('id'));
  }
  if (res.status === 200) duplicates.add(1);
}
