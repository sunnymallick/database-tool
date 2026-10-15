/**
 * Fake connection registry and driver for the AI tests. Results are scripted
 * per SQL text; every executed statement is recorded.
 */
import {
  DEFAULT_SETTINGS,
  type ConnRef,
  type ConnectionProfile,
  type ConnectionStatus,
  type DbMeta,
  type ResultSet,
  type TableStructure,
  type Value
} from '@shared/types';
import { QueryFailure, type Driver, type ExecuteOptions } from '../../src/main/db/driver';
import type { ConnectionRegistry, DataServices } from '../../src/main/services';

export function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'Shop',
    kind: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'shop',
    username: 'me',
    filePath: '',
    ssl: false,
    trustServerCertificate: false,
    options: {},
    extraDatabases: [],
    color: null,
    group: null,
    production: false,
    readOnly: false,
    hasPassword: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

export const int = (n: number): Value => ({ t: 'int', v: String(n) });
export const text = (s: string): Value => ({ t: 'text', v: s });

export function resultSet(columns: string[], rows: Value[][], extra: Partial<ResultSet> = {}): ResultSet {
  return {
    columns: columns.map((name) => ({ name, type: 'text' })),
    rows,
    truncated: false,
    statement: '',
    statementIndex: 0,
    durationMs: 1,
    ...extra
  };
}

export class FakeDriver implements Driver {
  readonly kind;
  readonly database = 'shop';
  executed: { sql: string; opts: ExecuteOptions }[] = [];
  /** Responses by exact SQL; a function gets the row cap. */
  responses = new Map<string, ResultSet[] | ((opts: ExecuteOptions) => ResultSet[]) | Error>();
  meta: DbMeta = {
    defaultSchema: 'public',
    schemas: ['public'],
    tables: [
      {
        schema: 'public',
        name: 'orders',
        kind: 'table',
        columns: [
          { name: 'id', type: 'int4' },
          { name: 'status', type: 'text' }
        ]
      }
    ]
  };

  constructor(kind: Driver['kind'] = 'postgres') {
    this.kind = kind;
  }

  async serverVersion() {
    return '17.0';
  }
  async ping() {}
  async close() {}
  async listDatabases() {
    return ['shop'];
  }
  async listSchemas() {
    return { schemas: ['public', 'audit'], defaultSchema: 'public' };
  }
  async listTables(schema: string) {
    return [
      { schema, name: 'orders', kind: 'table' as const, rowEstimate: 1500 },
      { schema, name: 'order_totals', kind: 'view' as const }
    ];
  }
  async listRoutines() {
    return [];
  }
  async describeTable(schema: string, table: string): Promise<TableStructure> {
    if (table !== 'orders') throw new Error(`relation "${table}" does not exist`);
    return {
      schema,
      name: table,
      kind: 'table',
      columns: [
        { name: 'id', type: 'int4', nullable: false, defaultValue: null, isPrimaryKey: true, isIdentity: true, ordinal: 1 },
        { name: 'status', type: 'text', nullable: false, defaultValue: "'pending'", isPrimaryKey: false, isIdentity: false, ordinal: 2 }
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
      foreignKeys: [],
      referencedBy: [],
      checks: []
    };
  }
  async tableDdl(): Promise<string> {
    return '';
  }
  async routineDefinition(): Promise<string> {
    return '';
  }
  async execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    this.executed.push({ sql, opts });
    const r = this.responses.get(sql);
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(opts);
    if (r) return r;
    return [resultSet([], [], { rowsAffected: 1 })];
  }
  async fetchRows(): Promise<never> {
    throw new Error('not used');
  }
  async applyChanges(): Promise<never> {
    throw new Error('not used');
  }
  async fetchMeta(): Promise<DbMeta> {
    return this.meta;
  }
}

export function fakeRegistry(profiles: ConnectionProfile[], driver = new FakeDriver()): ConnectionRegistry & {
  driver: FakeDriver;
  acquired: ConnRef[];
} {
  const acquired: ConnRef[] = [];
  return {
    driver,
    acquired,
    listProfiles: () => profiles,
    getProfile: (id) => profiles.find((p) => p.id === id),
    status: (ref): ConnectionStatus => ({ profileId: ref.profileId, database: 'shop', state: 'connected', serverVersion: '17.0' }),
    acquire: async (ref) => {
      acquired.push(ref);
      return driver;
    }
  };
}

export function fakeServices(registry: ConnectionRegistry): DataServices & { history: unknown[] } {
  const history: unknown[] = [];
  return {
    registry,
    history,
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    recordHistory: (e) => history.push(e),
    shutdown: async () => {}
  };
}

export function queryFailure(message: string, code?: string): QueryFailure {
  return new QueryFailure({ message, code });
}
