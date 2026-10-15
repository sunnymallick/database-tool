/**
 * Driver factory: opens the right engine for a profile.
 */
import type { ConnectionProfile } from '@shared/types';
import type { ConnectOptions, Driver } from './driver';
import { MssqlDriver } from './mssql';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';

export type { ConnectOptions, Driver } from './driver';

/**
 * Connect to `database` on the profile's server (ignored for SQLite, which
 * opens `profile.filePath`). `password` null means none.
 */
export function connectDriver(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions = {}): Promise<Driver> {
  switch (profile.kind) {
    case 'postgres':
      return PostgresDriver.connect(profile, password, database, opts);
    case 'mysql':
      return MysqlDriver.connect(profile, password, database, opts);
    case 'mssql':
      return MssqlDriver.connect(profile, password, database, opts);
    case 'sqlite':
      return SqliteDriver.connect(profile, password, database, opts);
  }
}
