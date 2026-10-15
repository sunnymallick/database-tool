<!--
  New / edit connection profile. Reads its open state from `dialogs.connection`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import PlugZap from '@lucide/svelte/icons/plug-zap';
  import {
    DB_KINDS,
    dbKindInfo,
    type ConnectionProfile,
    type DbKind,
    type TestConnectionResult
  } from '@shared/types';
  import { call, errorMessage } from '$lib/api.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { blankProfile, connections } from '$lib/stores/connections.svelte';
  import { dialogs } from '$lib/stores/dialogs.svelte';
  import { layout } from '$lib/stores/layout.svelte';
  import { basename, cn } from '$lib/utils';
  import ColorSwatches from './ColorSwatches.svelte';
  import ExtraDatabases from './ExtraDatabases.svelte';

  const SQLITE_FILTERS = [
    { name: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db'] },
    { name: 'All Files', extensions: ['*'] }
  ];

  const uid = $props.id();
  const fid = (name: string) => `conn-${uid}-${name}`;

  let profile = $state<ConnectionProfile>(blankProfile('postgres'));
  let isNew = $state(true);
  let portText = $state('');
  let instanceName = $state('');
  let timeoutText = $state('');
  let password = $state('');
  let clearPassword = $state(false);
  let showPassword = $state(false);
  let testing = $state(false);
  let testResult = $state<TestConnectionResult | null>(null);
  let saving = $state(false);
  /** Show validation messages only after a save attempt. */
  let attempted = $state(false);

  let nameInput = $state<HTMLInputElement | null>(null);
  let hostInput = $state<HTMLInputElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const info = $derived(dbKindInfo(profile.kind));
  const fileBased = $derived(info.fileBased);
  const hasStoredPassword = $derived(!isNew && profile.hasPassword);

  const namePlaceholder = $derived.by(() => {
    if (fileBased) {
      const f = profile.filePath.trim();
      return f ? basename(f).replace(/\.(sqlite3?|db)$/i, '') : 'My database';
    }
    const host = profile.host.trim();
    const db = profile.database.trim();
    if (db && host) return `${db} @ ${host}`;
    return host || db || 'My database';
  });

  const effectiveName = $derived(
    profile.name.trim() ||
      (namePlaceholder !== 'My database' ? namePlaceholder : '')
  );

  const port = $derived(Number.parseInt(portText, 10));

  const errors = $derived.by(() => {
    const e: Partial<Record<'name' | 'host' | 'port' | 'file' | 'timeout', string>> = {};
    if (!effectiveName) e.name = 'Name is required.';
    if (fileBased) {
      if (!profile.filePath.trim()) e.file = 'Choose a database file.';
    } else {
      if (!profile.host.trim()) e.host = 'Host is required.';
      if (!/^\d+$/.test(portText.trim()) || port < 1 || port > 65535) e.port = 'Port must be 1–65535.';
    }
    if (timeoutText.trim() && (!/^\d+$/.test(timeoutText.trim()) || Number(timeoutText) < 1 || Number(timeoutText) > 600))
      e.timeout = 'Timeout must be 1–600 seconds.';
    return e;
  });
  const valid = $derived(Object.keys(errors).length === 0);

  // Initialize the working copy each time the dialog opens.
  let wasOpen = false;
  $effect(() => {
    const open = dialogs.connection.open;
    const source = dialogs.connection.profile;
    if (open && !wasOpen) untrack(() => init(source));
    wasOpen = open;
  });

  function init(source: ConnectionProfile | null): void {
    const p: ConnectionProfile = source
      ? (structuredClone($state.snapshot(source)) as ConnectionProfile)
      : blankProfile('postgres');
    p.options = { ...(p.options ?? {}) };
    p.extraDatabases = [...(p.extraDatabases ?? [])];
    profile = p;
    isNew = !source || !source.id;
    portText = p.port ? String(p.port) : '';
    instanceName = p.options.instanceName ?? '';
    timeoutText = p.options.connectTimeoutSec ?? '';
    password = '';
    clearPassword = false;
    showPassword = false;
    testing = false;
    testResult = null;
    saving = false;
    attempted = false;
  }

  // Any edit invalidates the last test result.
  $effect(() => {
    void JSON.stringify(profile);
    void portText;
    void instanceName;
    void timeoutText;
    void password;
    void clearPassword;
    untrack(() => {
      if (!testing) testResult = null;
    });
  });

  function setKind(kind: DbKind): void {
    if (kind === profile.kind) return;
    const prevDefault = dbKindInfo(profile.kind).defaultPort;
    const next = dbKindInfo(kind);
    if (!portText.trim() || Number(portText) === prevDefault) portText = next.defaultPort ? String(next.defaultPort) : '';
    if (!next.fileBased && !profile.host.trim()) profile.host = 'localhost';
    profile.kind = kind;
  }

  /** The profile as it will be saved / tested. */
  function buildProfile(): ConnectionProfile {
    const p = structuredClone($state.snapshot(profile)) as ConnectionProfile;
    p.name = effectiveName;
    p.group = p.group?.trim() || null;
    p.host = p.host.trim();
    p.database = p.database.trim();
    p.username = p.username.trim();
    p.filePath = p.filePath.trim();
    const options = { ...p.options };
    if (p.kind === 'mssql' && instanceName.trim()) options.instanceName = instanceName.trim();
    else delete options.instanceName;
    if (timeoutText.trim()) options.connectTimeoutSec = String(Number(timeoutText));
    else delete options.connectTimeoutSec;
    p.options = options;
    if (dbKindInfo(p.kind).fileBased) {
      p.port = 0;
      p.host = '';
      p.username = '';
      p.extraDatabases = [];
    } else {
      p.port = port;
      p.extraDatabases = p.extraDatabases.filter((d) => d && d !== p.database);
    }
    return p;
  }

  /** undefined keeps the stored password, null removes it, a string replaces it. */
  function passwordArg(): string | null | undefined {
    if (fileBased) return undefined;
    if (clearPassword) return null;
    return password !== '' ? password : undefined;
  }

  async function test(): Promise<void> {
    if (testing) return;
    attempted = true;
    if (!valid) return;
    testing = true;
    testResult = null;
    try {
      testResult = await call('connections.test', { profile: buildProfile(), password: passwordArg() });
    } catch (err) {
      testResult = { ok: false, message: errorMessage(err) };
    } finally {
      testing = false;
    }
  }

  async function save(): Promise<void> {
    if (saving) return;
    attempted = true;
    if (!valid) {
      toast.error('Check the highlighted fields');
      return;
    }
    saving = true;
    try {
      const saved = await connections.save(buildProfile(), passwordArg());
      toast.success(isNew ? `Added “${saved.name}”` : `Saved “${saved.name}”`);
      dialogs.connection.open = false;
      if (isNew) {
        layout.setExpanded(`p:${saved.id}`, true);
        void connections.connect({ profileId: saved.id });
      }
    } catch (err) {
      toast.error('Could not save connection', { description: errorMessage(err) });
    } finally {
      saving = false;
    }
  }

  function onFormKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
    const t = e.target as HTMLElement;
    if (t.tagName !== 'INPUT') return;
    const type = (t as HTMLInputElement).type;
    if (type === 'checkbox' || type === 'radio' || type === 'button') return;
    e.preventDefault();
    void save();
  }

  async function chooseFile(): Promise<void> {
    try {
      const path = await call('dialog.openFile', { title: 'Open SQLite database', filters: SQLITE_FILTERS });
      if (path) profile.filePath = path;
    } catch (err) {
      toast.error('Could not open file dialog', { description: errorMessage(err) });
    }
  }

  async function createFile(): Promise<void> {
    try {
      const path = await call('dialog.saveFile', {
        title: 'Create SQLite database',
        defaultPath: 'database.sqlite',
        filters: SQLITE_FILTERS
      });
      if (path) profile.filePath = path;
    } catch (err) {
      toast.error('Could not open file dialog', { description: errorMessage(err) });
    }
  }

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault();
    requestAnimationFrame(() => {
      const target = !isNew ? nameInput : fileBased ? fileInput : hostInput;
      (target ?? nameInput)?.focus();
    });
  }

  const sslLabel = $derived(profile.kind === 'mssql' ? 'Encrypt connection' : 'Require TLS');
  const sslHint = $derived(
    profile.kind === 'mssql' ? 'Sets encrypt=true on the TDS connection.' : 'Refuse to connect without SSL/TLS.'
  );
