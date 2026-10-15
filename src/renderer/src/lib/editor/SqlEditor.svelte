<!--
  CodeMirror 6 SQL editor. Dialect, completion schema, font size, line
  numbers, and wrapping are reconfigured live through compartments.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { sql } from '@codemirror/lang-sql';
  import { bracketMatching, indentOnInput } from '@codemirror/language';
  import { lintKeymap } from '@codemirror/lint';
  import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
  import { Compartment, EditorState, type Extension } from '@codemirror/state';
  import {
    crosshairCursor,
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    placeholder as placeholderExt,
    rectangularSelection
  } from '@codemirror/view';
  import type { DbKind, DbMeta } from '@shared/types';
  import { settings } from '$lib/stores/settings.svelte';
  import { cn } from '$lib/utils';
  import { completionConfig } from './completion';
  import { cmDialect } from './dialect';
  import { flashExtension } from './flash';
  import { editorTheme } from './theme';

  interface Props {
    doc: string;
    kind?: DbKind | null;
    meta?: DbMeta | null;
    readOnly?: boolean;
    placeholder?: string;
    /** Override settings.editorLineNumbers. */
    lineNumbers?: boolean;
    /** Override settings.editorWordWrap. */
    wrap?: boolean;
    /** Override settings.editorFontSize. */
    fontSize?: number;
    class?: string;
    onChange?: (doc: string) => void;
    onRun?: (mode: 'auto' | 'script') => void;
    onFormat?: () => void;
    onReady?: (view: EditorView) => void;
  }

  let {
    doc,
    kind = null,
    meta = null,
    readOnly = false,
    placeholder = '',
    lineNumbers: lineNumbersProp,
    wrap: wrapProp,
    fontSize: fontSizeProp,
    class: klass,
    onChange,
    onRun,
    onFormat,
    onReady
  }: Props = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;

  const language = new Compartment();
  const themeC = new Compartment();
  const gutterC = new Compartment();
  const wrapC = new Compartment();
  const readOnlyC = new Compartment();

  const showLineNumbers = $derived(lineNumbersProp ?? settings.value.editorLineNumbers);
  const wrapLines = $derived(wrapProp ?? settings.value.editorWordWrap);
  const fontSize = $derived(fontSizeProp ?? settings.value.editorFontSize);

  function languageExt(): Extension {
    return sql({ dialect: cmDialect(kind), upperCaseKeywords: true, ...completionConfig(meta) });
  }
  function gutterExt(): Extension {
    return showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [];
  }
  function readOnlyExt(): Extension {
    return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  }

  onMount(() => {
    const runKeys = keymap.of([
      { key: 'Mod-Enter', run: () => (onRun?.('auto'), true), preventDefault: true },
      { key: 'Shift-Mod-Enter', run: () => (onRun?.('script'), true), preventDefault: true },
      { key: 'Shift-Mod-f', run: () => (onFormat?.(), true), preventDefault: true }
    ]);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          runKeys,
          gutterC.of(gutterExt()),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          flashExtension,
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...lintKeymap,
            indentWithTab
          ]),
          language.of(languageExt()),
          themeC.of(editorTheme(fontSize)),
          wrapC.of(wrapLines ? EditorView.lineWrapping : []),
          readOnlyC.of(readOnlyExt()),
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange?.(u.state.doc.toString());
          })
        ]
      })
    });
    onReady?.(view);
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  // Live reconfiguration.
  $effect(() => {
    const ext = languageExt();
    view?.dispatch({ effects: language.reconfigure(ext) });
  });
  $effect(() => {
    const ext = editorTheme(fontSize);
    view?.dispatch({ effects: themeC.reconfigure(ext) });
  });
  $effect(() => {
    const ext = gutterExt();
    view?.dispatch({ effects: gutterC.reconfigure(ext) });
  });
  $effect(() => {
    const ext = wrapLines ? EditorView.lineWrapping : [];
    view?.dispatch({ effects: wrapC.reconfigure(ext) });
  });
  $effect(() => {
    const ext = readOnlyExt();
    view?.dispatch({ effects: readOnlyC.reconfigure(ext) });
  });
  // Read-only viewers follow the `doc` prop.
  $effect(() => {
    const next = doc;
    if (!view || !readOnly) return;
    const cur = view.state.doc.toString();
    if (cur !== next) view.dispatch({ changes: { from: 0, to: cur.length, insert: next } });
  });
</script>

<div bind:this={host} class={cn('h-full min-h-0 overflow-hidden', klass)}></div>
