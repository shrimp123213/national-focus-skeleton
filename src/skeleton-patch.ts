/**
 * Local correction of a skeleton with JSON Patch style operations (handoff doc section 36).
 * Paths address focuses, branches, relations and choices by their id, so a model does not have to
 * count array positions: /nodes/{id}/impact, /nodes/-, /branches/{id}/core, /relations/2,
 * /capabilityCatalog/-, /choices/{group}/routes/-.
 */
import { z } from 'zod';

export const PatchOpSchema = z
  .object({
    op: z.enum(['insert', 'replace', 'remove']),
    path: z
      .string()
      .min(1)
      .describe('以 id 定位：/nodes/{國策id}/{欄位}、/nodes/-、/relations/-、/capabilityCatalog/-'),
    value: z.unknown().optional().describe('insert 與 replace 必填：新的值'),
  })
  .strict();
export type PatchOp = z.output<typeof PatchOpSchema>;
export const PatchReplySchema = z.object({ patch: z.array(PatchOpSchema).max(200) });

const idKeys = ['id', 'key', 'group', 'name', 'node'] as const;

function segments(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}
/** Position of `segment` in `list`: a number, or the element whose id / key / group / name matches. */
function indexOf(list: unknown[], segment: string): number {
  if (/^\d+$/.test(segment)) {
    const index = Number(segment);
    return index < list.length ? index : -1;
  }
  for (const key of idKeys) {
    const index = list.findIndex(
      (item) => item && typeof item === 'object' && (item as Record<string, unknown>)[key] === segment,
    );
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

/** Apply operations to a copy; bad operations are skipped and reported. */
export function applyPatch(
  root: unknown,
  ops: PatchOp[],
): { result: unknown; applied: number; errors: string[] } {
  const result = structuredClone(root) as Record<string, unknown>;
  let applied = 0;
  const errors: string[] = [];
  for (const op of ops) {
    const parts = segments(op.path);
    const last = parts.pop();
    if (!last) {
      errors.push(`${op.op} ${op.path}：路徑不可為空`);
      continue;
    }
    if (op.op !== 'remove' && op.value === undefined) {
      errors.push(`${op.op} ${op.path}：缺少 value`);
      continue;
    }
    let container: unknown = result;
    let broken = '';
    for (const [i, part] of parts.entries()) {
      if (Array.isArray(container)) {
        const index = indexOf(container, part);
        if (index < 0) {
          broken = `找不到「${part}」`;
          break;
        }
        container = container[index];
      } else if (container && typeof container === 'object') {
        const record = container as Record<string, unknown>;
        if (record[part] === undefined && op.op === 'insert') {
          // Create a missing list or map on the way, as an insert into an empty field.
          const next = parts[i + 1] ?? last;
          record[part] = next === '-' || /^\d+$/.test(next) ? [] : {};
        }
        container = record[part];
      } else {
        broken = `「${part}」不是物件或陣列`;
        break;
      }
    }
    if (broken || container === undefined || container === null || typeof container !== 'object') {
      errors.push(`${op.op} ${op.path}：${broken || '上層路徑不存在'}`);
      continue;
    }
    if (Array.isArray(container)) {
      if (op.op === 'insert') {
        if (last === '-') {
          container.push(op.value);
        } else if (/^\d+$/.test(last) && Number(last) <= container.length) {
          container.splice(Number(last), 0, op.value);
        } else {
          errors.push(`insert ${op.path}：陣列只能用 - 或序號新增`);
          continue;
        }
      } else {
        const index = indexOf(container, last);
        if (index < 0) {
          errors.push(`${op.op} ${op.path}：找不到「${last}」`);
          continue;
        }
        if (op.op === 'replace') {
          container[index] = op.value;
        } else {
          container.splice(index, 1);
        }
      }
    } else {
      const record = container as Record<string, unknown>;
      if (op.op === 'remove') {
        if (!(last in record)) {
          errors.push(`remove ${op.path}：欄位「${last}」不存在`);
          continue;
        }
        delete record[last];
      } else {
        record[last] = op.value;
      }
    }
    applied++;
  }
  return { result, applied, errors };
}

/** Schema problems in patch-path form, with focuses named by id instead of array position. */
export function schemaIssues(error: z.ZodError, root: unknown): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.map((part, i) => {
      if (typeof part === 'number' && i > 0) {
        const parent = issue.path
          .slice(0, i)
          .reduce<unknown>(
            (value, key) =>
              value && typeof value === 'object'
                ? (value as Record<PropertyKey, unknown>)[key as PropertyKey]
                : undefined,
            root,
          );
        const item = Array.isArray(parent) ? parent[part] : undefined;
        const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        if (issue.path[i - 1] === 'nodes' && typeof id === 'string') {
          return id;
        }
      }
      return String(part);
    });
    return `/${path.join('/')}：${issue.message}`;
  });
}
