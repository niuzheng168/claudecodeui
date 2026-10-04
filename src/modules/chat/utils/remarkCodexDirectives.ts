import remarkDirective from 'remark-directive';
// Registers the processor's public micromarkExtensions data field.
import type {} from 'remark-parse';
import type { Nodes, Parent, Root } from 'mdast';
import type { Construct, State } from 'micromark-util-types';
import type { Processor } from 'unified';
import type { VFile } from 'vfile';

const DIRECTIVE_NAMES = [':codex-followup', ':codex-file-citation'];

// Limit the generic directive tokenizer *before* Markdown parsing, otherwise
// ordinary text like `see:[guide](url)` loses its link whenever the same reply
// contains a Codex marker. The check is lookahead: its temporary token is discarded.
const codexNameCheck: Construct = {
  tokenize(effects, ok, nok) {
    let prefix = '';
    const match: State = (code) => {
      if (DIRECTIVE_NAMES.includes(prefix)) {
        effects.exit('data');
        return code === 91 || code === 123 ? ok(code) : nok(code);
      }
      if (code === null) return nok(code);
      prefix += String.fromCharCode(code);
      if (!DIRECTIVE_NAMES.some(name => name.startsWith(prefix))) return nok(code);
      effects.consume(code);
      return match;
    };
    return (code) => {
      effects.enter('data');
      return match(code);
    };
  },
};

function readLabel(node: Nodes): string {
  if ('value' in node) return node.value;
  if (node.type === 'image') return node.alt ?? '';
  return 'children' in node ? node.children.map(readLabel).join('') : '';
}

function isFilePath(path: string): boolean {
  // Directives carry filesystem paths, not navigable URLs. Keep percent signs,
  // Unicode and Windows separators literal; authorization stays in the file API.
  return Boolean(path.trim())
    && !/[\u0000-\u001f\u007f]/.test(path)
    && (!/^[a-z][a-z\d+.-]*:/i.test(path.trim()) || /^[a-z]:[/\\]/i.test(path));
}

/**
 * Markdown's directive parser owns quoting/escaping and ignores code blocks.
 * Only these two Codex directives become controls; preserve everything else as
 * source text rather than letting unhandled directive nodes disappear.
 */
export function remarkCodexDirectives(this: Processor) {
  remarkDirective.call(this);
  const extensions = this.data().micromarkExtensions!;
  const extension = extensions[extensions.length - 1];
  const text = extension.text![58] as Construct;
  // Codex's two supported formats are inline, not block/container directives.
  delete extension.flow;
  extension.text = {
    58: {
      ...text,
      tokenize(effects, ok, nok) {
        return effects.check(codexNameCheck, text.tokenize.call(this, effects, ok, nok), nok);
      },
    },
  };

  return (tree: Root, file: VFile) => {
    const source = String(file);
    function walk(parent: Parent, insideLink = false) {
      parent.children.forEach((node, index) => {
        if (node.type === 'textDirective' || node.type === 'leafDirective' || node.type === 'containerDirective') {
          const prompt = node.attributes?.prompt;
          const path = node.attributes?.path;
          const isInline = node.type === 'textDirective';
          const isInteractive = isInline && !insideLink;
          const isFollowup = isInteractive && node.name === 'codex-followup' && Boolean(prompt?.trim());
          const isCitation = isInteractive && node.name === 'codex-file-citation' && Boolean(path && isFilePath(path));

          if (isFollowup || isCitation) {
            const label = readLabel(node).trim()
              || (isFollowup ? prompt! : path!.split(/[/\\]/).pop() || path!);
            node.data = {
              hName: 'span',
              hProperties: isFollowup
                ? { 'data-codex-followup': prompt! }
                : { 'data-codex-file-path': path! },
              // A label is text, never a nested link/button or arbitrary HTML.
              hChildren: [{ type: 'text', value: label }],
            };
            return;
          }

          const literal = source.slice(node.position?.start.offset, node.position?.end.offset);
          const text = { type: 'text' as const, value: literal };
          parent.children[index] = isInline ? text : { type: 'paragraph', children: [text] };
          return;
        }
        if ('children' in node) walk(node, insideLink || node.type === 'link' || node.type === 'linkReference');
      });
    }
    walk(tree);
  };
}
