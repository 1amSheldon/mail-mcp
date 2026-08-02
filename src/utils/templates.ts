import { z } from 'zod';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export const TEMPLATES_PATH = path.join(os.homedir(), '.config', 'mail-mcp', 'templates.json');

// ---------------------------------------------------------------------------
// Template schema and type
// ---------------------------------------------------------------------------

export const emailTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  isHtml: z.boolean().optional(),
  accountId: z.string().optional(),
});

export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

// ---------------------------------------------------------------------------
// In-memory cache with fs.watch invalidation
// ---------------------------------------------------------------------------

let cachedTemplates: EmailTemplate[] | null = null;
let watcherStarted = false;

function startWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  try {
    fs.watch(TEMPLATES_PATH, () => {
      cachedTemplates = null;
    });
  } catch {
    // File may not exist yet — cache stays null until next read
  }
}

/** @internal — exposed for testing only */
export function resetTemplatesCache(): void {
  cachedTemplates = null;
  watcherStarted = false;
}

// ---------------------------------------------------------------------------
// Internal disk loader with per-item safeParse
// ---------------------------------------------------------------------------

async function loadTemplatesFromDisk(): Promise<EmailTemplate[]> {
  const raw = await fsPromises.readFile(TEMPLATES_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('templates.json must be an array');
    return [];
  }

  const valid: EmailTemplate[] = [];
  for (const item of parsed) {
    const result = emailTemplateSchema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      const id = typeof item?.id === 'string' ? item.id : '(unknown)';
      const fields = result.error.issues.map((i) => i.path.join('.') || 'root').join(', ');
      console.error(`templates.json: template "${id}" skipped — invalid fields: ${fields}`);
    }
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads template definitions from ~/.config/mail-mcp/templates.json.
 * Results are cached in memory; the cache is invalidated when the file changes.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export async function getTemplates(): Promise<EmailTemplate[]> {
  if (cachedTemplates !== null) return cachedTemplates;
  startWatcher();
  try {
    const loaded = await loadTemplatesFromDisk();
    cachedTemplates = loaded;
    return loaded;
  } catch {
    return [];
  }
}

/**
 * Replaces `{{key}}` placeholders in `template` with values from `vars`.
 * Unknown placeholders are left intact. Multiple occurrences are all replaced.
 */
export function applyVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}
