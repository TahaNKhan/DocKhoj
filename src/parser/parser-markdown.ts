import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as nodeToString } from 'mdast-util-to-string';
import type { Root, RootContent } from 'mdast';
import type { ParsedBlock, BlockKind } from './parser-types.js';

function kindOf(node: RootContent): BlockKind {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'code':
      return 'code';
    case 'list':
      return 'list';
    case 'table':
      return 'table';
    case 'blockquote':
      return 'quote';
    case 'thematicBreak':
      return 'other';
    case 'paragraph':
    case 'html':
    default:
      return 'paragraph';
  }
}

function flattenListItems(node: RootContent): string {
  if (node.type !== 'list') return nodeToString(node);
  const lines: string[] = [];
  for (const item of node.children) {
    if (item.type === 'listItem') {
      const text = nodeToString(item).trim();
      lines.push(text);
    }
  }
  return lines.join('\n');
}

function depthOf(node: RootContent): number | undefined {
  if (node.type === 'heading') return node.depth;
  if (node.type === 'list') return node.ordered ? 0 : 0;
  return undefined;
}

export function parseMarkdown(source: string): ParsedBlock[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const blocks: ParsedBlock[] = [];
  const headingStack: { depth: number; text: string }[] = [];

  let cursor = 0;

  for (const node of tree.children) {
    const kind = kindOf(node);
    const text =
      kind === 'list'
        ? flattenListItems(node)
        : kind === 'heading'
          ? nodeToString(node).trim()
          : nodeToString(node);

    if (!text || !text.trim()) {
      continue;
    }

    let nodeDepth: number | undefined;
    if (kind === 'heading') {
      nodeDepth = node.type === 'heading' ? node.depth : 0;
      const depthValue = nodeDepth ?? 0;
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.depth >= depthValue
      ) {
        headingStack.pop();
      }
      headingStack.push({ depth: depthValue, text: text.trim() });
    }

    const compareDepth = nodeDepth ?? depthOf(node) ?? 0;
    const headingPath = headingStack
      .filter((h) => kind !== 'heading' || h.depth < compareDepth)
      .map((h) => h.text);

    const startOffset = cursor;
    const endOffset = cursor + text.length;
    cursor = endOffset;

    blocks.push({
      kind,
      text: text.trim(),
      headingPath,
      startOffset,
      endOffset,
      depth: depthOf(node),
      language: node.type === 'code' ? node.lang ?? undefined : undefined,
    });
  }

  return blocks;
}