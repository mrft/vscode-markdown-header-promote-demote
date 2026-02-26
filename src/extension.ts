import * as vscode from 'vscode';

/**
 * Activate the extension — register promote and demote commands.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Update context key whenever the cursor moves or the active editor changes.
  const updateContext = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      vscode.commands.executeCommand(
        'setContext',
        'markdownStructure.onHeaderLine',
        false
      );
      return;
    }

    // When there is a selection, check the *first* line of the selection.
    // When there is no selection, check the line the cursor is on.
    const checkLine = editor.selection.isEmpty
      ? editor.selection.active.line
      : editor.selection.start.line;
    const lineText = editor.document.lineAt(checkLine).text;
    const onHeader = /^#{1,6}\s/.test(lineText);
    vscode.commands.executeCommand(
      'setContext',
      'markdownStructure.onHeaderLine',
      onHeader
    );
  };

  updateContext();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateContext()),
    vscode.window.onDidChangeTextEditorSelection(() => updateContext()),
    vscode.commands.registerTextEditorCommand(
      'markdownStructure.promote',
      (editor) => adjustHeaders(editor, -1)
    ),
    vscode.commands.registerTextEditorCommand(
      'markdownStructure.demote',
      (editor) => adjustHeaders(editor, 1)
    )
  );
}

export function deactivate(): void {}

/* ------------------------------------------------------------------ */
/*  Core logic                                                         */
/* ------------------------------------------------------------------ */

/**
 * Collect the line numbers of all actual markdown headers by querying the
 * VS Code document-symbol provider.  Because the provider understands
 * document structure, `#` characters inside fenced code blocks are
 * excluded automatically.
 *
 * Returns `undefined` when the provider is unavailable (callers should
 * then fall back to regex-based detection).
 */
async function getHeaderLineNumbers(
  document: vscode.TextDocument
): Promise<Set<number> | undefined> {
  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | undefined
  >('vscode.executeDocumentSymbolProvider', document.uri);

  if (!symbols) {
    return undefined;
  }

  const lines = new Set<number>();

  function collect(list: vscode.DocumentSymbol[]): void {
    for (const sym of list) {
      lines.add(sym.range.start.line);
      if (sym.children.length > 0) {
        collect(sym.children);
      }
    }
  }

  collect(symbols);
  return lines;
}

/**
 * Adjust every markdown header in the affected range by `delta` levels.
 *
 * `delta = -1` → promote (## → #)
 * `delta = +1` → demote  (## → ###)
 *
 * **Structure-preserving behaviour**
 *
 * *With a selection*:  Every header line inside the selection is shifted by
 * `delta`, keeping their relative depths intact.
 *
 * *Without a selection (cursor on a line)*: The header on the cursor line
 * **and every sub-header that belongs to that section** are shifted by
 * `delta`.  A "sub-header" is any header whose level is strictly greater
 * than the cursor header, up to (but not including) the next header of the
 * same or lesser level.
 */
