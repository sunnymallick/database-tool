/**
 * OWNER: workbench (UI) slice. Deterministic sample data for the mock
 * backend. The shop data mirrors scripts/make-fixtures.ts (same seed and
 * generator) so the browser mock matches the real fixtures.
 */
import type { Value } from '@shared/types';

// ---------------------------------------------------------------------------
// Value constructors
// ---------------------------------------------------------------------------

export const NUL: Value = { t: 'null' };
export const vInt = (n: number | bigint | string): Value => ({ t: 'int', v: String(n) });
export const vFloat = (n: number): Value => ({ t: 'float', v: n });
export const vDec = (s: string | number, scale = 2): Value => ({
  t: 'decimal',
  v: typeof s === 'number' ? s.toFixed(scale) : s
});
export const vText = (s: string): Value => ({ t: 'text', v: s });
export const vBool = (b: boolean): Value => ({ t: 'bool', v: b });
export const vJson = (v: unknown): Value => ({ t: 'json', v });
export const vDate = (s: string): Value => ({ t: 'datetime', v: s });
export const vBytes = (bytes: number[]): Value => ({
  t: 'bytes',
  hex: bytes.map((b) => b.toString(16).padStart(2, '0')).join(''),
  length: bytes.length
});
export const orNull = <T>(x: T | null | undefined, f: (x: T) => Value): Value => (x === null || x === undefined ? NUL : f(x));

// ---------------------------------------------------------------------------
// Seeded random (same LCG as scripts/make-fixtures.ts)
// ---------------------------------------------------------------------------

/**
 * Seeded PRNG. `fixtureLcg` reproduces the (float-precision) LCG used by
 * scripts/make-fixtures.ts so the shop rows match the real fixtures; every
 * other generator uses mulberry32, which has a much better period.
 */
