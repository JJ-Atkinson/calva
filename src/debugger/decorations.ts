import * as vscode from 'vscode';
import * as namespace from '../namespace';
import * as state from '../state';
import { LanguageClient } from 'vscode-languageclient';
import { Position, Location, DocumentSymbol } from 'vscode-languageserver-protocol';
import lsp from '../lsp';
import * as _ from 'lodash';
import { NReplSession } from '../nrepl';
import * as util from '../utilities';

let enabled = false;

interface DecorationLocations {
    [symbolName: string]: Location[];
}
let decorationLocations: DecorationLocations = {};

const instrumentedFunctionDecorationType = vscode.window.createTextEditorDecorationType({
    borderStyle: 'solid',
    overviewRulerColor: 'blue',
    borderWidth: '1px 0px 1px 0px',
    light: {
        backgroundColor: 'rgba(31, 58, 147, 0.05);',
        borderColor: 'rgba(31, 58, 147, 1);'
    },
    dark: {
        backgroundColor: 'rgba(137, 196, 244, 0.1);',
        borderColor: 'rgba(137, 196, 244, 1);'
    }
});

async function getReferences(lspClient: LanguageClient, uri: string, position: Position): Promise<Location[] | null> {
    const result: Location[] = await lspClient.sendRequest('textDocument/references', {
        textDocument: {
            uri,
        },
        position,
        context: {
            includeDeclaration: true
        }
    });
    return result;
}

async function getDocumentSymbols(lspClient: LanguageClient, uri: string): Promise<DocumentSymbol[]> {
    const result: DocumentSymbol[] = await lspClient.sendRequest('textDocument/documentSymbol', {
        textDocument: {
            uri
        }
    });
    return result;
}

function clearUninstrumentedSymbolDecorations(instrumentedSymbols: DocumentSymbol[]): void {
    Object.keys(decorationLocations).forEach(symbol => {
        if (!instrumentedSymbols.map(s => s.name).includes(symbol)) {
            delete decorationLocations[symbol];
        }
    });
}

async function update(editor: vscode.TextEditor, cljSession: NReplSession, lspClient: LanguageClient): Promise<void> {
    if (/(\.clj)$/.test(editor.document.fileName)) {
        if (cljSession && util.getConnectedState() && lspClient) {
            const document = editor.document;

            // Get instrumented defs
            const docNamespace = namespace.getDocumentNamespace(document);
            const instrumentedDefs = await cljSession.listDebugInstrumentedDefs();

            // TODO: Refactor this implementation and structure of decorationLocations data
            clearUninstrumentedSymbolDecorations(instrumentedDefs);
            
            const instrumentedDefsInEditor = instrumentedDefs.list.filter(alist => alist[0] === docNamespace)[0]?.slice(1) || [];

            // Find locations of instrumented symbols
            const documentUri = document.uri.toString();
            const documentSymbols = await getDocumentSymbols(lspClient, documentUri);
            const instrumentedSymbolsInEditor = documentSymbols[0].children.filter(s => instrumentedDefsInEditor.includes(s.name));

            // Find locations of instrumented symbol references
            const instrumentedSymbolReferenceLocations = await Promise.all(instrumentedSymbolsInEditor.map(s => {
                const position = {
                    line: s.range.start.line,
                    character: s.range.start.character
                };
                return getReferences(lspClient, documentUri, position);
            }));
            const currentDocInstrumentedSymbolReferenceLocations = instrumentedSymbolsInEditor.reduce((currentLocations, symbol, i) => {
                return {
                    ...currentLocations,
                    [symbol.name]: instrumentedSymbolReferenceLocations[i]
                }
            }, {});
            decorationLocations = {
                ...decorationLocations,
                ...currentDocInstrumentedSymbolReferenceLocations
            }
        } else {
            decorationLocations = {};
        }
    }
}

function render(editor: vscode.TextEditor): void {
    const editorDecorationLocations = _.flatten(_.values(decorationLocations)).filter(loc => loc.uri === decodeURIComponent(editor.document.uri.toString()));
    const editorDecorationRanges = editorDecorationLocations.map(loc => {
        return new vscode.Range(loc.range.start.line, loc.range.start.character, loc.range.end.line, loc.range.end.character);
    });
    editor.setDecorations(instrumentedFunctionDecorationType, editorDecorationRanges);
}

function renderInAllVisibleEditors(): void {
    vscode.window.visibleTextEditors.forEach(editor => {
        render(editor);
    });
}

let timeout: NodeJS.Timer | undefined = undefined;

function triggerUpdateAndRenderDecorations() {
    if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
    }
    if (enabled) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            timeout = setTimeout(() => {
                const cljSession = namespace.getSession('clj');
                const lspClient = state.deref().get(lsp.LSP_CLIENT_KEY);
                update(editor, cljSession, lspClient).then(() => {
                    renderInAllVisibleEditors();
                });
            }, 50);
        }
    }
}

async function activate() {
    enabled = true;
    triggerUpdateAndRenderDecorations();

    vscode.window.onDidChangeVisibleTextEditors(editors => {
        renderInAllVisibleEditors();
    });

    vscode.workspace.onDidChangeTextDocument(event => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && event.document === activeEditor.document && event.contentChanges.length > 0) {
            triggerUpdateAndRenderDecorations();
        }
    });
}

export default {
    activate,
    triggerUpdateAndRenderDecorations
};