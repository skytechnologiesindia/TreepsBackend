import { readFileSync } from 'node:fs';
import { ERROR_REGISTRY, type ErrorCode } from './error-registry.js';

const ALLOWED_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500];

const TABLE_CHANGED =
  'response-format.md section 5 table format changed or has rows this test cannot read';

const TABLE_ROW = /^\| [A-Z_]+ \|/;
const STRICT_ROW = /^\| ([A-Z_]+) \| (\d{3}) \| "(.+?)"(?: \(proposed\))? \|/;

interface DocRow {
  code: string;
  status: number;
  message: string;
}

function readDocRegistry(): { rows: DocRow[]; unreadable: string[] } {
  const doc = readFileSync(
    new URL('../../../docs/standards/response-format.md', import.meta.url),
    'utf8',
  );
  const section = doc.split('## 5. Error-code registry')[1]?.split('\n## ')[0] ?? '';
  const rows: DocRow[] = [];
  const unreadable: string[] = [];
  for (const line of section.split('\n')) {
    if (!TABLE_ROW.test(line)) continue;
    const match = STRICT_ROW.exec(line);
    if (match) {
      rows.push({ code: match[1], status: Number(match[2]), message: match[3] });
    } else {
      unreadable.push(line);
    }
  }
  return { rows, unreadable };
}

const { rows: docRows, unreadable } = readDocRegistry();
const codes = Object.keys(ERROR_REGISTRY);

describe('ERROR_REGISTRY', () => {
  it('can read every row of the registry table in response-format.md', () => {
    expect(unreadable, TABLE_CHANGED).toEqual([]);
    expect(docRows.length, TABLE_CHANGED).toBeGreaterThanOrEqual(13);
  });

  it('has exactly the 13 codes documented in response-format.md', () => {
    expect(docRows, TABLE_CHANGED).toHaveLength(13);
    expect(codes).toHaveLength(13);
    expect([...codes].sort()).toEqual(docRows.map((row) => row.code).sort());
  });

  it('uses UPPER_SNAKE_CASE for every code', () => {
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it('has a non-empty message for every code', () => {
    for (const code of codes) {
      expect(ERROR_REGISTRY[code as ErrorCode].message.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses only the allowed HTTP statuses', () => {
    for (const code of codes) {
      expect(ALLOWED_STATUSES).toContain(ERROR_REGISTRY[code as ErrorCode].status);
    }
  });

  it('matches the status and message in response-format.md for every code', () => {
    for (const row of docRows) {
      expect(ERROR_REGISTRY[row.code as ErrorCode]).toEqual({
        status: row.status,
        message: row.message,
      });
    }
  });
});
