<!--
  Renders assistant markdown from the parsed block tree. Everything becomes
  text nodes or fixed elements; no model output is ever treated as HTML.
-->
<script lang="ts">
  import AiCodeBlock from './AiCodeBlock.svelte';
  import AiInline from './AiInline.svelte';
  import AiMarkdown from './AiMarkdown.svelte';
  import { parseMarkdown, type Block } from './markdown';

  let { text = '', blocks: given, streaming = false }: { text?: string; blocks?: Block[]; streaming?: boolean } = $props();

  const blocks = $derived(given ?? parseMarkdown(text));

  const HEADING_CLASS: Record<number, string> = {
    1: 'text-[15px] font-semibold mt-3 mb-1.5',
    2: 'text-[14px] font-semibold mt-3 mb-1.5',
    3: 'text-[13px] font-semibold mt-2.5 mb-1'
  };
</script>

{#each blocks as b, i (i)}
  {#if b.t === 'p'}
    <p class="my-1.5 first:mt-0 last:mb-0">
      <AiInline nodes={b.c} />{#if streaming && i === blocks.length - 1}<span class="ai-caret"></span>{/if}
    </p>
  {:else if b.t === 'h'}
    <svelte:element this={`h${b.level}`} class={HEADING_CLASS[b.level] ?? 'mt-2 mb-1 text-[13px] font-semibold'}>
      <AiInline nodes={b.c} />
    </svelte:element>
  {:else if b.t === 'code'}
    <AiCodeBlock code={b.v} lang={b.lang} />
  {:else if b.t === 'list'}
    {#if b.ordered}
      <ol class="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-faint" start={b.start}>
        {#each b.items as item, j (j)}<li class="pl-0.5"><AiMarkdown blocks={item} /></li>{/each}
      </ol>
    {:else}
      <ul class="my-1.5 list-disc space-y-0.5 pl-5 marker:text-faint">
        {#each b.items as item, j (j)}<li class="pl-0.5"><AiMarkdown blocks={item} /></li>{/each}
      </ul>
    {/if}
  {:else if b.t === 'quote'}
    <blockquote class="my-2 border-l-2 border-border-strong pl-3 text-muted"><AiMarkdown blocks={b.c} /></blockquote>
  {:else if b.t === 'table'}
    <div class="my-2 overflow-x-auto rounded-md border border-border">
      <table class="w-full border-collapse text-[12px]">
        <thead class="bg-raised">
          <tr>
            {#each b.head as cell, j (j)}
              <th class="border-b border-border px-2 py-1 text-left font-semibold whitespace-nowrap" style:text-align={b.align[j] ?? undefined}>
                <AiInline nodes={cell} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each b.rows as row, r (r)}
            <tr class="border-b border-border last:border-b-0">
              {#each row as cell, j (j)}
                <td class="px-2 py-1 align-top" style:text-align={b.align[j] ?? undefined}><AiInline nodes={cell} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if b.t === 'hr'}
    <hr class="my-3 border-border" />
  {/if}
{/each}
{#if streaming && (blocks.length === 0 || blocks[blocks.length - 1].t !== 'p')}<span class="ai-caret"></span>{/if}

<style>
  .ai-caret {
    display: inline-block;
    width: 7px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.15em;
    background: var(--accent);
    border-radius: 1px;
    animation: ai-blink 1s steps(2, start) infinite;
  }
  @keyframes ai-blink {
    to {
      visibility: hidden;
    }
  }
</style>