async function adjustHeaders(
  editor: vscode.TextEditor,
  delta: number
): Promise<void> {
  const document = editor.document;
  const selection = editor.selection;

  // Use the document-symbol provider to identify real header lines.
  // This prevents incorrectly treating `#` inside code blocks as headers.
  // Falls back to regex when the provider is unavailable.
  const headerLines = await getHeaderLineNumbers(document);
  const isHeader = (lineIndex: number): boolean => {
    if (headerLines !== undefined) {
      return headerLines.has(lineIndex);
    }
    return /^#{1,6}\s/.test(document.lineAt(lineIndex).text);
  };

  // Determine which lines to process.
  let startLine: number;
  let endLine: number;

  if (!selection.isEmpty) {
    // --- Selection mode: operate only on selected lines ---
    startLine = selection.start.line;
    endLine = selection.end.line;

    // When the selection ends at column 0 of a line, the user didn't
    // actually select that line — exclude it.
    if (selection.end.character === 0 && endLine > startLine) {
      endLine--;
    }

    // If the first selected line is not a header, fall back to the
    // default Tab / Shift+Tab behaviour (indent / outdent).
    if (!isHeader(startLine)) {
      await vscode.commands.executeCommand(
        delta > 0 ? 'editor.action.indentLines' : 'editor.action.outdentLines'
      );
      return;
    }
  } else {
    // --- No selection: operate on the section rooted at the cursor ---
    const cursorLine = selection.active.line;
    const range = getSectionRange(document, cursorLine, isHeader);
    if (!range) {
      // Cursor is not on a header line — nothing to do.
      return;
    }
    startLine = range.start;
    endLine = range.end;
  }

  // Validate that the operation will not produce invalid levels.
  if (!canAdjust(document, startLine, endLine, isHeader, delta)) {
    vscode.window.showWarningMessage(
      delta < 0
        ? 'Cannot promote: one or more headers are already at level 1 (#).'
        : 'Cannot demote: one or more headers would exceed level 6 (######).'
    );
    return;
  }

  // Apply the edit.
  await editor.edit((editBuilder) => {
    for (let i = startLine; i <= endLine; i++) {
      if (!isHeader(i)) {
        continue;
      }
      const line = document.lineAt(i);
      const headerMatch = line.text.match(/^(#{1,6})\s/);
      if (!headerMatch) {
        continue;
      }
      const oldHashes = headerMatch[1];
      const newLevel = oldHashes.length + delta;
      const newHashes = '#'.repeat(newLevel);
      const newText = line.text.replace(/^#{1,6}/, newHashes);
      editBuilder.replace(line.range, newText);
    }
  });

  // Optionally renumber all headers across the entire document.
  const config = vscode.workspace.getConfiguration('markdownStructure');
  if (config.get<boolean>('updateNumbering', true)) {
    await renumberHeaders(editor, headerLines);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Return the line range `[startLine, endLine]` representing the full section
 * rooted at `cursorLine`.
 *
 * If `cursorLine` is not a header, returns `undefined`.
 *
 * `isHeader` is a predicate that returns true only for lines that are actual
 * markdown headers (not `#` characters inside code blocks).
 */
function getSectionRange(
  document: vscode.TextDocument,
  cursorLine: number,
  isHeader: (lineIndex: number) => boolean
): { start: number; end: number } | undefined {
  if (!isHeader(cursorLine)) {
    return undefined;
  }
  const headerMatch = document.lineAt(cursorLine).text.match(/^(#{1,6})\s/);
  if (!headerMatch) {
    return undefined;
  }
  const rootLevel = headerMatch[1].length;

  let endLine = cursorLine;
  for (let i = cursorLine + 1; i < document.lineCount; i++) {
    if (isHeader(i)) {
      const m = document.lineAt(i).text.match(/^(#{1,6})\s/);
      if (m && m[1].length <= rootLevel) {
        // We've hit a sibling or higher-level header — stop.
        break;
      }
    }
    endLine = i;
  }
  return { start: cursorLine, end: endLine };
}

/**
 * Check whether every header in the range can be safely shifted by `delta`.
 *
 * `isHeader` is a predicate that returns true only for lines that are actual
 * markdown headers (not `#` characters inside code blocks).
 */
function canAdjust(
  document: vscode.TextDocument,
  startLine: number,
  endLine: number,
  isHeader: (lineIndex: number) => boolean,
  delta: number
): boolean {
  for (let i = startLine; i <= endLine; i++) {
    if (!isHeader(i)) {
      continue;
    }
    const m = document.lineAt(i).text.match(/^(#{1,6})\s/);
    if (m) {
      const newLevel = m[1].length + delta;
      if (newLevel < 1 || newLevel > 6) {
        return false;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Numbering                                                          */
/* ------------------------------------------------------------------ */

/**
 * Regex that matches a header line with an optional numeric prefix.
 *
 * Groups:
 *   [1] hashes        e.g. "##"
 *   [2] numeric prefix (may be undefined) e.g. "1.3.2"
 *   [3] title text     e.g. "Conclusion"
 *
 * Supports prefixes like `1`, `1.2`, `1.2.3`, etc.
 * The prefix must be followed by a space (or end-of-string for edge cases).
 */
const HEADER_RE = /^(#{1,6})\s+(?:(\d+(?:\.\d+)*)\s+)?(.*)$/;

/**
 * Scan the entire document and rewrite numeric prefixes on every header
 * so that numbering is consistent with the heading hierarchy.
 *
 * Only headers that *already* have a numeric prefix are updated — plain
 * headers without a number are left untouched (they don't participate in
 * the counter, but they don't reset it either).
 *
 * `headerLines` is the set of line numbers that are actual markdown headers,
 * as identified by the document-symbol provider.  When provided it prevents
 * treating `#` characters inside code blocks as headers.  When omitted the
 * function falls back to regex-based detection.
 */
async function renumberHeaders(
  editor: vscode.TextEditor,
  headerLines?: Set<number>
): Promise<void> {
  const document = editor.document;

  const isRealHeader = (lineIndex: number): boolean => {
    if (headerLines !== undefined) {
      return headerLines.has(lineIndex);
    }
    return HEADER_RE.test(document.lineAt(lineIndex).text);
  };

  // First pass: collect info about every header.
  interface HeaderInfo {
    line: number;
    level: number;
    hasNumber: boolean;
    titleText: string;
  }

  const headers: HeaderInfo[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    if (!isRealHeader(i)) {
      continue;
    }
    const text = document.lineAt(i).text;
    const m = text.match(HEADER_RE);
    if (!m) {
      continue;
    }
    headers.push({
      line: i,
      level: m[1].length,
      hasNumber: m[2] !== undefined,
      titleText: m[3],
    });
  }

  if (headers.length === 0) {
    return;
  }

  // Second pass: compute the correct number for each header.
  // We keep a counter array indexed by level (1-6).
  // When we encounter level N, we increment counter[N] and reset
  // counters for all deeper levels.
  const counters: number[] = [0, 0, 0, 0, 0, 0, 0]; // index 0 unused

  const edits: { line: number; newText: string }[] = [];

  for (const h of headers) {
    counters[h.level]++;
    // Reset deeper levels.
    for (let l = h.level + 1; l <= 6; l++) {
      counters[l] = 0;
    }

    if (!h.hasNumber) {
      // This header has no numeric prefix — leave it alone, but it still
      // contributes to the counters so siblings after it get correct numbers.
      continue;
    }

    // Build the number string from level 1 down to h.level.
    // Skip leading levels that have a counter of 0 (i.e. no header was
    // seen at that level yet).  This handles cases where the document
    // starts at ## instead of #.
    const parts: number[] = [];
    let started = false;
    for (let l = 1; l <= h.level; l++) {
      if (counters[l] > 0) {
        started = true;
      }
      if (started) {
        parts.push(counters[l] || 1);
      }
    }
    const numberStr = parts.join('.');

    const hashes = '#'.repeat(h.level);
    const newText = `${hashes} ${numberStr} ${h.titleText}`;
    const currentText = document.lineAt(h.line).text;
    if (newText !== currentText) {
      edits.push({ line: h.line, newText });
    }
  }

  if (edits.length === 0) {
    return;
  }

  await editor.edit((editBuilder) => {
    for (const e of edits) {
      editBuilder.replace(document.lineAt(e.line).range, e.newText);
    }
  });
}
