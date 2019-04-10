import * as ts from 'typescript';
import * as path from 'path';
import { parse } from 'vue-eslint-parser';

import { getVueDocumentRegions } from '../../embeddedSupport/embeddedSupport';
import { TextDocument } from 'vscode-languageserver-types';
import { T_TypeScript } from '../../services/dependencyService';
import { transformTemplate, componentHelperName, iterationHelperName, renderHelperName } from './transformTemplate';
import { isVirtualVueTemplateFile } from './serviceHost';

export function isVue(filename: string): boolean {
  return path.extname(filename) === '.vue';
}

export function parseVueScript(text: string): string {
  const doc = TextDocument.create('test://test/test.vue', 'vue', 0, text);
  const regions = getVueDocumentRegions(doc);
  const script = regions.getSingleTypeDocument('script');
  return script.getText() || 'export default {};';
}

function parseVueTemplate(text: string): string {
  const doc = TextDocument.create('test://test/test.vue', 'vue', 0, text);
  const regions = getVueDocumentRegions(doc);
  const template = regions.getSingleTypeDocument('template');

  if (template.languageId !== 'vue-html') {
    return '';
  }
  const rawText = template.getText();
  // skip checking on empty template
  if (rawText.replace(/\s/g, '') === '') {
    return '';
  }
  return rawText.replace(/^\s*\n/, '<template>\n').replace(/\s*\n$/, '\n</template>');
}

export function createUpdater(tsModule: T_TypeScript) {
  const clssf = tsModule.createLanguageServiceSourceFile;
  const ulssf = tsModule.updateLanguageServiceSourceFile;
  const scriptKindTracker = new WeakMap<ts.SourceFile, ts.ScriptKind | undefined>();
  const modificationTracker = new WeakSet<ts.SourceFile>();

  function isTSLike(scriptKind: ts.ScriptKind | undefined) {
    return scriptKind === tsModule.ScriptKind.TS || scriptKind === tsModule.ScriptKind.TSX;
  }

  function modifySourceFile(
    fileName: string,
    sourceFile: ts.SourceFile,
    scriptSnapshot: ts.IScriptSnapshot,
    version: string,
    scriptKind?: ts.ScriptKind
  ): void {
    if (modificationTracker.has(sourceFile)) {
      return;
    }

    if (isVue(fileName) && !isTSLike(scriptKind)) {
      modifyVueScript(tsModule, sourceFile);
      modificationTracker.add(sourceFile);
      return;
    }

    if (isVirtualVueTemplateFile(fileName)) {
      // TODO: share the logic of transforming the code into AST
      // with the template mode
      const code = parseVueTemplate(scriptSnapshot.getText(0, scriptSnapshot.getLength()));
      const program = parse(code, { sourceType: 'module' });
      const tsCode = transformTemplate(program, code);
      injectVueTemplate(tsModule, sourceFile, tsCode);
      modificationTracker.add(sourceFile);
    }
  }

  function createLanguageServiceSourceFile(
    fileName: string,
    scriptSnapshot: ts.IScriptSnapshot,
    scriptTarget: ts.ScriptTarget,
    version: string,
    setNodeParents: boolean,
    scriptKind?: ts.ScriptKind
  ): ts.SourceFile {
    const sourceFile = clssf(fileName, scriptSnapshot, scriptTarget, version, setNodeParents, scriptKind);
    scriptKindTracker.set(sourceFile, scriptKind);
    modifySourceFile(fileName, sourceFile, scriptSnapshot, version, scriptKind);
    return sourceFile;
  }

  function updateLanguageServiceSourceFile(
    sourceFile: ts.SourceFile,
    scriptSnapshot: ts.IScriptSnapshot,
    version: string,
    textChangeRange: ts.TextChangeRange,
    aggressiveChecks?: boolean
  ): ts.SourceFile {
    const scriptKind = scriptKindTracker.get(sourceFile);
    sourceFile = ulssf(sourceFile, scriptSnapshot, version, textChangeRange, aggressiveChecks);
    modifySourceFile(sourceFile.fileName, sourceFile, scriptSnapshot, version, scriptKind);
    return sourceFile;
  }

  return {
    createLanguageServiceSourceFile,
    updateLanguageServiceSourceFile
  };
}

