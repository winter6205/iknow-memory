import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SECTION_TITLE = "## 跨仓对齐基线";
const SECTION_PREFIX = "## ";

type Line = {
  start: number;
  end: number;
  contentEnd: number;
};

class BaselineCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

class ArgumentError extends BaselineCheckError {}

class SpecFileError extends BaselineCheckError {}

class SectionNotFoundError extends BaselineCheckError {}

class EmptySectionError extends BaselineCheckError {}

function splitLines(source: Buffer): Line[] {
  const lines: Line[] = [];
  let start = 0;

  while (start < source.length) {
    const newline = source.indexOf(0x0a, start);
    const end = newline === -1 ? source.length : newline + 1;
    const contentEnd = newline === -1 ? end : newline;
    const lineEnd =
      contentEnd > start && source[contentEnd - 1] === 0x0d
        ? contentEnd - 1
        : contentEnd;

    lines.push({ start, end, contentEnd: lineEnd });
    start = end;
  }

  return lines;
}

function lineText(source: Buffer, line: Line): string {
  return source.subarray(line.start, line.contentEnd).toString("utf8");
}

function isBaselineHeading(text: string): boolean {
  return text === SECTION_TITLE || text.startsWith(`${SECTION_TITLE}（`);
}

function isBlankLine(source: Buffer, line: Line): boolean {
  for (let index = line.start; index < line.contentEnd; index += 1) {
    const byte = source[index];
    if (byte !== 0x20 && byte !== 0x09) return false;
  }
  return true;
}

function extractSectionBody(source: Buffer, filePath: string): Buffer {
  const lines = splitLines(source);
  const headingIndex = lines.findIndex((line) =>
    isBaselineHeading(lineText(source, line))
  );
  if (headingIndex === -1) {
    throw new SectionNotFoundError(
      `section "${SECTION_TITLE}" not found in "${filePath}"`
    );
  }

  const nextHeadingIndex = lines.findIndex(
    (line, index) =>
      index > headingIndex && lineText(source, line).startsWith(SECTION_PREFIX)
  );
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  let bodyStart = headingIndex + 1;
  let bodyEnd = sectionEnd;

  while (bodyStart < bodyEnd && isBlankLine(source, lines[bodyStart]!)) {
    bodyStart += 1;
  }
  while (bodyEnd > bodyStart && isBlankLine(source, lines[bodyEnd - 1]!)) {
    bodyEnd -= 1;
  }

  if (bodyStart === bodyEnd) {
    throw new EmptySectionError(
      `section "${SECTION_TITLE}" is empty in "${filePath}"`
    );
  }

  return source.subarray(lines[bodyStart]!.start, lines[bodyEnd - 1]!.end);
}

function readSectionBody(filePath: string): Buffer {
  let source: Buffer;
  try {
    source = readFileSync(filePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SpecFileError(`cannot read "${filePath}": ${detail}`);
  }

  return extractSectionBody(source, filePath);
}

function sha256(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `UnknownError: ${String(error)}`;
}

function main(): void {
  const paths = process.argv.slice(2);
  if (paths.length !== 2) {
    throw new ArgumentError(
      `expected exactly two spec file paths, received ${paths.length}`
    );
  }

  const firstPath = paths[0]!;
  const secondPath = paths[1]!;
  const firstHash = sha256(readSectionBody(firstPath));
  const secondHash = sha256(readSectionBody(secondPath));

  console.log(`sha256 ${firstPath}: ${firstHash}`);
  console.log(`sha256 ${secondPath}: ${secondHash}`);

  if (firstHash !== secondHash) {
    console.error("FAIL: cross-repo baseline section bodies differ.");
    process.exitCode = 1;
    return;
  }

  console.log("OK: cross-repo baseline section bodies match.");
}

try {
  main();
} catch (error: unknown) {
  console.error(`FAIL: ${formatError(error)}`);
  process.exitCode = 1;
}
