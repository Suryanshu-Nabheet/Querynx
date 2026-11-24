/**
 * Querynx CLI: search, extract, research, index and status commands
 * over the SDK. Argument parsing is dependency-free (stdlib argv
 * tokenization) to keep the CLI zero-install beyond the workspace.
 */

import { QuerynxClient, QuerynxError } from '@querynx/sdk';

export interface CliOptions {
  baseUrl: string;
  apiKey?: string;
}

export function clientFromEnv(overrides: Partial<CliOptions> = {}): QuerynxClient {
  const baseUrl =
    overrides.baseUrl ?? process.env['QUERYNX_URL'] ?? 'http://127.0.0.1:3001';
  const apiKey =
    overrides.apiKey ?? process.env['QUERYNX_API_KEY'] ?? undefined;
  return new QuerynxClient({ baseUrl, apiKey });
}

/** Tokenize argv into flags, options and positionals. */
export function parseArgs(argv: readonly string[]): {
  flags: Set<string>;
  options: Record<string, string>;
  positionals: string[];
} {
  const flags = new Set<string>();
  const options: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
        options[body] = argv[++i]!;
      } else {
        flags.add(body);
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, options, positionals };
}

export const USAGE = `querynx — the open web, built for agents

Usage:
  querynx search <query> [--max N] [--freshness day|week|month|year]
  querynx extract <url> [url...]
  querynx research <objective> [--mode fast|standard|advanced|deep|academic|technical|documentation]
  querynx index <url> [--collection NAME]
  querynx semantic <query> [--collection NAME]
  querynx status
  querynx providers

Environment:
  QUERYNX_URL       API base URL (default http://127.0.0.1:3001)
  QUERYNX_API_KEY   API key`;

export interface CliOutput {
  exitCode: number;
  text: string;
}

/** Run a CLI invocation programmatically (returns output instead of
 * printing) — the same path main.ts uses for real terminal I/O. */
export async function runCli(argv: readonly string[]): Promise<CliOutput> {
  const { flags, options, positionals } = parseArgs(argv);
  const command = positionals[0];
  const rest = positionals.slice(1);

  try {
    const client = clientFromEnv({
      baseUrl: options['url'],
      apiKey: options['key'],
    });

    switch (command) {
      case 'search': {
        const query = rest.join(' ');
        if (!query) return usage('search requires a query');
        const response = await client.search(query, {
          maxResults: Number(options['max'] ?? 10),
          freshness: (options['freshness'] as 'day' | undefined) ?? undefined,
        });
        return ok(formatResults(response.results.map((r) => ({
          title: r.title, url: r.url, snippet: r.snippet,
        }))));
      }

      case 'extract': {
        if (rest.length === 0) return usage('extract requires at least one url');
        const response = await client.extract(rest);
        const lines: string[] = [];
        for (const item of response.results) {
          if (item.ok && item.document) {
            lines.push(`# ${item.document.title ?? item.url}`);
            lines.push(item.document.content.slice(0, Number(options['chars'] ?? 4000)));
            lines.push('');
          } else {
            lines.push(`FAILED ${item.url}: ${item.error}`);
          }
        }
        return ok(lines.join('\n'));
      }

      case 'research': {
        const objective = rest.join(' ');
        if (objective.length < 3) return usage('research requires an objective');
        const { report } = await client.research(objective, {
          mode: (options['mode'] as 'fast' | undefined) ?? undefined,
        });
        const parts = [report.findings, '', 'Sources:'];
        for (const e of report.evidence.slice(0, 10)) parts.push(`- ${e.title}: ${e.url}`);
        if (report.gaps.length > 0) {
          parts.push('', 'Unresolved:');
          for (const g of report.gaps) parts.push(`- ${g.question}`);
        }
        parts.push('', `termination: ${report.termination}`);
        return ok(parts.join('\n'));
      }

      case 'status': {
        const health = await client.health();
        return ok(JSON.stringify(health, null, 2));
      }

      case 'providers': {
        const { providers } = await client.providers();
        const rows = providers.map((p) =>
          `${p.configured ? '✓' : '×'} ${p.name}  state=${p.state}  p50=${p.medianLatencyMs}ms  success=${(p.successRate * 100).toFixed(0)}%`
        );
        return ok(rows.join('\n'));
      }

      default:
        return usage(USAGE);
    }
  } catch (err) {
    if (err instanceof QuerynxError) {
      return { exitCode: err.status || 1, text: `error: ${err.message} (${err.code ?? 'UNKNOWN'})` };
    }
    return { exitCode: 1, text: `error: ${err instanceof Error ? err.message : String(err)}` };
  }

  function usage(message: string): CliOutput {
    return { exitCode: 2, text: `${message}\n\n${flags.has('help') ? '' : ''}${USAGE}` };
  }
}

function ok(text: string): CliOutput {
  return { exitCode: 0, text };
}

function formatResults(results: Array<{ title: string; url: string; snippet: string }>): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 160)}`)
    .join('\n\n');
}
