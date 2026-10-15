/**
 * Workbench-side entry point for "Ask AI" actions: opens the dock, then hands
 * the prompt to the AI panel through the bridge.
 */
import { ai, type AskAiOptions } from '$lib/bridge';
import { layout } from '$lib/stores/layout.svelte';

export function askAi(prompt: string, opts?: AskAiOptions): void {
  layout.aiOpen = true;
  ai.ask(prompt, opts);
}