function modifyVueScript(tsModule: T_TypeScript, sourceFile: ts.SourceFile): void {
  const exportDefaultObject = sourceFile.statements.find(
    st =>
      st.kind === tsModule.SyntaxKind.ExportAssignment &&
      (st as ts.ExportAssignment).expression.kind === tsModule.SyntaxKind.ObjectLiteralExpression
  );
  if (exportDefaultObject) {
    // 1. add `import Vue from 'vue'
    //    (the span of the inserted statement must be (0,0) to avoid overlapping existing statements)
    const setZeroPos = getWrapperRangeSetter(tsModule, { pos: 0, end: 0 });
    const vueImport = setZeroPos(
      tsModule.createImportDeclaration(
        undefined,
        undefined,
        setZeroPos(tsModule.createImportClause(tsModule.createIdentifier('__vueEditorBridge'), undefined as any)),
        setZeroPos(tsModule.createLiteral('vue-editor-bridge'))
      )
    );
    const statements: Array<ts.Statement> = sourceFile.statements as any;
    statements.unshift(vueImport);

    // 2. find the export default and wrap it in `__vueEditorBridge(...)` if it exists and is an object literal
    // (the span of the function construct call and *all* its members must be the same as the object literal it wraps)
    const objectLiteral = (exportDefaultObject as ts.ExportAssignment).expression as ts.ObjectLiteralExpression;
    const setObjPos = getWrapperRangeSetter(tsModule, objectLiteral);
    const vue = tsModule.setTextRange(tsModule.createIdentifier('__vueEditorBridge'), {
      pos: objectLiteral.pos,
      end: objectLiteral.pos + 1
    });
    (exportDefaultObject as ts.ExportAssignment).expression = setObjPos(
      tsModule.createCall(vue, undefined, [objectLiteral])
    );
    setObjPos(((exportDefaultObject as ts.ExportAssignment).expression as ts.CallExpression).arguments!);
  }
}

/**
 * Wrap render function with component options in the script block
 * to validate its types
 */
function injectVueTemplate(tsModule: T_TypeScript, sourceFile: ts.SourceFile, renderBlock: ts.Expression[]): void {
  // add import statement for corresponding Vue file
  // so that we acquire the component type from it.
  const setZeroPos = getWrapperRangeSetter(tsModule, { pos: 0, end: 0 });
  const vueFilePath = './' + path.basename(sourceFile.fileName.slice(0, -9));
  const componentImport = setZeroPos(
    tsModule.createImportDeclaration(
      undefined,
      undefined,
      setZeroPos(tsModule.createImportClause(setZeroPos(tsModule.createIdentifier('__Component')), undefined)),
      setZeroPos(tsModule.createLiteral(vueFilePath))
    )
  );

  // import helper type to handle Vue's private methods
  const helperImport = setZeroPos(
    tsModule.createImportDeclaration(
      undefined,
      undefined,
      setZeroPos(
        tsModule.createImportClause(
          undefined,
          setZeroPos(
            tsModule.createNamedImports([
              setZeroPos(
                tsModule.createImportSpecifier(undefined, setZeroPos(tsModule.createIdentifier(renderHelperName)))
              ),
              setZeroPos(
                tsModule.createImportSpecifier(undefined, setZeroPos(tsModule.createIdentifier(componentHelperName)))
              ),
              setZeroPos(
                tsModule.createImportSpecifier(undefined, setZeroPos(tsModule.createIdentifier(iterationHelperName)))
              )
            ])
          )
        )
      ),
      setZeroPos(tsModule.createLiteral('vue-editor-bridge'))
    )
  );

  // wrap render code with a function decralation
  // with `this` type of component.
  const setRenderPos = getWrapperRangeSetter(tsModule, sourceFile);
  const statements = renderBlock.map(exp => tsModule.createStatement(exp));
  const renderElement = setRenderPos(
    tsModule.createStatement(
      setRenderPos(
        tsModule.createCall(setRenderPos(tsModule.createIdentifier(renderHelperName)), undefined, [
          // Reference to the component
          setRenderPos(tsModule.createIdentifier('__Component')),

          // A function simulating the render function
          setRenderPos(
            tsModule.createFunctionExpression(
              undefined,
              undefined,
              undefined,
              undefined,
              [],
              undefined,
              setRenderPos(tsModule.createBlock(statements))
            )
          )
        ])
      )
    )
  );

  // replace the original statements with wrapped code.
  sourceFile.statements = setRenderPos(tsModule.createNodeArray([componentImport, helperImport, renderElement]));

  // Update external module indicator to the transformed template node,
  // otherwise symbols in this template (e.g. __Component) will be put
  // into global namespace and it causes duplicated identifier error.
  (sourceFile as any).externalModuleIndicator = componentImport;
}

/** Create a function that calls setTextRange on synthetic wrapper nodes that need a valid range */
function getWrapperRangeSetter(
  tsModule: T_TypeScript,
  wrapped: ts.TextRange
): <T extends ts.TextRange>(wrapperNode: T) => T {
  return <T extends ts.TextRange>(wrapperNode: T) => tsModule.setTextRange(wrapperNode, wrapped);
}
