#!/usr/bin/env python3
"""
Fix alignment of Unicode box-drawing diagrams in Markdown files.

For each ``` code block containing box-drawing characters, the script:
  1. Finds the canonical width from the outermost border line (first char = ┌/└).
  2. For content lines that START at column 0 with a box char and END with │:
       - Too short → inserts spaces before the final │
       - Too long  → removes trailing spaces before the final │
         (only if the char left before the final │ is still a space — avoids ││)
  3. Writes the fixed content back to the file (or reports in --dry-run mode).

Usage:
    python fix_ascii_tables.py [--dry-run] [--verbose] [path ...]

    --dry-run   : report changes without writing files
    --verbose   : print each changed line
    path        : one or more files or glob patterns; defaults to docs/**/*.md
"""

import sys
import glob
import unicodedata
from pathlib import Path

# ── Box-drawing character sets ────────────────────────────────────────────────
H_CHARS  = set("─━═")
V_CHARS  = set("│║┃")
TL_CHARS = set("┌╔┏╭")
TR_CHARS = set("┐╗┓╮")
BL_CHARS = set("└╚┗╰")
BR_CHARS = set("┘╝┛╯")
CROSS    = set("┬┴├┤┼╠╣╦╩╬")
ALL_BOX  = H_CHARS | V_CHARS | TL_CHARS | TR_CHARS | BL_CHARS | BR_CHARS | CROSS


def display_width(s: str) -> int:
    """Terminal display width, accounting for wide East-Asian characters."""
    w = 0
    for c in s:
        ea = unicodedata.east_asian_width(c)
        w += 2 if ea in ("W", "F") else 1
    return w


# ── Canonical width ───────────────────────────────────────────────────────────

def canonical_width_of_block(block_lines: list[str]) -> int | None:
    """
    Return the display width of the outermost border line.

    The outermost border must begin at column 0 with ┌ (or └) — i.e. no
    leading spaces — and end with the corresponding corner ┐ (or ┘).
    """
    for group in [(TL_CHARS, TR_CHARS), (BL_CHARS, BR_CHARS)]:
        left_set, right_set = group
        for line in block_lines:
            s = line.rstrip()
            if s and s[0] in left_set and s[-1] in right_set:
                return display_width(s)
    return None


# ── Single-line fixer ─────────────────────────────────────────────────────────

def fix_line(raw_line: str, canonical_w: int) -> str:
    """
    Adjust *raw_line* to have display width equal to *canonical_w*.

    Safety rules (we skip the line if any is violated):
      R1. The line must start at column 0 with a box character — lines with
          leading spaces are connector / sub-box lines that live outside or
          inside nested boxes with their own widths.
      R2. The line must end with a vertical-bar box char (│ ║ ┃).  Horizontal
          border rows end with ┐/┘ and adjusting their dash count without
          knowing the intended column layout is risky, so we leave them alone.
      R3. When shortening: we only remove pure-space characters, and after
          removal the character immediately before the final │ must NOT be a
          box char (to avoid producing ││ or similar collisions).
    """
    newline = "\n" if raw_line.endswith("\n") else ""
    line = raw_line[: len(raw_line) - len(newline)]
    stripped = line.rstrip()

    if not stripped:
        return raw_line

    # R1 — must start at col 0 with a box char
    if stripped[0] not in ALL_BOX:
        return raw_line

    # R2 — must end with a vertical bar
    last_char = stripped[-1]
    if last_char not in V_CHARS:
        return raw_line

    current_w = display_width(stripped)
    diff = canonical_w - current_w
    if diff == 0:
        return raw_line

    prefix  = stripped[:-1]   # everything before the closing │
    closing = stripped[-1]

    if diff > 0:
        # Too short → pad with spaces before closing │
        return prefix + " " * diff + closing + newline

    # diff < 0 → too long → try to remove |diff| spaces before closing │
    spaces_to_remove = -diff
    if len(prefix) >= spaces_to_remove:
        tail = prefix[-spaces_to_remove:]
        if tail == " " * spaces_to_remove:
            new_prefix = prefix[:-spaces_to_remove]
            # R3 — do not create adjacent box chars (e.g. ││)
            if new_prefix and new_prefix[-1] in ALL_BOX:
                return raw_line   # would produce adjacent box chars → skip
            return new_prefix + closing + newline

    return raw_line   # cannot safely shorten → leave unchanged


# ── Block processor ───────────────────────────────────────────────────────────

def fix_block(
    block_lines: list[str], verbose: bool = False
) -> tuple[list[str], int]:
    """Fix alignment in a box-drawing code block. Returns (fixed, n_changes)."""
    canonical_w = canonical_width_of_block(block_lines)
    if canonical_w is None:
        return block_lines, 0

    fixed = []
    n = 0
    for line in block_lines:
        new = fix_line(line, canonical_w)
        if new != line:
            n += 1
            if verbose:
                old_s = line.rstrip()
                new_s = new.rstrip()
                print(f"  - [{display_width(old_s):3d}w] {old_s}")
                print(f"  + [{display_width(new_s):3d}w] {new_s}")
        fixed.append(new)
    return fixed, n


# ── File processor ────────────────────────────────────────────────────────────

def process_file(
    filepath: str, dry_run: bool = False, verbose: bool = False
) -> int:
    """Process *filepath*. Returns total lines changed."""
    path = Path(filepath)
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        print(f"[SKIP] {filepath}: {exc}", file=sys.stderr)
        return 0

    lines  = content.split("\n")
    result: list[str] = []
    i      = 0
    total  = 0

    while i < len(lines):
        line = lines[i]

        # Detect opening ``` fence (plain — no language tag)
        if line.strip() == "```":
            result.append(line)
            i += 1

            code: list[str] = []
            while i < len(lines) and lines[i].strip() != "```":
                code.append(lines[i])
                i += 1

            if any(any(c in l for c in ALL_BOX) for l in code):
                if verbose:
                    cw = canonical_width_of_block(code)
                    print(f"  Block at line {i - len(code)} (canonical_w={cw}):")
                fixed_code, changes = fix_block(code, verbose=verbose)
                total += changes
                result.extend(fixed_code)
            else:
                result.extend(code)

            if i < len(lines):
                result.append(lines[i])
                i += 1
        else:
            result.append(line)
            i += 1

    new_content = "\n".join(result)
    if new_content != content:
        if not dry_run:
            path.write_text(new_content, encoding="utf-8")
        tag = "[DRY-RUN]" if dry_run else "[FIXED]  "
        print(f"{tag} {filepath}  ({total} line(s) adjusted)")
    else:
        if verbose:
            print(f"[OK]     {filepath}")

    return total


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    dry_run = "--dry-run" in sys.argv
    verbose = "--verbose" in sys.argv
    raw_args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if raw_args:
        paths: list[str] = []
        for pattern in raw_args:
            expanded = glob.glob(pattern, recursive=True)
            paths.extend(expanded if expanded else [pattern])
    else:
        paths = sorted(glob.glob(
            str(Path(__file__).parent.parent / "docs" / "**" / "*.md"),
            recursive=True,
        ))

    if not paths:
        print("No files found.", file=sys.stderr)
        sys.exit(1)

    grand_total = 0
    for p in paths:
        if verbose:
            print(f"\n{'=' * 60}\n{p}")
        grand_total += process_file(p, dry_run=dry_run, verbose=verbose)

    print(f"\nTotal lines adjusted: {grand_total}")
    if dry_run:
        print("(dry-run mode — no files were written)")


if __name__ == "__main__":
    main()
