import { acceptedContent, type ClientCapabilities, inputRequired } from '@modelcontextprotocol/server';
import type { ToolCall, ToolResult } from './define.ts';
import { ok } from './define.ts';

const CLIENT_CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities';

export function clientSupportsElicitation(call: ToolCall): boolean {
  const envelope = call.ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps =
    (envelope?.[CLIENT_CAPS_KEY] as ClientCapabilities | undefined) ?? call.env.server.server.getClientCapabilities();
  return Boolean(caps?.elicitation);
}

export type Confirmation =
  | { status: 'confirmed' }
  | { status: 'declined'; result: ToolResult }
  | { status: 'ask'; result: ToolResult };

/**
 * Asks the user to confirm a consequential action through MCP elicitation, when the client supports it
 * and NULA_CONFIRM_WRITES=elicit. On 2026-07-28 clients this is a multi-round-trip `input_required`
 * result; the SDK shims it into a classic `elicitation/create` request for older clients.
 *
 * Clients without elicitation rely on the tool's destructive annotations and the preview step.
 */
export function confirmAction(call: ToolCall, message: string, opts: { always?: boolean } = {}): Confirmation {
  const policy = call.env.config.confirmWrites;
  if ((policy === 'never' && !opts.always) || !clientSupportsElicitation(call)) return { status: 'confirmed' };

  const responses = call.ctx.mcpReq.inputResponses;
  const accepted = acceptedContent<{ confirm?: boolean }>(responses, 'confirm');
  if (accepted) {
    return accepted.confirm === true
      ? { status: 'confirmed' }
      : {
          status: 'declined',
          result: ok('Cancelled: the user did not confirm. Nothing was changed in nula.bg.', { cancelled: true }),
        };
  }
  if (responses && 'confirm' in responses) {
    return {
      status: 'declined',
      result: ok('Cancelled by the user. Nothing was changed in nula.bg.', { cancelled: true }),
    };
  }
  return {
    status: 'ask',
    result: inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', title: 'Потвърждавам / Confirm', description: message },
            },
            required: ['confirm'],
          },
        }),
      },
    }),
  };
}
