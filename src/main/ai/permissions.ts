/**
 * The SDK's permission callback and PreToolUse hook for one turn.
 *
 * - The hook runs before every tool call and refuses anything that is not
 *   one of our MCP tools (built-ins are also removed with `tools: []`; this
 *   is the backstop).
 * - Read and UI tools are pre-approved through `allowedTools` and never
 *   reach the callback. run_statement is not pre-approved and is marked
 *   `requiresUserInteraction`, so every call reaches the callback, which
 *   applies the write policy and parks the call until the user answers.
 */
import type { CanUseTool, HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk/core';
import { AI_TOOL_NAMES } from '@shared/ai';
import { writePolicy, type ApprovalBroker, type WriteGrants } from './approvals';
import { MCP_PREFIX, shortToolName } from './mapper';
import type { ConnectionProfile } from '@shared/types';

export interface PermissionDeps {
  profile: ConnectionProfile | null;
  allowWrites: boolean;
  approvals: ApprovalBroker;
  grants: WriteGrants;
  /** Show the tool card (deduplicated by the mapper). */
  emitToolCall: (toolUseId: string, toolName: string, input: unknown) => void;
  markDenied: (toolUseId: string) => void;
}

export const REJECTED_MESSAGE =
  'The user rejected this statement, so it did not run. Do not retry it. Tell the user it was not applied and ask how they want to proceed.';

const OUR_TOOLS = new Set<string>(AI_TOOL_NAMES.map((n) => `${MCP_PREFIX}${n}`));

export function isOurTool(toolName: string): boolean {
  return OUR_TOOLS.has(toolName);
}

/** Pure decision logic behind `canUseTool`, testable without the SDK. */
export async function decidePermission(
  deps: PermissionDeps,
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  signal?: AbortSignal
): Promise<PermissionResult> {
  if (!isOurTool(toolName)) {
    deps.markDenied(toolUseID);
    return { behavior: 'deny', message: `The tool ${toolName} is not available in Database Tool.`, toolUseID };
  }
  if (shortToolName(toolName) !== 'run_statement') {
    return { behavior: 'allow', updatedInput: input, toolUseID };
  }
  deps.emitToolCall(toolUseID, toolName, input);
  const decision = writePolicy(deps.profile, deps.allowWrites);
  if (decision.policy === 'refuse') {
    deps.markDenied(toolUseID);
    return { behavior: 'deny', message: decision.reason, toolUseID };
  }
  const sql = typeof input.sql === 'string' ? input.sql : '';
  if (decision.policy === 'auto') {
    return { behavior: 'allow', updatedInput: input, toolUseID };
  }
  const approved = await deps.approvals.wait(toolUseID, signal);
  if (!approved) {
    deps.markDenied(toolUseID);
    return { behavior: 'deny', message: REJECTED_MESSAGE, toolUseID, decisionClassification: 'user_reject' };
  }
  deps.grants.grant(sql);
  return { behavior: 'allow', updatedInput: input, toolUseID, decisionClassification: 'user_temporary' };
}

export function createCanUseTool(deps: PermissionDeps): CanUseTool {
  return (toolName, input, options) => decidePermission(deps, toolName, input, options.toolUseID, options.signal);
}

/** PreToolUse hook: only our MCP tools may run. Also shows the tool card as early as possible. */
export function createToolAllowlistHook(emitToolCall: PermissionDeps['emitToolCall']): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (isOurTool(input.tool_name)) {
      emitToolCall(input.tool_use_id, input.tool_name, input.tool_input);
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Only the database tools are available in Database Tool; ${input.tool_name} is disabled.`
      }
    };
  };
}