export class Rng {
  private seed: number;
  private readonly fixtureLcg: boolean;
  constructor(seed: number, fixtureLcg = false) {
    this.seed = seed;
    this.fixtureLcg = fixtureLcg;
  }
  next(): number {
    if (this.fixtureLcg) {
      this.seed = (this.seed * 1103515245 + 12345) % 2 ** 31;
      return this.seed / 2 ** 31;
    }
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

export const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Isla', 'Lucas', 'Aria', 'Mason', 'Nora', 'Leo', 'Ivy', 'Owen', 'Ruby', 'Kai'];
export const LAST = ['Patel', 'Nguyen', 'Garcia', 'Smith', 'Kim', 'Okafor', 'Rossi', 'Muller', 'Silva', 'Cohen', 'Tanaka', 'Haddad'];
export const COUNTRIES = ['US', 'CA', 'GB', 'DE', 'IN', 'BR', 'JP', 'AU', 'FR', 'NG'];
export const CATEGORIES = ['Books', 'Games', 'Garden', 'Kitchen', 'Outdoors', 'Toys', 'Audio', 'Office'];
const ADJ = ['Classic', 'Compact', 'Deluxe', 'Eco', 'Pro', 'Smart', 'Ultra', 'Vintage', 'Wireless', 'Portable'];
const NOUN = ['Lamp', 'Kettle', 'Backpack', 'Speaker', 'Notebook', 'Planter', 'Puzzle', 'Headphones', 'Chair', 'Tent', 'Mug', 'Drone'];
export const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;

const LONG_NOTES = [
  'Gift wrap please',
  'Leave at the door',
  "Customer's second order",
  'Expedite',
  'Customer called twice about the delivery window. Please make sure the courier rings the bell at the side entrance, ' +
    'because the front door intercom has been broken since March. If nobody answers, leave the parcel with the ' +
    'neighbour at number 14 and send an SMS to the number on file. Do NOT leave it on the porch: two previous parcels ' +
    'were stolen and refunded (see tickets #4411 and #4502).'
];

export interface Customer {
  id: number;
  externalId: string;
  email: string;
  fullName: string;
  country: string;
  createdAt: string;
  isActive: boolean;
  metadata: { tier: string; tags: string[]; newsletter: boolean } | null;
}
export interface Product {
  id: number;
  sku: string;
  name: string;
  price: string;
  stock: number;
  category: string;
  image: number[] | null;
  weightKg: number | null;
  restockEvery: string | null;
}
export interface Order {
  id: number;
  customerId: number;
  status: string;
  total: string;
  placedAt: string;
  shipDate: string | null;
  notes: string | null;
}
export interface Item {
  orderId: number;
  productId: number;
  quantity: number;
  unitPrice: string;
}
export interface LogEvent {
  happenedAt: string;
  level: string;
  message: string;
  context: { ms: number } | null;
}

export interface ShopData {
  customers: Customer[];
  products: Product[];
  orders: Order[];
  items: Item[];
  events: LogEvent[];
}

function isoDay(rng: Rng, offsetDays: number, hour = 12): string {
  const d = new Date(Date.UTC(2025, 0, 1, hour, rng.int(0, 59), rng.int(0, 59)) + offsetDays * 86_400_000);
  return d.toISOString().replace('.000Z', 'Z');
}

/** Same sequence as scripts/make-fixtures.ts `buildData` (extra fields drawn afterwards so the core rows match). */
export function buildShopData(scale = 1): ShopData {
  const rng = new Rng(42, true);
  const nCustomers = Math.max(10, Math.round(200 * scale));
  const nProducts = Math.max(10, Math.round(60 * scale));
  const nOrders = Math.max(10, Math.round(1500 * scale));
  const customers: Customer[] = [];
  for (let id = 1; id <= nCustomers; id++) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    customers.push({
      id,
      externalId: '',
      email: `${first}.${last}.${id}@example.com`.toLowerCase(),
      fullName: rng.next() < 0.05 ? '' : `${first} ${last}`,
      country: rng.pick(COUNTRIES),
      createdAt: isoDay(rng, rng.int(0, 600)),
      isActive: rng.next() > 0.15,
      metadata:
        rng.next() < 0.3
          ? null
          : { tier: rng.pick(['free', 'plus', 'pro']), tags: [rng.pick(CATEGORIES)], newsletter: rng.next() > 0.5 }
    });
  }
  const products: Product[] = [];
  for (let id = 1; id <= nProducts; id++) {
    products.push({
      id,
      sku: `SKU-${String(1000 + id)}`,
      name: `${rng.pick(ADJ)} ${rng.pick(NOUN)}`,
      price: (rng.int(199, 49999) / 100).toFixed(2),
      stock: rng.int(0, 500),
      category: rng.pick(CATEGORIES),
      image: rng.next() < 0.2 ? Array.from({ length: 24 }, () => rng.int(0, 255)) : null,
      weightKg: null,
      restockEvery: null
    });
  }
  const orders: Order[] = [];
  const items: Item[] = [];
  for (let id = 1; id <= nOrders; id++) {
    const lines = new Map<number, Item>();
    const n = rng.int(1, 5);
    for (let k = 0; k < n; k++) {
      const p = rng.pick(products);
      if (!lines.has(p.id)) lines.set(p.id, { orderId: id, productId: p.id, quantity: rng.int(1, 4), unitPrice: p.price });
    }
    const total = [...lines.values()].reduce((s, l) => s + l.quantity * Number(l.unitPrice), 0);
    const status = rng.pick(STATUSES);
    const placedAt = isoDay(rng, rng.int(30, 640), rng.int(0, 23));
    orders.push({
      id,
      customerId: rng.int(1, nCustomers),
      status,
      total: total.toFixed(2),
      placedAt,
      shipDate: status === 'shipped' || status === 'delivered' ? placedAt.slice(0, 10) : null,
      notes: rng.next() < 0.1 ? rng.pick(LONG_NOTES) : null
    });
    items.push(...lines.values());
  }
  const events: LogEvent[] = [];
  for (let k = 0; k < Math.max(20, Math.round(300 * scale)); k++) {
    events.push({
      happenedAt: isoDay(rng, rng.int(0, 640), rng.int(0, 23)),
      level: rng.pick(['info', 'warn', 'error']),
      message: rng.pick(['cache warmed', 'payment retry', 'slow query', 'login failed', 'export finished']),
      context: rng.next() < 0.5 ? null : { ms: rng.int(1, 900) }
    });
  }
  // Postgres-only extras, from a separate generator so the shared rows stay identical.
  const extra = new Rng(4242);
  for (const c of customers) c.externalId = extra.uuid();
  for (const p of products) {
    p.weightKg = extra.next() < 0.2 ? null : Math.round(extra.next() * 2000) / 100;
    p.restockEvery = extra.next() < 0.5 ? null : `${extra.int(1, 30)} days`;
  }
  return { customers, products, orders, items, events };
}

let shopCache: ShopData | null = null;
/** Full-size shop data, built once and shared by every engine's catalog (each catalog copies rows into Values). */
export function shopData(): ShopData {
  return (shopCache ??= buildShopData(1));
}

const PATHS = ['/', '/products', '/products/42', '/cart', '/checkout', '/account', '/search?q=lamp', '/blog/spring-sale', '/help/shipping', '/orders/1834'];
const REFERRERS = ['https://www.google.com/', 'https://duckduckgo.com/', 'https://news.ycombinator.com/', 'https://t.co/x8Hq2', null, null];
const AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  'curl/8.9.1'
];

