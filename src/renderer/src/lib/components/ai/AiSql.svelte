<!-- SQL with syntax colors (text nodes only). -->
<script lang="ts">
  import { tokenizeSql, type SqlTokenKind } from './sql-tokens';

  let { sql, class: klass = '' }: { sql: string; class?: string } = $props();

  const tokens = $derived(tokenizeSql(sql));

  const COLORS: Record<SqlTokenKind, string> = {
    kw: 'text-[var(--syn-keyword)]',
    fn: 'text-[var(--syn-function)]',
    str: 'text-[var(--syn-string)]',
    num: 'text-[var(--syn-number)]',
    com: 'text-[var(--syn-comment)] italic',
    quoted: 'text-[var(--syn-quoted)]',
    op: 'text-[var(--syn-operator)]',
    text: ''
  };
</script>

<pre class="m-0 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words select-text {klass}"><code
    >{#each tokens as tok, i (i)}{#if tok.k === 'text'}{tok.v}{:else}<span class={COLORS[tok.k]}>{tok.v}</span>{/if}{/each}</code
  ></pre>
