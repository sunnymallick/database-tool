/**
 * Builds test/demo fixtures:
 *   tests/fixtures/sample.sqlite             a small "shop" database (SQLite)
 *   Postgres database `database_tool_test`   the same shop plus Postgres-specific objects
 *
 * Usage: pnpm fixtures         (both)
 *        pnpm fixtures sqlite  (SQLite only)
 * Postgres URL: DATABASE_TOOL_TEST_PG (default postgres://localhost:5432/database_tool_test).
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const SQLITE_PATH = resolve('tests/fixtures/sample.sqlite');
const PG_URL = process.env.DATABASE_TOOL_TEST_PG ?? 'postgres://localhost:5432/database_tool_test';

// Deterministic pseudo-random numbers so fixtures are identical on every run.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = ['Ava', 'Liam', 'Mia', 'Noah', 'Zoe', 'Ethan', 'Isla', 'Lucas', 'Aria', 'Mason', 'Nora', 'Leo', 'Ivy', 'Owen', 'Ruby', 'Kai'];
const LAST = ['Patel', 'Nguyen', 'Garcia', 'Smith', 'Kim', 'Okafor', 'Rossi', 'Muller', 'Silva', 'Cohen', 'Tanaka', 'Haddad'];
const COUNTRIES = ['US', 'CA', 'GB', 'DE', 'IN', 'BR', 'JP', 'AU', 'FR', 'NG'];
const CATEGORIES = ['Books', 'Games', 'Garden', 'Kitchen', 'Outdoors', 'Toys', 'Audio', 'Office'];
const ADJ = ['Classic', 'Compact', 'Deluxe', 'Eco', 'Pro', 'Smart', 'Ultra', 'Vintage', 'Wireless', 'Portable'];
const NOUN = ['Lamp', 'Kettle', 'Backpack', 'Speaker', 'Notebook', 'Planter', 'Puzzle', 'Headphones', 'Chair', 'Tent', 'Mug', 'Drone'];
const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;

interface Customer { id: number; email: string; full_name: string; country: string; created_at: string; is_active: boolean; metadata: object | null }
interface Product { id: number; sku: string; name: string; price: string; stock: number; category: string; image: Buffer | null }
interface Order { id: number; customer_id: number; status: string; total: string; placed_at: string; notes: string | null }
interface Item { order_id: number; product_id: number; quantity: number; unit_price: string }

function isoDay(offsetDays: number, hour = 12): string {
  const d = new Date(Date.UTC(2025, 0, 1, hour, int(0, 59), int(0, 59)) + offsetDays * 86_400_000);
  return d.toISOString().replace('.000Z', 'Z');
}

function buildData() {
  seed = 42;
  const customers: Customer[] = [];
  for (let id = 1; id <= 200; id++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    customers.push({
      id,
      email: `${first}.${last}.${id}@example.com`.toLowerCase(),
      full_name: rand() < 0.05 ? '' : `${first} ${last}`,
      country: pick(COUNTRIES),
      created_at: isoDay(int(0, 600)),
      is_active: rand() > 0.15,
      metadata: rand() < 0.3 ? null : { tier: pick(['free', 'plus', 'pro']), tags: [pick(CATEGORIES)], newsletter: rand() > 0.5 }
    });
  }
  const products: Product[] = [];
  for (let id = 1; id <= 60; id++) {
    products.push({
      id,
      sku: `SKU-${String(1000 + id)}`,
      name: `${pick(ADJ)} ${pick(NOUN)}`,
      price: (int(199, 49999) / 100).toFixed(2),
      stock: int(0, 500),
      category: pick(CATEGORIES),
      image: rand() < 0.2 ? Buffer.from(Array.from({ length: 24 }, () => int(0, 255))) : null
    });
  }
  const orders: Order[] = [];
  const items: Item[] = [];
  for (let id = 1; id <= 1500; id++) {
    const lines = new Map<number, Item>();
    const n = int(1, 5);
    for (let k = 0; k < n; k++) {
      const p = pick(products);
      if (!lines.has(p.id)) lines.set(p.id, { order_id: id, product_id: p.id, quantity: int(1, 4), unit_price: p.price });
    }
    const total = [...lines.values()].reduce((s, l) => s + l.quantity * Number(l.unit_price), 0);
    orders.push({
      id,
      customer_id: int(1, 200),
      status: pick(STATUSES),
      total: total.toFixed(2),
      placed_at: isoDay(int(30, 640), int(0, 23)),
      notes: rand() < 0.1 ? pick(['Gift wrap please', 'Leave at the door', "Customer's second order", 'Expedite']) : null
    });
    items.push(...lines.values());
  }
  return { customers, products, orders, items };
}

function buildSqlite(): void {
  const { customers, products, orders, items } = buildData();
  mkdirSync(dirname(SQLITE_PATH), { recursive: true });
  if (existsSync(SQLITE_PATH)) rmSync(SQLITE_PATH);
  const db = new DatabaseSync(SQLITE_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT,
      country TEXT NOT NULL DEFAULT 'US',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      is_active BOOLEAN NOT NULL DEFAULT 1,
      metadata JSON
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
      stock INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      image BLOB
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      placed_at TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX idx_orders_customer ON orders(customer_id);
    CREATE INDEX idx_orders_status_placed ON orders(status, placed_at);
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price NUMERIC(10,2) NOT NULL,
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE event_log (
      happened_at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE VIEW customer_order_totals AS
      SELECT c.id AS customer_id, c.full_name, c.country, COUNT(o.id) AS order_count, ROUND(COALESCE(SUM(o.total), 0), 2) AS lifetime_value
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
      GROUP BY c.id;
    CREATE TRIGGER trg_order_items_stock AFTER INSERT ON order_items
      BEGIN UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id; END;
  `);
  db.exec('BEGIN');
  const ic = db.prepare('INSERT INTO customers VALUES (?,?,?,?,?,?,?)');
  for (const c of customers) ic.run(c.id, c.email, c.full_name || null, c.country, c.created_at, c.is_active ? 1 : 0, c.metadata ? JSON.stringify(c.metadata) : null);
  const ip = db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?)');
  for (const p of products) ip.run(p.id, p.sku, p.name, Number(p.price), p.stock + 1000, p.category, p.image);
  const io = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)');
  for (const o of orders) io.run(o.id, o.customer_id, o.status, Number(o.total), o.placed_at, o.notes);
  const ii = db.prepare('INSERT INTO order_items VALUES (?,?,?,?)');
  for (const i of items) ii.run(i.order_id, i.product_id, i.quantity, Number(i.unit_price));
  const ie = db.prepare('INSERT INTO event_log VALUES (?,?,?)');
  for (let k = 0; k < 300; k++) ie.run(isoDay(int(0, 640), int(0, 23)), pick(['info', 'warn', 'error']), pick(['cache warmed', 'payment retry', 'slow query', 'login failed', 'export finished']));
  db.exec('COMMIT');
  db.close();
  console.log(`sqlite: wrote ${SQLITE_PATH} (${customers.length} customers, ${orders.length} orders, ${items.length} items)`);
}

async function buildPostgres(): Promise<void> {
  const url = new URL(PG_URL);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(PG_URL), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(dbName)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
  await admin.end();

  const { customers, products, orders, items } = buildData();
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  await c.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA sales;
    CREATE TYPE sales.order_status AS ENUM ('pending','paid','shipped','delivered','cancelled');
    CREATE TABLE public.customers (
      id bigserial PRIMARY KEY,
      external_id uuid NOT NULL DEFAULT gen_random_uuid(),
      email varchar(255) NOT NULL UNIQUE,
      full_name text,
      country char(2) NOT NULL DEFAULT 'US',
      created_at timestamptz NOT NULL DEFAULT now(),
      is_active boolean NOT NULL DEFAULT true,
      metadata jsonb,
      tags text[] NOT NULL DEFAULT '{}'
    );
    COMMENT ON TABLE public.customers IS 'People who have placed or may place orders';
    COMMENT ON COLUMN public.customers.external_id IS 'Stable id shared with the CRM';
    CREATE TABLE public.products (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      sku text NOT NULL UNIQUE,
      name text NOT NULL,
      price numeric(10,2) NOT NULL CHECK (price >= 0),
      stock integer NOT NULL DEFAULT 0,
      category text,
      image bytea,
      weight_kg real,
      restock_every interval
    );
    CREATE TABLE sales.orders (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
      status sales.order_status NOT NULL DEFAULT 'pending',
      total numeric(12,2) NOT NULL DEFAULT 0,
      placed_at timestamptz NOT NULL,
      ship_date date,
      notes text
    );
    CREATE INDEX idx_orders_customer ON sales.orders(customer_id);
    CREATE INDEX idx_orders_status_placed ON sales.orders(status, placed_at DESC);
    CREATE TABLE sales.order_items (
      order_id bigint NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
      product_id integer NOT NULL REFERENCES public.products(id),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_price numeric(10,2) NOT NULL,
      PRIMARY KEY (order_id, product_id)
    );
    CREATE TABLE public.event_log (happened_at timestamptz NOT NULL, level text NOT NULL, message text NOT NULL, context json);
    CREATE VIEW sales.customer_order_totals AS
      SELECT c.id AS customer_id, c.full_name, c.country, count(o.id) AS order_count, coalesce(sum(o.total), 0)::numeric(14,2) AS lifetime_value
      FROM public.customers c LEFT JOIN sales.orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
      GROUP BY c.id;
    CREATE MATERIALIZED VIEW sales.daily_revenue AS
      SELECT date_trunc('day', placed_at)::date AS day, count(*) AS orders, sum(total) AS revenue
      FROM sales.orders WHERE status <> 'cancelled' GROUP BY 1;
    CREATE SEQUENCE sales.invoice_number_seq START 10000;
    CREATE FUNCTION sales.customer_lifetime_value(p_customer bigint) RETURNS numeric
      LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(total), 0) FROM sales.orders WHERE customer_id = p_customer AND status <> 'cancelled' $$;
    CREATE PROCEDURE sales.cancel_stale_orders(p_days integer)
      LANGUAGE plpgsql AS $$ BEGIN UPDATE sales.orders SET status = 'cancelled' WHERE status = 'pending' AND placed_at < now() - make_interval(days => p_days); END $$;
    CREATE FUNCTION sales.touch_stock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE public.products SET stock = stock - NEW.quantity WHERE id = NEW.product_id; RETURN NEW; END $$;
    CREATE TRIGGER trg_order_items_stock AFTER INSERT ON sales.order_items FOR EACH ROW EXECUTE FUNCTION sales.touch_stock();
  `);
  await c.query('BEGIN');
  for (const x of customers)
    await c.query('INSERT INTO public.customers (id,email,full_name,country,created_at,is_active,metadata,tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      x.id, x.email, x.full_name || null, x.country, x.created_at, x.is_active, x.metadata, x.metadata ? ['vip'] : []
    ]);
  await c.query(`SELECT setval('public.customers_id_seq', 200)`);
  for (const p of products)
    await c.query('INSERT INTO public.products (sku,name,price,stock,category,image,weight_kg,restock_every) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      p.sku, p.name, p.price, p.stock + 1000, p.category, p.image, rand() < 0.2 ? null : Math.round(rand() * 2000) / 100, rand() < 0.5 ? null : `${int(1, 30)} days`
    ]);
  for (const o of orders)
    await c.query('INSERT INTO sales.orders (id,customer_id,status,total,placed_at,ship_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      o.id, o.customer_id, o.status, o.total, o.placed_at, o.status === 'shipped' || o.status === 'delivered' ? o.placed_at.slice(0, 10) : null, o.notes
    ]);
  await c.query(`SELECT setval(pg_get_serial_sequence('sales.orders','id'), 1500)`);
  for (let k = 0; k < items.length; k += 500) {
    const chunk = items.slice(k, k + 500);
    const params: unknown[] = [];
    const rows = chunk.map((i, n) => {
      params.push(i.order_id, i.product_id, i.quantity, i.unit_price);
      return `($${n * 4 + 1},$${n * 4 + 2},$${n * 4 + 3},$${n * 4 + 4})`;
    });
    await c.query(`INSERT INTO sales.order_items VALUES ${rows.join(',')}`, params);
  }
  for (let k = 0; k < 300; k++)
    await c.query('INSERT INTO public.event_log VALUES ($1,$2,$3,$4)', [
      isoDay(int(0, 640), int(0, 23)), pick(['info', 'warn', 'error']), pick(['cache warmed', 'payment retry', 'slow query', 'login failed']), rand() < 0.5 ? null : JSON.stringify({ ms: int(1, 900) })
    ]);
  await c.query('COMMIT');
  await c.query('REFRESH MATERIALIZED VIEW sales.daily_revenue');
  await c.query('ANALYZE');
  await c.end();
  console.log(`postgres: rebuilt ${dbName} (${customers.length} customers, ${orders.length} orders, ${items.length} items)`);
}

const which = process.argv[2];
buildSqlite();
if (which !== 'sqlite') {
  buildPostgres().catch((err) => {
    console.error('postgres fixture failed:', err.message);
    process.exitCode = 1;
  });
}