export function pageViewRows(n: number): Value[][] {
  const rng = new Rng(7);
  const sessions = Array.from({ length: 2400 }, () => rng.uuid());
  const rows: Value[][] = [];
  const base = Date.UTC(2025, 8, 1);
  for (let id = 1; id <= n; id++) {
    const ts = new Date(base + id * 97_000 + rng.int(0, 60_000)).toISOString().replace('Z', '+00');
    rows.push([
      vInt(id),
      vText(rng.pick(sessions)),
      vText(rng.pick(PATHS)),
      orNull(rng.pick(REFERRERS), vText),
      vText(rng.pick(AGENTS)),
      vDate(ts.replace('T', ' ')),
      vInt(rng.int(200, 180_000))
    ]);
  }
  return rows;
}

export type WideKind = 'int' | 'float' | 'decimal' | 'text' | 'bool' | 'datetime';
export const WIDE_KINDS: WideKind[] = ['int', 'float', 'decimal', 'text', 'bool', 'datetime'];
const WIDE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

/** wide_metrics: id + 59 mixed-type columns. */
export function wideColumns(): { name: string; kind: WideKind }[] {
  const cols: { name: string; kind: WideKind }[] = [];
  for (let i = 1; i <= 59; i++) cols.push({ name: `metric_${String(i).padStart(2, '0')}`, kind: WIDE_KINDS[i % WIDE_KINDS.length] });
  return cols;
}

export function wideRows(n: number): Value[][] {
  const rng = new Rng(99);
  const cols = wideColumns();
  const rows: Value[][] = [];
  for (let id = 1; id <= n; id++) {
    const row: Value[] = [vInt(id)];
    for (const c of cols) {
      if (rng.next() < 0.04) {
        row.push(NUL);
        continue;
      }
      switch (c.kind) {
        case 'int':
          row.push(vInt(rng.int(-5000, 250_000)));
          break;
        case 'float':
          row.push(vFloat(Math.round(rng.next() * 1e6) / 1e3));
          break;
        case 'decimal':
          row.push(vDec(rng.int(0, 9_999_999) / 100));
          break;
        case 'text':
          row.push(vText(`${rng.pick(WIDE_WORDS)}-${rng.pick(WIDE_WORDS)}-${rng.int(1, 999)}`));
          break;
        case 'bool':
          row.push(vBool(rng.next() > 0.5));
          break;
        case 'datetime':
          row.push(vDate(new Date(Date.UTC(2025, 0, 1) + rng.int(0, 300) * 86_400_000 + rng.int(0, 86_399) * 1000).toISOString().replace('T', ' ').replace('.000Z', '+00')));
          break;
      }
    }
    rows.push(row);
  }
  return rows;
}
