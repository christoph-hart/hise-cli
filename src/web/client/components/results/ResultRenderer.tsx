// ── Dispatcher: CommandResult → variant component ───────────────────

import type { CommandResult } from "../../../../engine/result.js";
import { TextResult } from "./TextResult.js";
import { ErrorResult } from "./ErrorResult.js";
import { CodeResult } from "./CodeResult.js";
import { TableResult } from "./TableResult.js";
import { MarkdownResult } from "./MarkdownResult.js";
import { RunReportResult } from "./RunReportResult.js";
import { PreformattedResult } from "./PreformattedResult.js";
import { WizardResult } from "./WizardResult.js";

export function ResultRenderer({ result }: { result: CommandResult }) {
	switch (result.type) {
		case "text":
			return <TextResult result={result} />;
		case "error":
			return <ErrorResult result={result} />;
		case "code":
			return <CodeResult result={result} />;
		case "table":
			return <TableResult result={result} />;
		case "markdown":
			return <MarkdownResult result={result} />;
		case "run-report":
			return <RunReportResult result={result} />;
		case "preformatted":
			return <PreformattedResult result={result} />;
		case "json": {
			const text = result.fallbackText ?? JSON.stringify(result.value, null, 2);
			return (
				<pre className="result-code lang-json">
					<code>{text}</code>
				</pre>
			);
		}
		case "wizard":
			return <WizardResult result={result} />;
		case "empty":
			return null;
		default: {
			const _exhaustive: never = result;
			void _exhaustive;
			return null;
		}
	}
}
