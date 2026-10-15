/**
 * CodeMirror theme built from the app's CSS variables, so it follows the
 * light/dark theme without reconfiguration.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.standard(t.name), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-operator)' },
  { tag: [t.special(t.name), t.quote], color: 'var(--syn-quoted)' },
  { tag: [t.variableName, t.name, t.propertyName], color: 'var(--syn-identifier)' },
  { tag: t.special(t.variableName), color: 'var(--syn-quoted)', fontWeight: '500' },
  { tag: t.invalid, color: 'var(--danger)' }
]);

export function editorTheme(fontSize: number): Extension {
  return [
    EditorView.theme({
      '&': {
        height: '100%',
        fontSize: `${fontSize}px`,
        color: 'var(--fg)',
        backgroundColor: 'var(--editor-bg)'
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6'
      },
      '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
      '.cm-line': { padding: '0 12px 0 8px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
        { backgroundColor: 'var(--selection) !important' },
      '.cm-activeLine': { backgroundColor: 'var(--hover)' },
      '.cm-gutters': {
        backgroundColor: 'var(--editor-bg)',
        color: 'var(--faint)',
        border: 'none',
        borderRight: '1px solid var(--border)'
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px', minWidth: '36px' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', border: '1px solid var(--border)', color: 'var(--muted)' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--accent-soft)',
        outline: '1px solid color-mix(in srgb, var(--accent) 50%, transparent)'
      },
      '.cm-nonmatchingBracket': { color: 'var(--danger)' },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 18%, transparent)' },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--warning) 28%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--warning) 60%, transparent)'
      },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warning) 50%, transparent)' },
      '.cm-placeholder': { color: 'var(--faint)', fontStyle: 'normal' },
      // Search / replace panel
      '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
      '.cm-panel.cm-search': {
        padding: '6px 32px 6px 10px',
        fontFamily: 'var(--font-sans)',
        fontSize: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '4px 6px'
      },
      '.cm-panel.cm-search br': { flexBasis: '100%', height: 0 },
      '.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--accent)', margin: '0 3px 0 0' },
      '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', color: 'var(--muted)', fontSize: '12px' },
      '.cm-panel.cm-search [name=close]': {
        color: 'var(--muted)',
        fontSize: '16px',
        top: '6px',
        right: '8px',
        cursor: 'pointer'
      },
      '.cm-textfield': {
        backgroundColor: 'var(--sunken)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        color: 'var(--fg)',
        height: '24px',
        padding: '0 8px',
        fontSize: '12px',
        fontFamily: 'var(--font-mono)',
        margin: '0'
      },
      '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--focus)' },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--raised)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        color: 'var(--fg)',
        height: '24px',
        padding: '0 8px',
        fontSize: '12px',
        margin: '0',
        textTransform: 'capitalize'
      },
      '.cm-button:hover': { backgroundColor: 'var(--hover)' },
      // Autocomplete
      '.cm-tooltip': {
        backgroundColor: 'var(--overlay)',
        border: '1px solid var(--border-strong)',
        borderRadius: '8px',
        boxShadow: 'var(--shadow)',
        color: 'var(--fg)',
        overflow: 'hidden'
      },
      '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '280px' },
      '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px 3px 6px', lineHeight: '18px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail': { color: 'var(--accent-fg)', opacity: '0.8' },
      '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: '12px', fontSize: '11px' },
      '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
      '.cm-completionIcon': {
        opacity: '1',
        width: '14px',
        height: '14px',
        marginRight: '8px',
        padding: '0',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '3px',
        fontFamily: 'var(--font-sans)',
        fontSize: '9px',
        fontWeight: '700',
        verticalAlign: 'middle',
        color: 'var(--muted)',
        backgroundColor: 'var(--active)'
      },
      '.cm-completionIcon-keyword:after': { content: '"K"', color: 'var(--syn-keyword)' },
      '.cm-completionIcon-class:after': { content: '"T"', color: 'var(--accent)' },
      '.cm-completionIcon-interface:after': { content: '"V"', color: 'var(--syn-type)' },
      '.cm-completionIcon-namespace:after': { content: '"S"', color: 'var(--syn-quoted)' },
      '.cm-completionIcon-property:after': { content: '"C"', color: 'var(--syn-function)' },
      '.cm-completionIcon-type:after': { content: '"t"', color: 'var(--syn-type)' },
      '.cm-completionIcon-function:after, .cm-completionIcon-method:after': { content: '"ƒ"', color: 'var(--syn-function)' },
      '.cm-completionIcon-variable:after': { content: '"x"' },
      '.cm-completionIcon-constant:after': { content: '"c"', color: 'var(--syn-number)' },
      '.cm-completionIcon-text:after': { content: '"a"' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon': { backgroundColor: 'rgb(255 255 255 / 0.2)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon:after': { color: 'var(--accent-fg)' },
      '.cm-tooltip.cm-tooltip-lint': { padding: '0' },
      '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
      '.cm-diagnostic-error': { borderLeft: '3px solid var(--danger)' },
      '.cm-lintRange-error': {
        backgroundImage: 'none',
        textDecoration: 'underline wavy var(--danger)',
        textUnderlineOffset: '3px',
        backgroundColor: 'var(--danger-soft)'
      },
      '.cm-statement-flash': { backgroundColor: 'var(--accent-soft)', transition: 'background-color 0.4s' }
    }),
    syntaxHighlighting(highlight)
  ];
}
