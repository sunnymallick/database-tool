/**
 * Briefly highlight a range (the statement that is about to run).
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const mark = Decoration.mark({ class: 'cm-statement-flash' });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) deco = e.value && e.value.to > e.value.from ? Decoration.set([mark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f)
});

export const flashExtension: Extension = flashField;

export function flashRange(view: EditorView, from: number, to: number, ms = 450): void {
  const len = view.state.doc.length;
  view.dispatch({ effects: setFlash.of({ from: Math.min(from, len), to: Math.min(to, len) }) });
  setTimeout(() => {
    // The view may have been destroyed in the meantime.
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
  }, ms);
}
