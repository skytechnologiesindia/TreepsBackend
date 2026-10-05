import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DTO_HINT = 'Read the whole object through a DTO class instead.';
const RAW_HINT =
  'Raw request access bypasses the DTO or the response envelope. The authenticated user will come from a guard plus a custom parameter decorator (decided in F4).';

// Whole-word matching: a name must be followed directly by "(", so @Res( never matches
// @Response( (and the other way round), and @Req( never matches @Request(.
interface BannedPattern {
  name: string;
  rule: number;
  hint: string;
  pattern: RegExp;
  // Where the rule is written, when it is not input-validation.md.
  where?: string;
}

const BANNED: BannedPattern[] = [
  { name: 'a built-in Parse pipe', rule: 5, hint: DTO_HINT, pattern: /\bParse(?:Int|Float|Bool|Array|UUID|Enum)Pipe\b/ },
  { name: "named extraction @Param('x')", rule: 5, hint: DTO_HINT, pattern: /@Param\(\s*['"`]/ },
  { name: "named extraction @Query('x')", rule: 5, hint: DTO_HINT, pattern: /@Query\(\s*['"`]/ },
  { name: "named extraction @Body('x')", rule: 5, hint: DTO_HINT, pattern: /@Body\(\s*['"`]/ },
  { name: 'raw request access @Req()', rule: 13, hint: RAW_HINT, pattern: /@Req\s*\(/ },
  { name: 'raw request access @Request()', rule: 13, hint: RAW_HINT, pattern: /@Request\s*\(/ },
  { name: 'raw response access @Res()', rule: 13, hint: RAW_HINT, pattern: /@Res\s*\(/ },
  { name: 'raw response access @Response()', rule: 13, hint: RAW_HINT, pattern: /@Response\s*\(/ },
  { name: 'raw header access @Headers()', rule: 13, hint: RAW_HINT, pattern: /@Headers\s*\(/ },
  {
    name: 'a version written in a @Controller path',
    rule: 0,
    where: 'docs/standards/api-standard.md, section 8',
    hint: 'Remove it: the default version already adds the /v1 prefix, so a written version would be served at /v1/v1/....',
    // @Controller('v1/x'), @Controller("/v2"), @Controller({ path: 'v1/x' }); any letter case.
    pattern: /@Controller\(\s*(?:\{[^}]*\bpath\s*:\s*)?['"`]\/?v\d+(?:['"`/])/i,
  },
];

// Files allowed to break a rule, with the reason. Growing this list needs an owner decision.
const ALLOWLIST: Readonly<Record<string, string>> = {};

function blankOutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, lead: string) => lead);
}

function findBannedPatterns(path: string, source: string): string[] {
  if (Object.hasOwn(ALLOWLIST, path)) return [];
  const original = source.split('\n');
  const findings: string[] = [];
  blankOutComments(source)
    .split('\n')
    .forEach((line, i) => {
      for (const { name, rule, hint, pattern, where } of BANNED) {
        if (pattern.test(line)) {
          findings.push(
            `${path}:${i + 1}: ${name} is banned (${where ?? `docs/standards/input-validation.md, rule ${rule}`}). ${hint}\n    > ${original[i].trim()}`,
          );
        }
      }
    });
  return findings;
}

function sourceFiles(): string[] {
  return readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.endsWith('-spec.ts'))
    .map((p) => `src/${p}`);
}

describe('banned patterns (input-validation.md rules 5 and 13)', () => {
  it('no non-spec source file under src/ uses a banned pattern', () => {
    const findings = sourceFiles().flatMap((f) =>
      findBannedPatterns(f, readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(findings, `Banned patterns found:\n${findings.join('\n')}`).toEqual([]);
  });

  it('actually scans source files and skips specs', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('src/main.ts');
    expect(files.some((f) => f.endsWith('.spec.ts'))).toBe(false);
  });

  it('fails on a planted example (a named Param with a built-in pipe)', () => {
    const found = findBannedPatterns('src/planted.controller.ts', "one(@Param('id', ParseIntPipe) id: number) {}");
    expect(found).toHaveLength(2);
    expect(found.join('\n')).toContain("named extraction @Param('x')");
    expect(found.join('\n')).toContain('a built-in Parse pipe');
    expect(found[0]).toContain('src/planted.controller.ts:1:');
  });

  it('names the file, the line, the rule and how to fix it', () => {
    const [finding] = findBannedPatterns('src/x.controller.ts', 'a\n\nbad(@Req() req: Request) {}');
    expect(finding).toContain('src/x.controller.ts:3:');
    expect(finding).toContain('raw request access @Req()');
    expect(finding).toContain('rule 13');
    expect(finding).toContain('guard plus a custom parameter decorator');
    expect(finding).toContain('> bad(@Req() req: Request) {}');
  });

  describe('flags', () => {
    it.each([
      '@Query("page") p: string',
      '@Body(`x`) x: string',
      "@Query( 'a' ) a: string",
      'new ParseUUIDPipe()',
      'ParseEnumPipe',
      'ParseFloatPipe',
    ])('the older patterns: %s', (code) => {
      expect(findBannedPatterns('src/x.ts', code)).not.toEqual([]);
    });

    it.each([
      ['@Req() req: Request', 'raw request access @Req()'],
      ['@Req( ) req', 'raw request access @Req()'],
      ['@Request() req', 'raw request access @Request()'],
      ['@Res() res: Response', 'raw response access @Res()'],
      ['@Res({ passthrough: true }) res', 'raw response access @Res()'],
      ['@Response() res', 'raw response access @Response()'],
      ['@Headers() headers', 'raw header access @Headers()'],
      ["@Headers('authorization') auth: string", 'raw header access @Headers()'],
    ])('the raw-access patterns, each by its own name: %s', (code, name) => {
      const found = findBannedPatterns('src/x.ts', code);
      expect(found).toHaveLength(1); // the whole-word rule: exactly one pattern matches
      expect(found[0]).toContain(name);
    });
  });

  describe('does not flag', () => {
    it.each([
      '@Body() body: Dto',
      '@Query() query: ListQuery',
      '@Param() params: IdParams',
      '// ParseIntPipe is banned',
      "/* @Param('x') */",
      '// @Req() is banned',
      '/* @Res() @Response() @Headers() */',
    ])('the allowed or commented code: %s', (code) => {
      expect(findBannedPatterns('src/x.ts', code)).toEqual([]);
    });

    it.each([
      'import type { Request, Response } from "express";',
      'const headers = req.headers;',
      'const res = await fetch(url);',
      '@Reservation() r: string',
      '@Requests() r: string',
      '@Reqs() r: string',
      '@HeadersX() h: string',
      'function Res() {}',
    ])('look-alikes and plain uses of the words: %s', (code) => {
      expect(findBannedPatterns('src/x.ts', code)).toEqual([]);
    });
  });

  describe('a version written in a @Controller path', () => {
    it.each([
      "@Controller('v1/rides')",
      '@Controller("v2")',
      '@Controller(`v10/x`)',
      "@Controller('/v1/rides')",
      "@Controller( 'V1/rides' )",
      "@Controller({ path: 'v1/rides' })",
      "@Controller({ version: '1', path: 'v3' })",
    ])('flags %s', (code) => {
      const found = findBannedPatterns('src/x.controller.ts', code);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('a version written in a @Controller path');
      expect(found[0]).toContain('docs/standards/api-standard.md, section 8');
      expect(found[0]).toContain('/v1/v1/');
    });

    it.each([
      "@Controller('rides')",
      '@Controller()',
      "@Controller('auth')",
      "@Controller('video')",
      "@Controller('v')",
      "@Controller('vip/v1')",
      "@Controller({ path: 'rides', version: '2' })",
      "@Controller({ path: 'health', version: VERSION_NEUTRAL })",
      "// @Controller('v1/rides') is wrong",
      "@Get('v1')",
    ])('does not flag %s', (code) => {
      expect(findBannedPatterns('src/x.controller.ts', code)).toEqual([]);
    });
  });

  it('has an empty allowlist, so every file is checked', () => {
    const code = "login(@Body('idToken') idToken: string) {}";
    expect(findBannedPatterns('src/other/auth.controller.ts', code)).not.toEqual([]);
    expect(ALLOWLIST).toEqual({});
  });
});
