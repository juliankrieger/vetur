import * as vscode from 'vscode';
import { activateLS, showFile, sleep, FILE_LOAD_SLEEP_TIME } from '../helper';
import { getDocUri } from '../util';
import { DiagnosticSeverity } from 'vscode-languageclient';
import { sameLineRange } from '../../lsp-ts-28/util';
import { testDiagnostics } from '../diagnostics/helper';

describe('Should find diagnostics in <template> region', () => {
  const docUri = getDocUri('client/diagnostics/Basic.vue');

  before('activate', async () => {
    await activateLS();
    await showFile(docUri);
    await sleep(FILE_LOAD_SLEEP_TIME);
  });

  it('Show diagnostics for basic expression', async () => {
    const expectedDiagnostics: vscode.Diagnostic[] = [
      {
        range: sameLineRange(1, 8, 16),
        severity: DiagnosticSeverity.Error,
        message: `Property 'messaage' does not exist`
      }
    ];

    await testDiagnostics(docUri, expectedDiagnostics);
  });
});
