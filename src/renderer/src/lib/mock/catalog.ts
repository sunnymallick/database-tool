/**
 * OWNER: workbench (UI) slice. In-memory catalogs (schemas, tables, columns,
 * keys, routines, rows) for the mock backend, one per profile + database.
 * Rows are generated lazily on first access and then mutated in place by
 * db.applyChanges / DML in db.query.
 */
import type {
  CheckInfo,
  ConnectionProfile,
  DbKind,
  ForeignKeyInfo,
  IndexInfo,
  RoutineInfo,
  TableKind,
  Value
} from '@shared/types';
import { qualifiedName, quoteIdent } from '@shared/sql';
import {
  COUNTRIES,
  NUL,
  Rng,
  buildShopData,
  orNull,
  pageViewRows,
  shopData,
  vBool,
  vBytes,
  vDate,
  vDec,
  vFloat,
  vInt,
  vJson,
  vText,
  wideColumns,
  wideRows,
  type ShopData
} from './fixtures';

export interface MockColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isIdentity: boolean;
  isGenerated?: boolean;
  comment?: string;
}

export interface MockTable {
  schema: string;
  name: string;
  kind: TableKind;
  comment?: string;
  columns: MockColumn[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  checks: CheckInfo[];
  viewSql?: string;
  generate: (db: MockDatabase) => Value[][];
  rows?: Value[][];
}

export interface MockRoutine extends RoutineInfo {
  body: string;
}

export interface MockDatabase {
  kind: DbKind;
  name: string;
  schemas: string[];
  defaultSchema: string;
  tables: MockTable[];
  routines: MockRoutine[];
}

// ---------------------------------------------------------------------------
// Definition helpers
// ---------------------------------------------------------------------------

interface ColOpts {
  nn?: boolean;
  def?: string;
  ident?: boolean;
  gen?: boolean;
  comment?: string;
}

function c(name: string, type: string, o: ColOpts = {}): MockColumn {
  return {
    name,
    type,
    nullable: !o.nn,
    defaultValue: o.def ?? null,
    isIdentity: o.ident ?? false,
    ...(o.gen ? { isGenerated: true } : {}),
    ...(o.comment ? { comment: o.comment } : {})
  };
}

type FkDef = Omit<ForeignKeyInfo, 'schema' | 'table'>;

interface TableOpts {
  pk?: string[];
  kind?: TableKind;
  comment?: string;
  indexes?: IndexInfo[];
  fks?: FkDef[];
  checks?: CheckInfo[];
  viewSql?: string;
  rows: (db: MockDatabase) => Value[][];
}

function tbl(schema: string, name: string, columns: MockColumn[], o: TableOpts): MockTable {
  return {
    schema,
    name,
    kind: o.kind ?? 'table',
    ...(o.comment ? { comment: o.comment } : {}),
    columns,
    primaryKey: o.pk ?? [],
    indexes: o.indexes ?? [],
    foreignKeys: (o.fks ?? []).map((f) => ({ ...f, schema, table: name })),
    checks: o.checks ?? [],
    ...(o.viewSql ? { viewSql: o.viewSql } : {}),
    generate: o.rows
  };
}

function idx(name: string, columns: string[], unique = false, method?: string): IndexInfo {
  return { name, columns, unique, primary: false, ...(method ? { method } : {}) };
}

/** Add primary-key indexes and pg-style index definitions. */
function finalize(db: MockDatabase): MockDatabase {
  for (const t of db.tables) {
    if (t.kind !== 'table') continue;
    if (t.primaryKey.length > 0 && !t.indexes.some((i) => i.primary)) {
      const name =
        db.kind === 'postgres'
          ? `${t.name}_pkey`
          : db.kind === 'mssql'
            ? `PK_${t.name}`
            : db.kind === 'mysql'
              ? 'PRIMARY'
              : `sqlite_autoindex_${t.name}_1`;
      const isRowid = db.kind === 'sqlite' && t.primaryKey.length === 1 && /^integer$/i.test(colOf(t, t.primaryKey[0])?.type ?? '');
      if (!isRowid) t.indexes.unshift({ name, columns: [...t.primaryKey], unique: true, primary: true, method: methodFor(db.kind, true) });
    }
    for (const i of t.indexes) {
      i.method ??= methodFor(db.kind, i.primary);
      if (!i.definition) i.definition = indexDefinition(db.kind, t, i);
    }
  }
  return db;
}

function methodFor(kind: DbKind, primary: boolean): string | undefined {
  if (kind === 'postgres' || kind === 'mysql') return 'btree';
  if (kind === 'mssql') return primary ? 'CLUSTERED' : 'NONCLUSTERED';
  return undefined;
}

function indexDefinition(kind: DbKind, t: MockTable, i: IndexInfo): string {
  const cols = i.columns.map((x) => (x.includes(' ') ? x : quoteIdent(kind, x))).join(', ');
  if (kind === 'postgres') {
    return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${i.name} ON ${t.schema}.${t.name} USING btree (${i.columns.join(', ')})`;
  }
  if (kind === 'mssql')
    return `CREATE ${i.unique ? 'UNIQUE ' : ''}${i.primary ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${quoteIdent(kind, i.name)} ON ${qualifiedName(kind, t.schema, t.name)} (${cols})`;
  if (kind === 'mysql') return `${i.unique ? 'UNIQUE ' : ''}KEY ${quoteIdent(kind, i.name)} (${cols})`;
  return `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(kind, i.name)} ON ${quoteIdent(kind, t.name)} (${cols})`;
}

export function colOf(t: MockTable, name: string): MockColumn | undefined {
  const lower = name.toLowerCase();
  return t.columns.find((x) => x.name === name) ?? t.columns.find((x) => x.name.toLowerCase() === lower);
}

export function rowsOf(db: MockDatabase, t: MockTable): Value[][] {
  return (t.rows ??= t.generate(db));
}

export function findTable(db: MockDatabase, schema: string, name: string): MockTable | undefined {
  const s = schema.toLowerCase();
  const n = name.toLowerCase();
  return (
    db.tables.find((t) => t.schema === schema && t.name === name) ??
    db.tables.find((t) => t.schema.toLowerCase() === s && t.name.toLowerCase() === n)
  );
}

/** Resolve an unqualified name: default schema first, then a unique match in any schema. */
export function resolveTable(db: MockDatabase, schema: string | null, name: string): MockTable | undefined {
  if (schema) return findTable(db, schema, name);
  const inDefault = findTable(db, db.defaultSchema, name);
  if (inDefault) return inDefault;
  const n = name.toLowerCase();
  const matches = db.tables.filter((t) => t.name.toLowerCase() === n);
  return matches.length === 1 ? matches[0] : undefined;
}

function rowsFor(db: MockDatabase, schema: string, name: string): Value[][] {
  const t = findTable(db, schema, name);
  return t ? rowsOf(db, t) : [];
}

// Timestamp renderers per engine.
const pgTs = (iso: string) => iso.replace('T', ' ').replace('Z', '+00');
const msTs = (iso: string) => iso.replace('T', ' ').replace('Z', '.0000000');
const myTs = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function pgShopTables(data: () => ShopData, extended: boolean): MockTable[] {
  const customers = tbl(
    'public',
    'customers',
    [
      c('id', 'int8', { nn: true, ident: true, def: "nextval('customers_id_seq'::regclass)" }),
      c('external_id', 'uuid', { nn: true, def: 'gen_random_uuid()', comment: 'Stable id shared with the CRM' }),
      c('email', 'varchar(255)', { nn: true }),
      c('full_name', 'text'),
      c('country', 'bpchar(2)', { nn: true, def: "'US'::bpchar" }),
      c('created_at', 'timestamptz', { nn: true, def: 'now()' }),
      c('is_active', 'bool', { nn: true, def: 'true' }),
      c('metadata', 'jsonb'),
      c('tags', '_text', { nn: true, def: "'{}'::text[]" })
    ],
    {
      pk: ['id'],
      comment: 'People who have placed or may place orders',
      indexes: [idx('customers_email_key', ['email'], true)],
      rows: () =>
        data().customers.map((x) => [
          vInt(x.id),
          vText(x.externalId),
          vText(x.email),
          x.fullName ? vText(x.fullName) : NUL,
          vText(x.country),
          vDate(pgTs(x.createdAt)),
          vBool(x.isActive),
          orNull(x.metadata, vJson),
          vJson(x.metadata ? ['vip'] : [])
        ])
    }
  );
  const products = tbl(
    'public',
    'products',
    [
      c('id', 'int4', { nn: true, ident: true }),
      c('sku', 'text', { nn: true }),
      c('name', 'text', { nn: true }),
      c('price', 'numeric(10,2)', { nn: true }),
      c('stock', 'int4', { nn: true, def: '0' }),
      c('category', 'text'),
      c('image', 'bytea'),
      c('weight_kg', 'float4'),
      c('restock_every', 'interval')
    ],
    {
      pk: ['id'],
      indexes: [idx('products_sku_key', ['sku'], true)],
      checks: [{ name: 'products_price_check', definition: 'CHECK ((price >= (0)::numeric))' }],
      rows: () =>
        data().products.map((p) => [
          vInt(p.id),
          vText(p.sku),
          vText(p.name),
          vDec(p.price),
          vInt(p.stock + 1000),
          vText(p.category),
          orNull(p.image, vBytes),
          orNull(p.weightKg, vFloat),
          orNull(p.restockEvery, vDate)
        ])
    }
  );
  if (!extended) return [customers, products];

  const eventLog = tbl(
    'public',
    'event_log',
    [c('happened_at', 'timestamptz', { nn: true }), c('level', 'text', { nn: true }), c('message', 'text', { nn: true }), c('context', 'json')],
    { rows: () => data().events.map((e) => [vDate(pgTs(e.happenedAt)), vText(e.level), vText(e.message), orNull(e.context, vJson)]) }
  );
  const pageViews = tbl(
    'public',
    'page_views',
    [
      c('id', 'int8', { nn: true, ident: true }),
      c('session_id', 'uuid', { nn: true }),
      c('path', 'text', { nn: true }),
      c('referrer', 'text'),
      c('user_agent', 'text', { nn: true }),
      c('viewed_at', 'timestamptz', { nn: true, def: 'now()' }),
      c('duration_ms', 'int4', { nn: true, def: '0' })
    ],
    {
      pk: ['id'],
      comment: 'Raw page view stream (20k rows, for grid virtualization)',
      indexes: [idx('idx_page_views_session', ['session_id']), idx('idx_page_views_viewed_at', ['viewed_at'])],
      rows: () => pageViewRows(20_000)
    }
  );
  const wideTypes: Record<string, string> = { int: 'int4', float: 'float8', decimal: 'numeric(12,2)', text: 'text', bool: 'bool', datetime: 'timestamptz' };
  const wideMetrics = tbl(
    'public',
    'wide_metrics',
    [c('id', 'int8', { nn: true, ident: true }), ...wideColumns().map((w) => c(w.name, wideTypes[w.kind]))],
    { pk: ['id'], comment: '60 mixed-type columns (for horizontal virtualization)', rows: () => wideRows(5_000) }
  );
  const orders = tbl(
    'sales',
    'orders',
    [
      c('id', 'int8', { nn: true, ident: true }),
      c('customer_id', 'int8', { nn: true }),
      c('status', 'sales.order_status', { nn: true, def: "'pending'::sales.order_status" }),
      c('total', 'numeric(12,2)', { nn: true, def: '0' }),
      c('placed_at', 'timestamptz', { nn: true }),
      c('ship_date', 'date'),
      c('notes', 'text')
    ],
    {
      pk: ['id'],
      indexes: [idx('idx_orders_customer', ['customer_id']), idx('idx_orders_status_placed', ['status', 'placed_at DESC'])],
      fks: [
        {
          name: 'orders_customer_id_fkey',
          columns: ['customer_id'],
          refSchema: 'public',
          refTable: 'customers',
          refColumns: ['id'],
          onUpdate: 'NO ACTION',
          onDelete: 'CASCADE'
        }
      ],
      rows: () =>
        data().orders.map((o) => [
          vInt(o.id),
          vInt(o.customerId),
          vText(o.status),
          vDec(o.total),
          vDate(pgTs(o.placedAt)),
          orNull(o.shipDate, vDate),
          orNull(o.notes, vText)
        ])
    }
  );
  const orderItems = tbl(
    'sales',
    'order_items',
    [
      c('order_id', 'int8', { nn: true }),
      c('product_id', 'int4', { nn: true }),
      c('quantity', 'int4', { nn: true }),
      c('unit_price', 'numeric(10,2)', { nn: true })
    ],
    {
      pk: ['order_id', 'product_id'],
      fks: [
        { name: 'order_items_order_id_fkey', columns: ['order_id'], refSchema: 'sales', refTable: 'orders', refColumns: ['id'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
        { name: 'order_items_product_id_fkey', columns: ['product_id'], refSchema: 'public', refTable: 'products', refColumns: ['id'], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' }
      ],
      checks: [{ name: 'order_items_quantity_check', definition: 'CHECK ((quantity > 0))' }],
      rows: () => data().items.map((i) => [vInt(i.orderId), vInt(i.productId), vInt(i.quantity), vDec(i.unitPrice)])
    }
  );
  const totals = tbl(
    'sales',
    'customer_order_totals',
    [c('customer_id', 'int8'), c('full_name', 'text'), c('country', 'bpchar(2)'), c('order_count', 'int8'), c('lifetime_value', 'numeric(14,2)')],
    {
      kind: 'view',
      viewSql: ` SELECT c.id AS customer_id,
    c.full_name,
    c.country,
    count(o.id) AS order_count,
    (COALESCE(sum(o.total), (0)::numeric))::numeric(14,2) AS lifetime_value
   FROM (public.customers c
     LEFT JOIN sales.orders o ON (((o.customer_id = c.id) AND (o.status <> 'cancelled'::sales.order_status))))
  GROUP BY c.id;`,
      rows: () => customerTotals(data()).map((r) => [vInt(r.id), r.name ? vText(r.name) : NUL, vText(r.country), vInt(r.count), vDec(r.value)])
    }
  );
  const daily = tbl(
    'sales',
    'daily_revenue',
    [c('day', 'date'), c('orders', 'int8'), c('revenue', 'numeric')],
    {
      kind: 'materialized_view',
      viewSql: ` SELECT (date_trunc('day'::text, orders.placed_at))::date AS day,
    count(*) AS orders,
    sum(orders.total) AS revenue
   FROM sales.orders
  WHERE (orders.status <> 'cancelled'::sales.order_status)
  GROUP BY ((date_trunc('day'::text, orders.placed_at))::date);`,
      rows: () => dailyRevenue(data(), 10).map((r) => [vDate(r.key), vInt(r.count), vDec(r.sum)])
    }
  );
  return [customers, products, eventLog, pageViews, wideMetrics, orders, orderItems, totals, daily];
}

interface TotalsRow {
  id: number;
  name: string;
  country: string;
  count: number;
  value: number;
}

function customerTotals(d: ShopData): TotalsRow[] {
  const map = new Map<number, TotalsRow>();
  for (const cu of d.customers) map.set(cu.id, { id: cu.id, name: cu.fullName, country: cu.country, count: 0, value: 0 });
  for (const o of d.orders) {
    if (o.status === 'cancelled') continue;
    const r = map.get(o.customerId);
    if (r) {
      r.count++;
      r.value += Number(o.total);
    }
  }
  return [...map.values()];
}

/** Group non-cancelled orders by a prefix of placedAt (10 = day, 7 = month). */
function dailyRevenue(d: ShopData, prefix: number): { key: string; count: number; sum: number }[] {
  const map = new Map<string, { key: string; count: number; sum: number }>();
  for (const o of d.orders) {
    if (o.status === 'cancelled') continue;
    const key = o.placedAt.slice(0, prefix);
    const r = map.get(key) ?? { key, count: 0, sum: 0 };
    r.count++;
    r.sum += Number(o.total);
    map.set(key, r);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

const PG_ROUTINES: MockRoutine[] = [
  {
    schema: 'sales',
    name: 'customer_lifetime_value',
    kind: 'function',
    signature: 'p_customer bigint',
    returns: 'numeric',
    body: `CREATE OR REPLACE FUNCTION sales.customer_lifetime_value(p_customer bigint)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$ SELECT coalesce(sum(total), 0) FROM sales.orders WHERE customer_id = p_customer AND status <> 'cancelled' $function$
`
  },
  {
    schema: 'sales',
    name: 'cancel_stale_orders',
    kind: 'procedure',
    signature: 'IN p_days integer',
    body: `CREATE OR REPLACE PROCEDURE sales.cancel_stale_orders(IN p_days integer)
 LANGUAGE plpgsql
AS $procedure$
BEGIN
  UPDATE sales.orders
     SET status = 'cancelled'
   WHERE status = 'pending'
     AND placed_at < now() - make_interval(days => p_days);
END
$procedure$
`
  },
  {
    schema: 'sales',
    name: 'touch_stock',
    kind: 'function',
    signature: '',
    returns: 'trigger',
    body: `CREATE OR REPLACE FUNCTION sales.touch_stock()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE public.products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
  RETURN NEW;
END
$function$
`
  }
];

function pgShop(name: string): MockDatabase {
  return finalize({
    kind: 'postgres',
    name,
    schemas: ['public', 'sales'],
    defaultSchema: 'public',
    tables: pgShopTables(shopData, true),
    routines: PG_ROUTINES.map((r) => ({ ...r }))
  });
}

function pgStaging(name: string): MockDatabase {
  let cache: ShopData | null = null;
  return finalize({
    kind: 'postgres',
    name,
    schemas: ['public'],
    defaultSchema: 'public',
    tables: pgShopTables(() => (cache ??= buildShopData(0.125)), false),
    routines: []
  });
}

function pgInventory(name: string): MockDatabase {
  const cities = ['Rotterdam', 'Memphis', 'Leipzig', 'Reno', 'Osaka'];
  return finalize({
    kind: 'postgres',
    name,
    schemas: ['public'],
    defaultSchema: 'public',
    tables: [
      tbl('public', 'warehouses', [c('id', 'int4', { nn: true, ident: true }), c('code', 'text', { nn: true }), c('city', 'text', { nn: true }), c('opened_on', 'date')], {
        pk: ['id'],
        indexes: [idx('warehouses_code_key', ['code'], true)],
        rows: () => cities.map((city, i) => [vInt(i + 1), vText(`WH-${String(i + 1).padStart(2, '0')}`), vText(city), i === 4 ? NUL : vDate(`20${18 + i}-0${i + 2}-01`)])
      }),
      tbl(
        'public',
        'stock_levels',
        [c('warehouse_id', 'int4', { nn: true }), c('product_sku', 'text', { nn: true }), c('qty', 'int4', { nn: true, def: '0' }), c('updated_at', 'timestamptz', { nn: true, def: 'now()' })],
        {
          pk: ['warehouse_id', 'product_sku'],
          fks: [{ name: 'stock_levels_warehouse_id_fkey', columns: ['warehouse_id'], refSchema: 'public', refTable: 'warehouses', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
          rows: () => {
            const rng = new Rng(5);
            const out: Value[][] = [];
            for (let w = 1; w <= cities.length; w++)
              for (let p = 1; p <= 40; p++)
                out.push([vInt(w), vText(`SKU-${1000 + p}`), vInt(rng.int(0, 900)), vDate(`2026-10-${String(rng.int(1, 12)).padStart(2, '0')} ${String(rng.int(0, 23)).padStart(2, '0')}:15:00+00`)]);
            return out;
          }
        }
      )
    ],
    routines: []
  });
}

function emptyDb(kind: DbKind, name: string, schema: string): MockDatabase {
  return { kind, name, schemas: [schema], defaultSchema: schema, tables: [], routines: [] };
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

const SEGMENTS = ['Enterprise', 'SMB', 'Consumer', 'Public Sector'];

function mssqlReporting(name: string): MockDatabase {
  const d = shopData;
  const tables: MockTable[] = [
    tbl(
      'dbo',
      'Customers',
      [
        c('CustomerId', 'int', { nn: true, ident: true }),
        c('ExternalRef', 'uniqueidentifier', { nn: true, def: '(newid())' }),
        c('Email', 'nvarchar(255)', { nn: true }),
        c('FullName', 'nvarchar(200)'),
        c('CountryCode', 'char(2)', { nn: true, def: "('US')" }),
        c('CreatedAt', 'datetime2', { nn: true, def: '(sysutcdatetime())' }),
        c('IsActive', 'bit', { nn: true, def: '((1))' }),
        c('Segment', 'nvarchar(20)')
      ],
      {
        pk: ['CustomerId'],
        indexes: [idx('UX_Customers_Email', ['Email'], true)],
        rows: () =>
          d().customers.map((x, i) => [
            vInt(x.id),
            vText(x.externalId.toUpperCase()),
            vText(x.email),
            x.fullName ? vText(x.fullName) : NUL,
            vText(x.country),
            vDate(msTs(x.createdAt)),
            vBool(x.isActive),
            i % 7 === 0 ? NUL : vText(SEGMENTS[i % SEGMENTS.length])
          ])
      }
    ),
    tbl(
      'dbo',
      'Orders',
      [
        c('OrderId', 'int', { nn: true, ident: true }),
        c('CustomerId', 'int', { nn: true }),
        c('Status', 'nvarchar(20)', { nn: true, def: "(N'pending')" }),
        c('Total', 'decimal(12,2)', { nn: true, def: '((0))' }),
        c('PlacedAt', 'datetime2', { nn: true }),
        c('ShippedOn', 'date'),
        c('Notes', 'nvarchar(max)')
      ],
      {
        pk: ['OrderId'],
        indexes: [idx('IX_Orders_CustomerId', ['CustomerId']), idx('IX_Orders_Status_PlacedAt', ['Status', 'PlacedAt'])],
        fks: [{ name: 'FK_Orders_Customers', columns: ['CustomerId'], refSchema: 'dbo', refTable: 'Customers', refColumns: ['CustomerId'], onDelete: 'CASCADE', onUpdate: 'NO_ACTION' }],
        checks: [{ name: 'CK_Orders_Status', definition: "([Status]='cancelled' OR [Status]='delivered' OR [Status]='shipped' OR [Status]='paid' OR [Status]='pending')" }],
        rows: () =>
          d().orders.map((o) => [vInt(o.id), vInt(o.customerId), vText(o.status), vDec(o.total), vDate(msTs(o.placedAt)), orNull(o.shipDate, vDate), orNull(o.notes, vText)])
      }
    ),
    tbl(
      'dbo',
      'OrderLines',
      [
        c('OrderLineId', 'int', { nn: true, ident: true }),
        c('OrderId', 'int', { nn: true }),
        c('Sku', 'nvarchar(32)', { nn: true }),
        c('Quantity', 'int', { nn: true }),
        c('UnitPrice', 'decimal(10,2)', { nn: true }),
        c('LineTotal', 'decimal(21,2)', { gen: true, def: '([Quantity]*[UnitPrice])' })
      ],
      {
        pk: ['OrderLineId'],
        indexes: [idx('IX_OrderLines_OrderId', ['OrderId'])],
        fks: [{ name: 'FK_OrderLines_Orders', columns: ['OrderId'], refSchema: 'dbo', refTable: 'Orders', refColumns: ['OrderId'], onDelete: 'CASCADE', onUpdate: 'NO_ACTION' }],
        checks: [{ name: 'CK_OrderLines_Quantity', definition: '([Quantity]>(0))' }],
        rows: () => {
          const skus = new Map(d().products.map((p) => [p.id, p.sku]));
          return d().items.map((i, n) => [
            vInt(n + 1),
            vInt(i.orderId),
            vText(skus.get(i.productId) ?? 'SKU-0000'),
            vInt(i.quantity),
            vDec(i.unitPrice),
            vDec(i.quantity * Number(i.unitPrice))
          ]);
        }
      }
    ),
    tbl('dbo', 'vw_MonthlyRevenue', [c('Month', 'char(7)'), c('Orders', 'int'), c('Revenue', 'decimal(14,2)')], {
      kind: 'view',
      viewSql: `CREATE VIEW [dbo].[vw_MonthlyRevenue]
AS
SELECT CONVERT(char(7), o.PlacedAt, 126) AS [Month],
       COUNT(*) AS Orders,
       CAST(SUM(o.Total) AS decimal(14,2)) AS Revenue
FROM dbo.Orders AS o
WHERE o.Status <> N'cancelled'
GROUP BY CONVERT(char(7), o.PlacedAt, 126);`,
      rows: () => dailyRevenue(d(), 7).map((r) => [vText(r.key), vInt(r.count), vDec(r.sum)])
    }),
    tbl(
      'reporting',
      'KpiSnapshots',
      [
        c('SnapshotId', 'bigint', { nn: true, ident: true }),
        c('SnapshotDate', 'date', { nn: true }),
        c('Kpi', 'nvarchar(50)', { nn: true }),
        c('Value', 'decimal(18,4)', { nn: true }),
        c('Notes', 'nvarchar(400)')
      ],
      {
        pk: ['SnapshotId'],
        indexes: [idx('UX_KpiSnapshots_Date_Kpi', ['SnapshotDate', 'Kpi'], true)],
        rows: () => {
          const rng = new Rng(11);
          const kpis = ['Revenue', 'Orders', 'AvgOrderValue', 'ActiveCustomers', 'RefundRate', 'ChurnRate'];
          const out: Value[][] = [];
          let id = 1;
          for (let day = 0; day < 30; day++) {
            const date = new Date(Date.UTC(2026, 8, 14) + day * 86_400_000).toISOString().slice(0, 10);
            for (const k of kpis) out.push([vInt(id++), vDate(date), vText(k), vDec((rng.next() * 50_000).toFixed(4), 4), rng.next() < 0.1 ? vText('Backfilled after ETL outage') : NUL]);
          }
          return out;
        }
      }
    )
  ];
  return finalize({
    kind: 'mssql',
    name,
    schemas: ['dbo', 'reporting'],
    defaultSchema: 'dbo',
    tables,
    routines: [
      {
        schema: 'dbo',
        name: 'usp_RefreshKpis',
        kind: 'procedure',
        signature: '@AsOf date = NULL',
        body: `CREATE PROCEDURE [dbo].[usp_RefreshKpis]
    @AsOf date = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET @AsOf = COALESCE(@AsOf, CAST(SYSUTCDATETIME() AS date));

    DELETE FROM reporting.KpiSnapshots WHERE SnapshotDate = @AsOf;

    INSERT INTO reporting.KpiSnapshots (SnapshotDate, Kpi, [Value])
    SELECT @AsOf, N'Revenue', SUM(Total) FROM dbo.Orders WHERE CAST(PlacedAt AS date) = @AsOf AND Status <> N'cancelled'
    UNION ALL
    SELECT @AsOf, N'Orders', COUNT(*) FROM dbo.Orders WHERE CAST(PlacedAt AS date) = @AsOf;
END`
      },
      {
        schema: 'dbo',
        name: 'fn_FiscalQuarter',
        kind: 'function',
        signature: '@d date',
        returns: 'int',
        body: `CREATE FUNCTION [dbo].[fn_FiscalQuarter] (@d date)
RETURNS int
AS
BEGIN
    -- Fiscal year starts in July.
    RETURN ((MONTH(@d) + 5) % 12) / 3 + 1;
END`
      }
    ]
  });
}

function mssqlArchive(name: string): MockDatabase {
  const year = (y: number) =>
    tbl(
      'dbo',
      `Orders${y}`,
      [
        c('OrderId', 'int', { nn: true }),
        c('CustomerId', 'int', { nn: true }),
        c('Status', 'nvarchar(20)', { nn: true }),
        c('Total', 'decimal(12,2)', { nn: true }),
        c('PlacedAt', 'datetime2', { nn: true }),
        c('ArchivedAt', 'datetime2', { nn: true, def: '(sysutcdatetime())' })
      ],
      {
        pk: ['OrderId'],
        rows: () => {
          const rng = new Rng(y);
          const out: Value[][] = [];
          for (let i = 1; i <= 400; i++) {
            const placed = isoSec(Date.UTC(y, 0, 1) + rng.int(0, 364) * 86_400_000 + rng.int(0, 86_399) * 1000);
            out.push([vInt(y * 10_000 + i), vInt(rng.int(1, 200)), vText(rng.pick(['delivered', 'cancelled', 'delivered', 'shipped'])), vDec(rng.int(500, 90_000) / 100), vDate(msTs(placed)), vDate(`${y + 1}-01-15 03:00:00.0000000`)]);
          }
          return out;
        }
      }
    );
  return finalize({ kind: 'mssql', name, schemas: ['dbo'], defaultSchema: 'dbo', tables: [year(2019), year(2020)], routines: [] });
}

function mssqlStaging(name: string): MockDatabase {
  return finalize({
    kind: 'mssql',
    name,
    schemas: ['dbo'],
    defaultSchema: 'dbo',
    tables: [
      tbl(
        'dbo',
        'ImportBatches',
        [c('BatchId', 'int', { nn: true, ident: true }), c('FileName', 'nvarchar(260)', { nn: true }), c('RowsLoaded', 'int'), c('LoadedAt', 'datetime2', { nn: true }), c('Status', 'nvarchar(20)', { nn: true })],
        {
          pk: ['BatchId'],
          rows: () =>
            Array.from({ length: 24 }, (_, i) => [
              vInt(i + 1),
              vText(`\\\\fileshare\\drops\\orders_2026${String(9 + Math.floor(i / 12)).padStart(2, '0')}${String((i % 12) + 1).padStart(2, '0')}.csv`),
              i === 17 ? NUL : vInt(1200 + i * 37),
              vDate(`2026-10-${String((i % 12) + 1).padStart(2, '0')} 02:${String(i).padStart(2, '0')}:00.0000000`),
              vText(i === 17 ? 'failed' : 'loaded')
            ])
        }
      )
    ],
    routines: []
  });
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

function sqliteSample(): MockDatabase {
  const d = shopData;
  const tables: MockTable[] = [
    tbl(
      'main',
      'customers',
      [
        c('id', 'INTEGER', { nn: true }),
        c('email', 'TEXT', { nn: true }),
        c('full_name', 'TEXT'),
        c('country', 'TEXT', { nn: true, def: "'US'" }),
        c('created_at', 'TEXT', { nn: true, def: "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')" }),
        c('is_active', 'BOOLEAN', { nn: true, def: '1' }),
        c('metadata', 'JSON')
      ],
      {
        pk: ['id'],
        indexes: [idx('sqlite_autoindex_customers_1', ['email'], true)],
        rows: () =>
          d().customers.map((x) => [
            vInt(x.id),
            vText(x.email),
            x.fullName ? vText(x.fullName) : NUL,
            vText(x.country),
            vText(x.createdAt),
            vInt(x.isActive ? 1 : 0),
            x.metadata ? vText(JSON.stringify(x.metadata)) : NUL
          ])
      }
    ),
    tbl(
      'main',
      'products',
      [
        c('id', 'INTEGER', { nn: true }),
        c('sku', 'TEXT', { nn: true }),
        c('name', 'TEXT', { nn: true }),
        c('price', 'NUMERIC(10,2)', { nn: true }),
        c('stock', 'INTEGER', { nn: true, def: '0' }),
        c('category', 'TEXT'),
        c('image', 'BLOB')
      ],
      {
        pk: ['id'],
        indexes: [idx('sqlite_autoindex_products_1', ['sku'], true)],
        checks: [{ name: '', definition: 'CHECK (price >= 0)' }],
        rows: () =>
          d().products.map((p) => [vInt(p.id), vText(p.sku), vText(p.name), vFloat(Number(p.price)), vInt(p.stock + 1000), vText(p.category), orNull(p.image, vBytes)])
      }
    ),
    tbl(
      'main',
      'orders',
      [
        c('id', 'INTEGER', { nn: true, ident: true }),
        c('customer_id', 'INTEGER', { nn: true }),
        c('status', 'TEXT', { nn: true }),
        c('total', 'NUMERIC(12,2)', { nn: true, def: '0' }),
        c('placed_at', 'TEXT', { nn: true }),
        c('notes', 'TEXT')
      ],
      {
        pk: ['id'],
        indexes: [idx('idx_orders_customer', ['customer_id']), idx('idx_orders_status_placed', ['status', 'placed_at'])],
        fks: [{ name: '', columns: ['customer_id'], refSchema: 'main', refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }],
        checks: [{ name: '', definition: "CHECK (status IN ('pending','paid','shipped','delivered','cancelled'))" }],
        rows: () => d().orders.map((o) => [vInt(o.id), vInt(o.customerId), vText(o.status), vFloat(Number(o.total)), vText(o.placedAt), orNull(o.notes, vText)])
      }
    ),
    tbl(
      'main',
      'order_items',
      [c('order_id', 'INTEGER', { nn: true }), c('product_id', 'INTEGER', { nn: true }), c('quantity', 'INTEGER', { nn: true }), c('unit_price', 'NUMERIC(10,2)', { nn: true })],
      {
        pk: ['order_id', 'product_id'],
        fks: [
          { name: '', columns: ['order_id'], refSchema: 'main', refTable: 'orders', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
          { name: '', columns: ['product_id'], refSchema: 'main', refTable: 'products', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }
        ],
        checks: [{ name: '', definition: 'CHECK (quantity > 0)' }],
        rows: () => d().items.map((i) => [vInt(i.orderId), vInt(i.productId), vInt(i.quantity), vFloat(Number(i.unitPrice))])
      }
    ),
    tbl('main', 'event_log', [c('happened_at', 'TEXT', { nn: true }), c('level', 'TEXT', { nn: true }), c('message', 'TEXT', { nn: true })], {
      rows: () => d().events.map((e) => [vText(e.happenedAt), vText(e.level), vText(e.message)])
    }),
    tbl('main', 'customer_order_totals', [c('customer_id', 'INTEGER'), c('full_name', 'TEXT'), c('country', 'TEXT'), c('order_count', ''), c('lifetime_value', '')], {
      kind: 'view',
      viewSql: `CREATE VIEW customer_order_totals AS
      SELECT c.id AS customer_id, c.full_name, c.country, COUNT(o.id) AS order_count, ROUND(COALESCE(SUM(o.total), 0), 2) AS lifetime_value
      FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
      GROUP BY c.id`,
      rows: () => customerTotals(d()).map((r) => [vInt(r.id), r.name ? vText(r.name) : NUL, vText(r.country), vInt(r.count), vFloat(Math.round(r.value * 100) / 100)])
    })
  ];
  return finalize({ kind: 'sqlite', name: 'main', schemas: ['main'], defaultSchema: 'main', tables, routines: [] });
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

function mysqlAnalytics(database: string): MockDatabase {
  const sessionRows = (): Value[][] => {
    const rng = new Rng(21);
    const out: Value[][] = [];
    for (let id = 1; id <= 3000; id++) {
      const start = Date.UTC(2026, 6, 1) + id * 2_400_000 + rng.int(0, 600_000);
      const ended = rng.next() < 0.08 ? null : start + rng.int(10, 3600) * 1000;
      out.push([
        vInt(id),
        rng.next() < 0.25 ? NUL : vInt(rng.int(1, 900)),
        vDate(myTs(isoSec(start))),
        ended === null ? NUL : vDate(myTs(isoSec(ended))),
        vText(rng.pick(['desktop', 'mobile', 'mobile', 'tablet'])),
        vText(rng.pick(COUNTRIES)),
        vInt(rng.int(1, 40))
      ]);
    }
    return out;
  };
  const tables: MockTable[] = [
    tbl(
      'analytics',
      'sessions',
      [
        c('id', 'bigint unsigned', { nn: true, ident: true }),
        c('user_id', 'int'),
        c('started_at', 'datetime', { nn: true }),
        c('ended_at', 'datetime'),
        c('device', "enum('desktop','mobile','tablet')", { nn: true, def: 'desktop' }),
        c('country', 'char(2)', { nn: true }),
        c('pages', 'int', { nn: true, def: '1' })
      ],
      { pk: ['id'], indexes: [idx('idx_sessions_started', ['started_at']), idx('idx_sessions_user', ['user_id'])], rows: sessionRows }
    ),
    tbl(
      'analytics',
      'pageviews',
      [
        c('id', 'bigint unsigned', { nn: true, ident: true }),
        c('session_id', 'bigint unsigned', { nn: true }),
        c('url', 'varchar(512)', { nn: true }),
        c('viewed_at', 'datetime(3)', { nn: true }),
        c('load_ms', 'int')
      ],
      {
        pk: ['id'],
        indexes: [idx('fk_pageviews_session', ['session_id'])],
        fks: [{ name: 'fk_pageviews_session', columns: ['session_id'], refSchema: 'analytics', refTable: 'sessions', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' }],
        rows: () => {
          const rng = new Rng(23);
          const urls = ['https://shop.example.com/', 'https://shop.example.com/products', 'https://shop.example.com/cart', 'https://shop.example.com/checkout?step=2', 'https://shop.example.com/help'];
          return Array.from({ length: 8000 }, (_, i) => [
            vInt(i + 1),
            vInt(rng.int(1, 3000)),
            vText(rng.pick(urls)),
            vDate(myTs(new Date(Date.UTC(2026, 6, 1) + i * 900_000 + rng.int(0, 899_999)).toISOString())),
            rng.next() < 0.05 ? NUL : vInt(rng.int(80, 4200))
          ]);
        }
      }
    ),
    tbl('analytics', 'daily_active_users', [c('day', 'date'), c('users', 'bigint')], {
      kind: 'view',
      viewSql: 'select cast(`s`.`started_at` as date) AS `day`,count(distinct `s`.`user_id`) AS `users` from `analytics`.`sessions` `s` group by cast(`s`.`started_at` as date)',
      rows: (db) => {
        const map = new Map<string, Set<string>>();
        for (const r of rowsFor(db, 'analytics', 'sessions')) {
          const day = (r[2] as { v: string }).v.slice(0, 10);
          const set = map.get(day) ?? new Set<string>();
          if (r[1].t === 'int') set.add(r[1].v);
          map.set(day, set);
        }
        return [...map.entries()].sort().map(([day, set]) => [vDate(day), vInt(set.size)]);
      }
    }),
    tbl('analytics_raw', 'raw_events', [c('received_at', 'datetime(6)', { nn: true }), c('source', 'varchar(64)', { nn: true }), c('payload', 'json', { nn: true })], {
      rows: () => {
        const rng = new Rng(29);
        return Array.from({ length: 500 }, (_, i) => [
          vDate(myTs(new Date(Date.UTC(2026, 9, 1) + i * 61_000).toISOString()).replace(/\.(\d{3})$/, '.$1000')),
          vText(rng.pick(['web', 'ios', 'android', 'webhook'])),
          vJson({ type: rng.pick(['click', 'view', 'purchase', 'signup']), user: rng.int(1, 900), props: { ab: rng.pick(['A', 'B']), ms: rng.int(1, 999) } })
        ]);
      }
    })
  ];
  const schemas = ['analytics', 'analytics_raw'];
  return finalize({
    kind: 'mysql',
    name: database,
    schemas,
    defaultSchema: schemas.includes(database) ? database : 'analytics',
    tables,
    routines: []
  });
}

// ---------------------------------------------------------------------------
// Catalog lookup
// ---------------------------------------------------------------------------

const catalogs = new Map<string, MockDatabase>();

export function resolveDatabase(profile: ConnectionProfile, database?: string): string {
  if (profile.kind === 'sqlite') return 'main';
  return database || profile.database || (profile.kind === 'mssql' ? 'master' : profile.kind === 'postgres' ? 'postgres' : '');
}

export function catalogFor(profile: ConnectionProfile, database?: string): MockDatabase {
  const name = resolveDatabase(profile, database);
  const key = `${profile.id}::${profile.kind}::${name}`;
  let db = catalogs.get(key);
  if (!db) {
    db = buildCatalog(profile.kind, name);
    catalogs.set(key, db);
  }
  return db;
}

function buildCatalog(kind: DbKind, name: string): MockDatabase {
  const n = name.toLowerCase();
  switch (kind) {
    case 'postgres':
      if (n === 'shop_staging') return pgStaging(name);
      if (n === 'inventory') return pgInventory(name);
      if (n === 'postgres') return emptyDb(kind, name, 'public');
      return pgShop(name);
    case 'mssql':
      if (n === 'reportingarchive') return mssqlArchive(name);
      if (n === 'staging') return mssqlStaging(name);
      if (n === 'master') return emptyDb(kind, name, 'dbo');
      return mssqlReporting(name);
    case 'mysql':
      if (n === 'information_schema') return emptyDb(kind, name, 'information_schema');
      return mysqlAnalytics(name || 'analytics');
    case 'sqlite':
      return sqliteSample();
  }
}

export function databasesFor(profile: ConnectionProfile): string[] {
  const base: Record<DbKind, string[]> = {
    postgres: ['postgres', 'shop', 'shop_staging', 'inventory'],
    mssql: ['master', 'Reporting', 'ReportingArchive', 'Staging'],
    mysql: ['analytics', 'analytics_raw', 'information_schema'],
    sqlite: ['main']
  };
  const list = [...base[profile.kind]];
  if (profile.kind !== 'sqlite')
    for (const d of [profile.database, ...profile.extraDatabases]) if (d && !list.includes(d)) list.push(d);
  return list;
}

export function serverVersion(kind: DbKind): string {
  switch (kind) {
    case 'postgres':
      return 'PostgreSQL 17.2';
    case 'mssql':
      return 'Microsoft SQL Server 2022 (RTM-CU14) 16.0.4135.4';
    case 'sqlite':
      return 'SQLite 3.50.4';
    case 'mysql':
      return 'MySQL 8.4.3';
  }
}

// ---------------------------------------------------------------------------
// DDL rendering
// ---------------------------------------------------------------------------

export function tableDdl(db: MockDatabase, t: MockTable): string {
  const k = db.kind;
  const q = (s: string) => quoteIdent(k, s);
  const full = k === 'sqlite' ? q(t.name) : qualifiedName(k, t.schema, t.name);
  if (t.kind !== 'table') {
    if (k === 'postgres') return `CREATE ${t.kind === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW'} ${t.schema}.${t.name} AS\n${t.viewSql ?? ''}`;
    if (k === 'mysql') return `CREATE ALGORITHM=UNDEFINED DEFINER=\`admin\`@\`%\` SQL SECURITY DEFINER VIEW ${full} AS ${t.viewSql ?? ''}`;
    return t.viewSql ?? `CREATE VIEW ${full} AS SELECT 1`;
  }
  const lines: string[] = [];
  for (const col of t.columns) {
    let line = `  ${q(col.name)} ${col.type}`;
    if (k === 'postgres' && col.isIdentity && !col.defaultValue) line += ' GENERATED BY DEFAULT AS IDENTITY';
    if (k === 'mssql' && col.isIdentity) line += ' IDENTITY(1,1)';
    if (k === 'mysql' && col.isIdentity) line += ' AUTO_INCREMENT';
    if (col.isGenerated && col.defaultValue) {
      line = `  ${q(col.name)} AS ${col.defaultValue}`;
    } else {
      if (!col.nullable) line += ' NOT NULL';
      if (col.defaultValue) {
        const bare = k !== 'mysql' || /^[-\d(]|^current_timestamp/i.test(col.defaultValue);
        line += ` DEFAULT ${bare ? col.defaultValue : `'${col.defaultValue}'`}`;
      }
    }
    if (k === 'mysql' && col.comment) line += ` COMMENT '${col.comment.replace(/'/g, "''")}'`;
    lines.push(line);
  }
  if (t.primaryKey.length) {
    const pkName = k === 'postgres' ? `CONSTRAINT ${q(`${t.name}_pkey`)} ` : k === 'mssql' ? `CONSTRAINT ${q(`PK_${t.name}`)} ` : '';
    lines.push(`  ${pkName}PRIMARY KEY (${t.primaryKey.map(q).join(', ')})`);
  }
  for (const i of t.indexes) {
    if (i.unique && !i.primary && k !== 'sqlite') lines.push(`  CONSTRAINT ${q(i.name)} UNIQUE (${i.columns.map(q).join(', ')})`);
  }
  for (const fk of t.foreignKeys) {
    const ref = k === 'sqlite' ? q(fk.refTable) : qualifiedName(k, fk.refSchema, fk.refTable);
    let line = `  ${fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''}FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(q).join(', ')})`;
    if (fk.onDelete && !/no.action/i.test(fk.onDelete)) line += ` ON DELETE ${fk.onDelete}`;
    lines.push(line);
  }
  for (const ch of t.checks) {
    const def = ch.definition.startsWith('CHECK') ? ch.definition : `CHECK ${ch.definition}`;
    lines.push(`  ${ch.name ? `CONSTRAINT ${q(ch.name)} ` : ''}${def}`);
  }
  let out = `CREATE TABLE ${full} (\n${lines.join(',\n')}\n)`;
  if (k === 'mysql') out += ` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci${t.comment ? ` COMMENT='${t.comment.replace(/'/g, "''")}'` : ''}`;
  out += ';';
  for (const i of t.indexes) {
    if (i.unique || i.primary) continue;
    if (k === 'postgres') out += `\n\n${i.definition};`;
    else if (k === 'mssql') out += `\nGO\n\n${i.definition};`;
    else if (k === 'sqlite') out += `\n\n${i.definition};`;
  }
  if (k === 'postgres') {
    if (t.comment) out += `\n\nCOMMENT ON TABLE ${t.schema}.${t.name} IS '${t.comment.replace(/'/g, "''")}';`;
    for (const col of t.columns)
      if (col.comment) out += `\nCOMMENT ON COLUMN ${t.schema}.${t.name}.${col.name} IS '${col.comment.replace(/'/g, "''")}';`;
  }
  return out;
}
