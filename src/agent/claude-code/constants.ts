export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export enum ClaudeCodeError {
	CliNotFound = "claude CLI not found",
	NotSignedIn = "not signed in",
}

/** Listed ids that the CLI doesn't know as an alias, mapped to the model id
 *  passed to `claude --model`. */
export const CLAUDE_CODE_CLI_MODEL: Readonly<Record<string, string>> = { fable: "claude-fable-5-2" };

/** The `claude --model` value for a listed model id. */
export function claudeCliModel(id: string): string {
	return CLAUDE_CODE_CLI_MODEL[id] ?? id;
}