</script>

{#snippet fieldError(message: string | undefined)}
  {#if attempted && message}
    <p class="text-[11.5px] text-danger">{message}</p>
  {/if}
{/snippet}

<Dialog
  bind:open={dialogs.connection.open}
  title={isNew ? 'New connection' : 'Edit connection'}
  description={isNew ? 'Connection details are stored locally; passwords go to the macOS Keychain.' : undefined}
  width="max-w-[620px]"
  modalLock
  {onOpenAutoFocus}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form
    class="flex flex-col gap-5 pt-1"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    onkeydown={onFormKeydown}
    novalidate
  >
    <!-- Engine -->
    <div class="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Database engine">
      {#each DB_KINDS as k (k.kind)}
        {@const selected = profile.kind === k.kind}
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          class={cn(
            'flex h-[52px] flex-col items-start justify-center gap-0.5 rounded-lg border px-3 text-left transition-colors',
            selected
              ? 'border-accent bg-accent-soft text-fg'
              : 'border-border bg-raised text-muted hover:border-border-strong hover:text-fg'
          )}
          onclick={() => setKind(k.kind)}
        >
          <span class="text-[12.5px] font-semibold">{k.label}</span>
          <span class="text-[11px] text-faint">{k.fileBased ? 'Local file' : `Port ${k.defaultPort}`}</span>
        </button>
      {/each}
    </div>

    <!-- General -->
    <section class="flex flex-col gap-2.5">
      <h3 class="panel-title">General</h3>
      <div class="grid grid-cols-[112px_1fr] items-center gap-x-3 gap-y-2.5">
        <label class="label" for={fid('name')}>Name</label>
        <div class="field">
          <input
            id={fid('name')}
            bind:this={nameInput}
            class={cn('input', attempted && errors.name && 'border-danger')}
            placeholder={namePlaceholder}
            bind:value={profile.name}
            autocomplete="off"
            spellcheck="false"
          />
          {@render fieldError(errors.name)}
        </div>

        <label class="label" for={fid('group')}>Group</label>
        <input
          id={fid('group')}
          class="input"
          placeholder="None"
          list={fid('groups')}
          value={profile.group ?? ''}
          oninput={(e) => (profile.group = e.currentTarget.value || null)}
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id={fid('groups')}>
          {#each connections.knownGroups as g (g)}<option value={g}></option>{/each}
        </datalist>

        <span class="label" id={fid('color-label')}>Color</span>
        <div aria-labelledby={fid('color-label')}>
          <ColorSwatches bind:value={profile.color} />
        </div>
      </div>
    </section>

    {#if fileBased}
      <!-- SQLite file -->
      <section class="flex flex-col gap-2.5">
        <h3 class="panel-title">Database file</h3>
        <div class="grid grid-cols-[112px_1fr] items-start gap-x-3 gap-y-2.5">
          <label class="label mt-1.5" for={fid('file')}>File</label>
          <div class="field">
            <div class="flex gap-1.5">
              <input
                id={fid('file')}
                bind:this={fileInput}
                class={cn('input font-mono text-[12px]', attempted && errors.file && 'border-danger')}
                placeholder="/path/to/database.sqlite"
                bind:value={profile.filePath}
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="btn" onclick={chooseFile}>
                <FolderOpen class="size-3.5" />Choose…
              </button>
              <button type="button" class="btn" onclick={createFile}>
                <FilePlus class="size-3.5" />Create new…
              </button>
            </div>
            {@render fieldError(errors.file)}
          </div>
        </div>
      </section>
    {:else}
      <!-- Server -->
      <section class="flex flex-col gap-2.5">
        <h3 class="panel-title">Server</h3>
        <div class="grid grid-cols-[112px_1fr] items-center gap-x-3 gap-y-2.5">
          <label class="label" for={fid('host')}>Host</label>
          <div class="field">
            <div class="flex items-center gap-1.5">
              <input
                id={fid('host')}
                bind:this={hostInput}
                class={cn('input min-w-0 flex-1', attempted && errors.host && 'border-danger')}
                placeholder="localhost"
                bind:value={profile.host}
                autocomplete="off"
                spellcheck="false"
              />
              <label class="label shrink-0 pl-1" for={fid('port')}>Port</label>
              <input
                id={fid('port')}
                class={cn('input w-[76px] shrink-0 tabular-nums', attempted && errors.port && 'border-danger')}
                inputmode="numeric"
                placeholder={String(info.defaultPort)}
                bind:value={portText}
                autocomplete="off"
              />
            </div>
            {@render fieldError(errors.host ?? errors.port)}
          </div>

          {#if profile.kind === 'mssql'}
            <label class="label" for={fid('instance')}>Instance</label>
            <input
              id={fid('instance')}
              class="input"
              placeholder="Default instance"
              bind:value={instanceName}
              autocomplete="off"
              spellcheck="false"
            />
          {/if}

          <label class="label" for={fid('database')}>Database</label>
          <input
            id={fid('database')}
            class="input"
            placeholder={profile.kind === 'mssql' ? 'master' : profile.kind === 'postgres' ? 'postgres' : 'Optional'}
            bind:value={profile.database}
            autocomplete="off"
            spellcheck="false"
          />

          <label class="label" for={fid('user')}>Username</label>
          <input
            id={fid('user')}
            class="input"
            placeholder={profile.kind === 'mssql' ? 'sa' : profile.kind === 'mysql' ? 'root' : 'postgres'}
            bind:value={profile.username}
            autocomplete="off"
            spellcheck="false"
          />

          <label class="label self-start pt-1.5" for={fid('password')}>Password</label>
          <div class="field">
            <div class="flex items-center gap-1.5">
              <div class="relative min-w-0 flex-1">
                <input
                  id={fid('password')}
                  class="input pr-8"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={clearPassword
                    ? 'No password'
                    : hasStoredPassword
                      ? '•••••••• (stored)'
                      : 'None'}
                  bind:value={password}
                  oninput={() => (clearPassword = false)}
                  autocomplete="new-password"
                  spellcheck="false"
                />
                <button
                  type="button"
                  class="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onclick={() => (showPassword = !showPassword)}
                >
                  {#if showPassword}<EyeOff class="size-3.5" />{:else}<Eye class="size-3.5" />{/if}
                </button>
              </div>
              {#if hasStoredPassword && !clearPassword}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onclick={() => {
                    clearPassword = true;
                    password = '';
                  }}
                >
                  Clear
                </button>
              {/if}
            </div>
            {#if clearPassword}
              <p class="flex items-center gap-1.5 text-[11.5px] text-warning">
                The stored password will be removed on save.
                <button type="button" class="link text-[11.5px]" onclick={() => (clearPassword = false)}>Undo</button>
              </p>
            {:else if hasStoredPassword}
              <p class="hint">Leave blank to keep the stored password.</p>
            {/if}
          </div>
        </div>
      </section>

      <!-- Security -->
      <section class="flex flex-col gap-2.5">
        <h3 class="panel-title">Security</h3>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Switch bind:checked={profile.ssl} label={sslLabel} hint={sslHint} />
          <Switch
            bind:checked={profile.trustServerCertificate}
            label="Trust server certificate"
            hint="Accept self-signed certificates."
          />
        </div>
      </section>

      <!-- Extra databases -->
      <section class="flex flex-col gap-2.5">
        <div class="flex items-baseline gap-2">
          <h3 class="panel-title">Additional databases</h3>
          <span class="hint">Shown as their own nodes in the sidebar.</span>
        </div>
        <ExtraDatabases
          id={fid('extra')}
          bind:databases={profile.extraDatabases}
          defaultDb={profile.database.trim()}
          profileId={isNew ? null : profile.id}
        />
      </section>
    {/if}

    <!-- Safety -->
    <section class="flex flex-col gap-2.5">
      <h3 class="panel-title">Safety</h3>
      <div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Switch
          bind:checked={profile.production}
          tone="danger"
          label="Production"
          hint="Red accents everywhere and a confirmation before write statements."
        />
        <Switch bind:checked={profile.readOnly} label="Read-only" hint="Blocks every statement that can write." />
      </div>
    </section>

    <!-- Advanced -->
    <section class="flex flex-col gap-2.5">
      <h3 class="panel-title">Advanced</h3>
      <div class="grid grid-cols-[112px_1fr] items-center gap-x-3 gap-y-2.5">
        <label class="label" for={fid('timeout')}>Connect timeout</label>
        <div class="field">
          <div class="flex items-center gap-2">
            <input
              id={fid('timeout')}
              class={cn('input w-[76px] tabular-nums', attempted && errors.timeout && 'border-danger')}
              inputmode="numeric"
              placeholder="15"
              bind:value={timeoutText}
              autocomplete="off"
            />
            <span class="hint">seconds (blank = driver default)</span>
          </div>
          {@render fieldError(errors.timeout)}
        </div>
      </div>
    </section>
  </form>

  {#snippet footer()}
    <div class="flex min-w-0 flex-1 items-center gap-2.5">
      <button type="button" class="btn" onclick={test} disabled={testing}>
        {#if testing}<span class="spinner size-3"></span>{:else}<PlugZap class="size-3.5" />{/if}
        Test
      </button>
      {#if testing}
        <span class="text-[12px] text-muted">Connecting…</span>
      {:else if testResult}
        <span
          class={cn(
            'flex min-w-0 items-center gap-1.5 text-[12px]',
            testResult.ok ? 'text-success' : 'text-danger'
          )}
          title={testResult.message}
          role="status"
        >
          {#if testResult.ok}
            <CircleCheck class="size-3.5 shrink-0" />
          {:else}
            <CircleX class="size-3.5 shrink-0" />
          {/if}
          <span class="line-clamp-2 min-w-0 leading-snug break-words">
            {testResult.message}{#if testResult.ok && testResult.latencyMs != null}
              <span class="text-faint"> · {Math.round(testResult.latencyMs)} ms</span>
            {/if}
          </span>
        </span>
      {/if}
    </div>
    <button type="button" class="btn btn-ghost" onclick={() => (dialogs.connection.open = false)}>Cancel</button>
    <button type="button" class="btn btn-primary" onclick={save} disabled={saving || (attempted && !valid)}>
      {#if saving}<span class="spinner size-3"></span>{/if}
      {isNew ? 'Add connection' : 'Save'}
    </button>
  {/snippet}
</Dialog>
