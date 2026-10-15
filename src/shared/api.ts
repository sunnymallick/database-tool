/**
 * IPC contract between renderer and main.
 *
 * Every request goes through one channel: the renderer calls
 * `invoke(method, req)` and gets back an `ApiResult`. Main pushes events to
 * the renderer with `emit(event, payload)`.
 *
 * CONTRACT FILE: changes must be additive and backward compatible.
 */
import type {
  AppInfo,
  AppSettings,
  ApplyChangesRequest,
  ApplyChangesResult,
  ConnRef,
  ConnectionProfile,
  ConnectionStatus,
  DbMeta,
  FetchRowsRequest,
  HistoryEntry,
  HistoryQuery,
  ImportDbtoolRequest,
  ImportResult,
  BinaryFile,
  MenuAction,
  OpenDirectoryRequest,
  OpenFileRequest,
  QueryRequest,
  QueryResponse,
  RoutineInfo,
  RoutineKind,
  SaveConnectionRequest,
  SaveFileRequest,
  SchemaList,
  Snippet,
  TableInfo,
  TablePage,
  TableRef,
  TableStructure,
  TestConnectionRequest,
  TestConnectionResult,
  TextFile,
  WriteToDirectoryRequest
} from './types';
import type { AiApproveRequest, AiEvent, AiSendRequest, AiSendResponse, AiStatus } from './ai';

type M<Req, Res> = { req: Req; res: Res };

export interface ApiMethods {
  // -- app / files (main/ipc/files.ts) -------------------------------------
  'app.info': M<void, AppInfo>;
  /** Native open dialog. Returns the chosen path or null. */
  'dialog.openFile': M<OpenFileRequest, string | null>;
  /** Native open dialog allowing several files. Returns the chosen paths (empty when cancelled). */
  'dialog.openFiles': M<OpenFileRequest, string[]>;
  /** Native save dialog. Returns the chosen path or null. A bare file name in defaultPath starts in the last folder saved to this session. */
  'dialog.saveFile': M<SaveFileRequest, string | null>;
  /** Native folder picker. The folder may then be written to with files.writeToDirectory for the rest of the session. */
  'dialog.openDirectory': M<OpenDirectoryRequest, string | null>;
  /** Read a UTF-8 text file. Only paths returned by a dialog this session (or previously opened) are allowed. */
  'files.read': M<{ path: string }, TextFile>;
  /** Write a UTF-8 text file. Same path allowlist as files.read. */
  'files.write': M<TextFile, void>;
  /** Write a binary file (e.g. .xlsx). Same path allowlist as files.read. */
  'files.writeBytes': M<BinaryFile, void>;
  /** Write several new files into a folder chosen with dialog.openDirectory. Returns the paths written. */
  'files.writeToDirectory': M<WriteToDirectoryRequest, { paths: string[] }>;
  'shell.showItemInFolder': M<{ path: string }, void>;
  'shell.openExternal': M<{ url: string }, void>;

  // -- connections (main/ipc/data.ts) ----------------------------------------
  'connections.list': M<void, ConnectionProfile[]>;
  'connections.save': M<SaveConnectionRequest, ConnectionProfile>;
  'connections.delete': M<{ profileId: string }, void>;
  'connections.test': M<TestConnectionRequest, TestConnectionResult>;
  'connections.connect': M<ConnRef, ConnectionStatus>;
  'connections.disconnect': M<ConnRef, ConnectionStatus>;
  'connections.statuses': M<void, ConnectionStatus[]>;
  /** Import profiles from the dbTool app (~/Library/Application Support/dbTool/connections.json). */
  'connections.importDbtool': M<ImportDbtoolRequest, ImportResult>;

  // -- database browsing and queries (main/ipc/data.ts) -----------------------
  'db.databases': M<{ conn: ConnRef }, string[]>;
  'db.schemas': M<{ conn: ConnRef }, SchemaList>;
  'db.tables': M<{ conn: ConnRef; schema: string }, TableInfo[]>;
  'db.routines': M<{ conn: ConnRef; schema: string }, RoutineInfo[]>;
  'db.structure': M<TableRef, TableStructure>;
  'db.ddl': M<TableRef, string>;
  'db.routineDefinition': M<{ conn: ConnRef; schema: string; name: string; kind: RoutineKind }, string>;
  /** Runs a script. Engine errors come back in `QueryResponse.error`, not as a rejected call. */
  'db.query': M<QueryRequest, QueryResponse>;
  'db.cancel': M<{ queryId: string }, void>;
  'db.rows': M<FetchRowsRequest, TablePage>;
  'db.applyChanges': M<ApplyChangesRequest, ApplyChangesResult>;
  'db.meta': M<{ conn: ConnRef }, DbMeta>;

  // -- workspace (main/ipc/data.ts) ------------------------------------------
  'history.list': M<HistoryQuery, HistoryEntry[]>;
  'history.clear': M<void, void>;
  'snippets.list': M<void, Snippet[]>;
  'snippets.save': M<Snippet, Snippet>;
  'snippets.delete': M<{ id: string }, void>;
  'settings.get': M<void, AppSettings>;
  'settings.update': M<Partial<AppSettings>, AppSettings>;
  /** Renderer-owned workspace state (open tabs, layout). Opaque to main. */
  'session.load': M<void, unknown>;
  'session.save': M<unknown, void>;

  // -- AI (main/ipc/ai.ts) -----------------------------------------------------
  'ai.status': M<{ refresh?: boolean }, AiStatus>;
  'ai.send': M<AiSendRequest, AiSendResponse>;
  'ai.approve': M<AiApproveRequest, void>;
  'ai.cancel': M<{ sessionId: string }, void>;
  'ai.reset': M<{ sessionId: string }, void>;
}

export interface ApiEvents {
  'connections.status': ConnectionStatus;
  'connections.changed': ConnectionProfile[];
  'settings.changed': AppSettings;
  'ai.event': AiEvent;
  menu: MenuAction;
}

export type ApiMethod = keyof ApiMethods;
export type ApiReq<K extends ApiMethod> = ApiMethods[K]['req'];
export type ApiRes<K extends ApiMethod> = ApiMethods[K]['res'];
export type ApiEventName = keyof ApiEvents;

export interface ApiErrorInfo {
  message: string;
  code?: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorInfo };

/** IPC channel names. */
export const INVOKE_CHANNEL = 'api:invoke';
export const EVENT_CHANNEL = 'api:event';

/** What the preload script exposes as `window.bridge`. */
export interface PreloadBridge {
  invoke(method: string, req: unknown): Promise<ApiResult<unknown>>;
  on(listener: (event: string, payload: unknown) => void): () => void;
  platform: string;
}
