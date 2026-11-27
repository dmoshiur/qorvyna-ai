/** Narrow execution intent; ordinary requests for advice must not run commands. */
export function requestsSandboxExecution(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  // A build request that also says "test the code" belongs to the build
  // pipeline unless it explicitly asks for terminal/sandbox execution.
  if (/\b(?:build|create|develop|fix|modify)\b[^\n]{0,100}\b(?:website|project|app|application)\b/i.test(text) && !/\b(?:sandbox|terminal|command|shell)\b/i.test(text)) return false;
  if (/^(?:echo|pwd|whoami|ls|cat|stat|grep|sleep|js|npm|node|python3?|git|curl)(?:\s|$)/i.test(text)) return true;
  return /\b(?:run|execute|test)\b/i.test(text) && /\b(?:command|sandbox|terminal|shell|script|program|code|tests)\b/i.test(text);
}

/** A literal command after a colon, code fence or as the entire message. */
export function explicitSandboxCommand(message: string): string | null {
  const text = message.trim();
  const fenced = /```(?:sh|bash|shell|text)?\s*\n([^\n`]+)\s*```/i.exec(text);
  const afterColon = /(?:^|\n|:)\s*((?:echo|pwd|whoami|ls|cat|stat|grep|sleep|js|npm|node|python3?|git|curl)\b[^\n]*)\s*$/i.exec(text);
  const afterRequest = /\b(?:run|execute|test)\b[^\n:]*:\s*([^\n]+)$/i.exec(text);
  const inline = /\b(?:run|execute|test)\b[^\n]*?\b(echo|pwd|whoami|ls|cat|stat|grep|sleep|js)\b([^\n]*)$/i.exec(text);
  const command = fenced?.[1]?.trim() || afterColon?.[1]?.trim() || afterRequest?.[1]?.trim() || (inline ? `${inline[1]}${inline[2]}`.trim() : null);
  return command && command.length <= 4000 ? command : null;
}
