export type McpJsonValue = null | boolean | number | string | McpJsonValue[] | { [key: string]: McpJsonValue };

export interface McpCallOptions {
	url?: string;
	timeoutMs?: number;
}

export interface McpCallRequest {
	method: string;
	params?: McpJsonValue;
}

export interface McpToolRequest {
	name: string;
	arguments?: McpJsonValue;
}

export interface McpClient {
	call(request: McpCallRequest, options?: McpCallOptions): Promise<McpJsonValue>;
	callTool(request: McpToolRequest, options?: McpCallOptions): Promise<McpJsonValue>;
}

export interface McpToolInfo {
	name: string;
	description?: string;
}

export interface McpResourceInfo {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface McpPromptInfo {
	name: string;
	title?: string;
	description?: string;
}
