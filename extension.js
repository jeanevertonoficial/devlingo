const vscode = require('vscode');

// Cache para evitar requisições duplicadas à API de tradução
const translationCache = new Map();

// Tipo de decoração para a tradução inline (balão no final da linha)
const inlineDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        textDecoration: 'none; position: absolute; border-radius: 4px; padding: 1px 6px; margin-left: 15px; white-space: nowrap;',
        color: 'rgba(255, 255, 255, 0.45)', // Cinza claro
        backgroundColor: 'rgba(79, 195, 247, 0.08)', // Fundo azul translúcido
        border: '1px solid rgba(79, 195, 247, 0.2)' // Borda azul fina
    }
});

// Configurações padrão
let settings = {
    hoverEnabled: true,
    inlineEnabled: false,
    voiceEngine: 'online',
    speechRate: '0.9',
    geminiApiKey: '',
    selectedEnVoiceName: '',
    selectedPtVoiceName: ''
};

// Estatísticas padrão
let stats = {
    streak: 0,
    lastQuizDate: '',
    totalQuizzes: 0,
    correctAnswers: 0,
    totalQuestions: 0
};

let inlineTimeout = null;
let extContext = null; // Referência global para o contexto da extensão

/**
 * Heurística simples para detectar se um texto contém palavras ou acentos do português.
 * @param {string} text Texto a analisar
 * @returns {boolean}
 */
function hasPortugueseWords(text) {
    const ptWords = /\b(de|do|da|em|para|por|com|um|uma|os|as|ao|aos|seu|sua|seus|suas|ele|ela|eles|elas|este|esta|esse|essa|aquele|aquela|isso|isto|aquilo|como|mais|mas|ou|e|se|feita|feito|teste|extensão|desenvolvedor|desenvolvedora)\b/i;
    const ptAccents = /[áàâãéèêíïóòôõúüçñ]/i;
    return ptWords.test(text) || ptAccents.test(text);
}

/**
 * Traduz e analisa um texto usando o Gemini API (se configurado) ou Google Translate (grátis).
 * @param {string} text Texto a ser traduzido
 * @returns {Promise<{ translated: string, from: string, to: string, connectedSpeech: string, explanationEn: string, explanationPt: string }>}
 */
async function translateText(text) {
    if (!text || !text.trim()) {
        return { translated: '', from: '', to: '', connectedSpeech: '', explanationEn: '', explanationPt: '' };
    }

    const trimmed = text.trim();
    if (translationCache.has(trimmed)) {
        return translationCache.get(trimmed);
    }

    let result = null;

    // Se houver chave API do Gemini configurada, usamos IA para formular e trazer conectado speech + explicações
    if (settings.geminiApiKey && settings.geminiApiKey.trim()) {
        try {
            result = await translateWithGemini(trimmed, settings.geminiApiKey.trim());
        } catch (err) {
            console.error('Erro na tradução com Gemini, recorrendo ao Google Translate:', err);
        }
    }

    // Se a tradução com Gemini falhar ou não estiver disponível
    if (!result) {
        try {
            const isPtHeuristic = hasPortugueseWords(trimmed);

            const urlEn = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(trimmed)}`;
            const resEn = await fetch(urlEn);
            const dataEn = await resEn.json();

            let detectedLang = dataEn[2];
            let translatedText = dataEn[0].map(s => s[0]).join('');

            let from = detectedLang;
            let to = 'en';

            if (from === 'en' && isPtHeuristic) {
                from = 'pt';
            }

            if (from === 'en') {
                const urlPt = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=pt&dt=t&q=${encodeURIComponent(trimmed)}`;
                const resPt = await fetch(urlPt);
                const dataPt = await resPt.json();
                translatedText = dataPt[0].map(s => s[0]).join('');
                from = 'en';
                to = 'pt';
            } else {
                if (isPtHeuristic) {
                    from = 'pt';
                    to = 'en';
                }
            }

            result = {
                translated: translatedText,
                from: from,
                to: to,
                connectedSpeech: '',
                explanationEn: '',
                explanationPt: ''
            };
        } catch (error) {
            console.error('Erro na tradução DevLingo:', error);
            throw new Error('Não foi possível conectar ao serviço de tradução. Verifique sua conexão.');
        }
    }

    if (result) {
        translationCache.set(trimmed, result);
        
        // Persiste cache atualizado no globalState do VS Code de forma assíncrona
        try {
            if (extContext) {
                const cacheObj = {};
                let count = 0;
                for (const [key, val] of translationCache.entries()) {
                    if (count++ > 150) break;
                    cacheObj[key] = val;
                }
                extContext.globalState.update('translationCache', cacheObj);
            }
        } catch (e) {
            console.error('Falha ao persistir cache de tradução:', e);
        }
    }

    return result;
}

/**
 * Tradução avançada usando a API do Gemini
 */
async function translateWithGemini(text, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const prompt = `Você é um professor particular de inglês focado em programadores e profissionais de tecnologia.
Analise o texto a seguir para realizar a tradução bidirecional (PT <-> EN). Se o texto for majoritariamente em português, formule para o inglês de forma correta e idiomática. Se for em inglês, traduza para o português.

Texto a ser analisado: "${text}"

Instruções importantes para o JSON de retorno:
1. "translated": Forneça a tradução correta e mais natural (especialmente adaptada ao contexto corporativo de TI se aplicável).
2. "connectedSpeech": Adicione um guia de pronúncia com foco em "Connected Speech" (mostre conexões de palavras como 'look_at', reduções como 'wanna', 'gonna', linkings e uma aproximação de como falar de forma natural em um fluxo contínuo). Exemplo: "What do you" -> "whaddya".
3. "explanationEn": Escreva uma explicação gramatical ou de vocabulário da tradução de 1 a 2 frases EM INGLÊS.
4. "explanationPt": Forneça a tradução exata em PORTUGUÊS da explicação contida no campo "explanationEn".
5. "from": Código do idioma de origem ("pt" ou "en").
6. "to": Código do idioma de destino ("pt" ou "en").

Retorne a resposta estritamente no formato de objeto JSON com as chaves: "translated", "connectedSpeech", "explanationEn", "explanationPt", "from", "to". Não coloque blocos de marcação de código do tipo \`\`\`json no retorno, apenas a string JSON limpa.`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: prompt
                }]
            }]
        })
    });

    if (!response.ok) {
        throw new Error(`Gemini API retornou status ${response.status}`);
    }

    const data = await response.json();
    const textResult = data.candidates[0].content.parts[0].text;
    
    let cleanedText = textResult.trim();
    if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    }

    const jsonResult = JSON.parse(cleanedText);
    
    return {
        translated: jsonResult.translated || '',
        connectedSpeech: jsonResult.connectedSpeech || '',
        explanationEn: jsonResult.explanationEn || '',
        explanationPt: jsonResult.explanationPt || '',
        from: jsonResult.from || 'pt',
        to: jsonResult.to || 'en'
    };
}

/**
 * Obtém o caractere de comentário adequado para cada tipo de linguagem.
 */
function getCommentPrefix(languageId) {
    switch (languageId) {
        case 'python':
        case 'ruby':
        case 'shellscript':
        case 'yaml':
        case 'dockerfile':
        case 'powershell':
        case 'properties':
        case 'ini':
        case 'coffeescript':
            return { start: '#', end: '' };
        case 'html':
        case 'xml':
        case 'vue':
            return { start: '<!--', end: ' -->' };
        case 'css':
        case 'less':
            return { start: '/*', end: ' */' };
        default:
            return { start: '//', end: '' };
    }
}

/**
 * Remove caracteres de comentário do início e fim do texto.
 */
function cleanCommentText(text) {
    return text
        .replace(/^(\/\/|\/\*|#|<!--)\s*/, '')
        .replace(/\s*(\*\/|-->)$/, '')
        .trim();
}

/**
 * Limpa a decoração inline de tradução.
 */
function clearInlineDecorations(editor) {
    const active = editor || vscode.window.activeTextEditor;
    if (active) {
        active.setDecorations(inlineDecorationType, []);
    }
}

/**
 * Atualiza o balão inline com a tradução da linha atual ou de todas as linhas do bloco selecionado.
 */
function updateInlineDecoration(editor) {
    if (!editor || !settings.inlineEnabled) {
        clearInlineDecorations(editor);
        return;
    }

    const startLine = editor.selection.start.line;
    const endLine = editor.selection.end.line;

    if (inlineTimeout) {
        clearTimeout(inlineTimeout);
    }

    inlineTimeout = setTimeout(async () => {
        try {
            const linesToTranslate = [];
            for (let i = startLine; i <= endLine; i++) {
                const lineText = editor.document.lineAt(i).text.trim();
                linesToTranslate.push({ lineNum: i, text: lineText });
            }

            const translationPromises = linesToTranslate.map(async (line) => {
                const cleaned = cleanCommentText(line.text);
                if (!cleaned || cleaned.length < 3 || /^(const|let|var|function|import|export|class|return|if|else|for|while|from)$/.test(cleaned)) {
                    return null;
                }
                try {
                    const res = await translateText(cleaned);
                    return { lineNum: line.lineNum, translated: res.translated };
                } catch (err) {
                    return null;
                }
            });

            const results = (await Promise.all(translationPromises)).filter(r => r !== null);

            if (editor === vscode.window.activeTextEditor && 
                editor.selection.start.line === startLine && 
                editor.selection.end.line === endLine) {
                
                const decorations = results.map(result => {
                    const lineLength = editor.document.lineAt(result.lineNum).text.length;
                    const decorationRange = new vscode.Range(
                        new vscode.Position(result.lineNum, lineLength),
                        new vscode.Position(result.lineNum, lineLength)
                    );

                    let displayText = result.translated;
                    if (displayText.length > 80) {
                        displayText = displayText.substring(0, 77) + '...';
                    }

                    return {
                        range: decorationRange,
                        renderOptions: {
                            after: {
                                contentText: ` 💬 ${displayText} `
                            }
                        }
                    };
                });

                editor.setDecorations(inlineDecorationType, decorations);
            }
        } catch (err) {
            // Falha silenciosa
        }
    }, 400);
}

/**
 * Provedor do Painel Lateral (Sidebar Webview)
 */
class DevLingoSidebarProvider {
    static viewType = 'devlingo.sidebar';

    constructor(context) {
        this._context = context;
        this._view = undefined;
        this._pendingSpeak = null;
        this._pendingPopulate = null;
    }

    resolveWebviewView(webviewView, context, token) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready':
                    // Envia as configurações atuais e estatísticas para carregar a Webview
                    webviewView.webview.postMessage({
                        type: 'initSettings',
                        settings: settings,
                        stats: stats
                    });

                    if (this._pendingSpeak) {
                        this.speak(this._pendingSpeak.text, this._pendingSpeak.lang);
                        this._pendingSpeak = null;
                    }

                    if (this._pendingPopulate) {
                        this.populateAndTranslate(this._pendingPopulate);
                        this._pendingPopulate = null;
                    }
                    break;
                case 'translate':
                    try {
                        const result = await translateText(data.text);
                        webviewView.webview.postMessage({
                            type: 'translationResult',
                            original: data.text,
                            translated: result.translated,
                            from: result.from,
                            to: result.to,
                            connectedSpeech: result.connectedSpeech || '',
                            explanationEn: result.explanationEn || '',
                            explanationPt: result.explanationPt || ''
                        });
                    } catch (err) {
                        vscode.window.showErrorMessage(err.message);
                    }
                    break;
                case 'updateSettings':
                    settings = data.settings;
                    this._context.globalState.update('hoverEnabled', settings.hoverEnabled);
                    this._context.globalState.update('inlineEnabled', settings.inlineEnabled);
                    this._context.globalState.update('voiceEngine', settings.voiceEngine);
                    this._context.globalState.update('speechRate', settings.speechRate);
                    this._context.globalState.update('geminiApiKey', settings.geminiApiKey);
                    this._context.globalState.update('selectedEnVoiceName', settings.selectedEnVoiceName);
                    this._context.globalState.update('selectedPtVoiceName', settings.selectedPtVoiceName);
                    
                    // Se houver estatísticas atualizadas enviadas da webview, salva também
                    if (data.stats) {
                        stats = data.stats;
                        this._context.globalState.update('stats', stats);
                    }

                    if (settings.inlineEnabled) {
                        updateInlineDecoration(vscode.window.activeTextEditor);
                    } else {
                        clearInlineDecorations();
                    }
                    break;
                case 'showError':
                    vscode.window.showErrorMessage(data.message);
                    break;
                case 'showInfo':
                    vscode.window.showInformationMessage(data.message);
                    break;
            }
        });
    }

    speak(text, lang) {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({ type: 'speak', text, lang });
        } else {
            this._pendingSpeak = { text, lang };
            vscode.commands.executeCommand('devlingo.sidebar.focus');
        }
    }

    populateAndTranslate(text) {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({ type: 'populateAndTranslate', text });
        } else {
            this._pendingPopulate = text;
            vscode.commands.executeCommand('devlingo.sidebar.focus');
        }
    }

    _getHtmlForWebview(webview) {
        const fs = require('fs');
        const path = require('path');
        const htmlPath = path.join(this._context.extensionPath, 'sidebar.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        return html;
    }
}

/**
 * Método de ativação da extensão
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('DevLingo Extension ativa!');
    extContext = context;

    // Carrega o cache persistente do globalState
    try {
        const savedCache = context.globalState.get('translationCache', {});
        for (const [k, v] of Object.entries(savedCache)) {
            translationCache.set(k, v);
        }
    } catch (e) {
        console.error('Falha ao carregar cache de tradução persistente:', e);
    }

    // Carrega as configurações
    settings.hoverEnabled = context.globalState.get('hoverEnabled', true);
    settings.inlineEnabled = context.globalState.get('inlineEnabled', false);
    settings.voiceEngine = context.globalState.get('voiceEngine', 'online');
    settings.speechRate = context.globalState.get('speechRate', '0.9');
    settings.geminiApiKey = context.globalState.get('geminiApiKey', '');
    settings.selectedEnVoiceName = context.globalState.get('selectedEnVoiceName', '');
    settings.selectedPtVoiceName = context.globalState.get('selectedPtVoiceName', '');

    // Carrega estatísticas salvas
    stats = context.globalState.get('stats', {
        streak: 0,
        lastQuizDate: '',
        totalQuizzes: 0,
        correctAnswers: 0,
        totalQuestions: 0
    });

    const sidebarProvider = new DevLingoSidebarProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DevLingoSidebarProvider.viewType,
            sidebarProvider
        )
    );

    const translateReplaceCmd = vscode.commands.registerCommand('devlingo.translateReplace', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const text = editor.document.getText(selection);

        if (!text) {
            vscode.window.showInformationMessage('Selecione um texto para traduzir.');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Traduzindo...",
                cancellable: false
            }, async () => {
                const res = await translateText(text);
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, res.translated);
                });
                vscode.window.showInformationMessage(`Traduzido de ${res.from.toUpperCase()} para ${res.to.toUpperCase()}!`);
            });
        } catch (err) {
            vscode.window.showErrorMessage(err.message);
        }
    });

    const translateCommentCmd = vscode.commands.registerCommand('devlingo.translateComment', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const text = editor.document.getText(selection);

        if (!text) {
            vscode.window.showInformationMessage('Selecione um texto para traduzir como comentário.');
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Gerando Comentário Traduzido...",
                cancellable: false
            }, async () => {
                const res = await translateText(text);
                const commentStyle = getCommentPrefix(editor.document.languageId);
                
                const originalClean = cleanCommentText(text);
                const translatedClean = cleanCommentText(res.translated);

                let commentStr = '';
                if (res.from === 'pt') {
                    commentStr = `${commentStyle.start} PT: ${originalClean} | EN: ${translatedClean}${commentStyle.end}`;
                } else {
                    commentStr = `${commentStyle.start} EN: ${originalClean} | PT: ${translatedClean}${commentStyle.end}`;
                }

                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, commentStr);
                });
            });
        } catch (err) {
            vscode.window.showErrorMessage(err.message);
        }
    });

    const speakCmd = vscode.commands.registerCommand('devlingo.speak', async (textArg) => {
        let text = textArg;

        if (!text) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                text = editor.document.getText(editor.selection);
            }
        }

        if (!text) {
            vscode.window.showInformationMessage('Selecione um texto para ouvir a pronúncia.');
            return;
        }

        const cleaned = cleanCommentText(text);
        
        try {
            const res = await translateText(cleaned);
            sidebarProvider.speak(cleaned, res.from);
        } catch (err) {
            sidebarProvider.speak(cleaned, 'en');
        }
    });

    // Traduzir de Qualquer Lugar (Editor, Terminal, Chats, Clipboard)
    const translateAnywhereCmd = vscode.commands.registerCommand('devlingo.translateAnywhere', async () => {
        let text = '';

        // 1. Tenta pegar a seleção do editor ativo
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            text = editor.document.getText(editor.selection);
        }

        // 2. Se não houver seleção no editor, lê diretamente o clipboard do sistema (para terminal, chats, etc.)
        if (!text || !text.trim()) {
            text = await vscode.env.clipboard.readText();
        }

        if (!text || !text.trim()) {
            vscode.window.showInformationMessage('Copie algum texto para a Área de Transferência (Ctrl+C) ou selecione no editor para traduzir.');
            return;
        }

        const cleaned = cleanCommentText(text.trim());
        if (cleaned.length < 2) return;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "DevLingo: Traduzindo...",
                cancellable: false
            }, async () => {
                const res = await translateText(cleaned);
                
                const speakBtn = "🔊 Ouvir Pronúncia";
                const showInSidebarBtn = "💬 Ver Detalhes no Painel";

                const selectionResult = await vscode.window.showInformationMessage(
                    `DevLingo Tradução: "${res.translated}"`,
                    speakBtn,
                    showInSidebarBtn
                );

                if (selectionResult === speakBtn) {
                    sidebarProvider.speak(res.translated, res.to);
                } else if (selectionResult === showInSidebarBtn) {
                    sidebarProvider.populateAndTranslate(cleaned);
                }
            });
        } catch (err) {
            vscode.window.showErrorMessage(err.message);
        }
    });

    const hoverProvider = vscode.languages.registerHoverProvider('*', {
        async provideHover(document, position, token) {
            if (!settings.hoverEnabled) {
                return null;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            let targetText = '';
            let isSelection = false;

            if (!editor.selection.isEmpty && editor.selection.contains(position)) {
                targetText = document.getText(editor.selection);
                isSelection = true;
            } else {
                const line = document.lineAt(position.line);
                const lineText = line.text.trim();
                
                const commentStyle = getCommentPrefix(document.languageId);
                const isComment = lineText.startsWith(commentStyle.start) || 
                                  (commentStyle.end && lineText.endsWith(commentStyle.end)) ||
                                  lineText.startsWith('//') || 
                                  lineText.startsWith('#');
                
                const isTextFile = ['markdown', 'plaintext', 'gitcommit'].includes(document.languageId);

                if (isComment || isTextFile) {
                    targetText = lineText;
                } else {
                    const wordRange = document.getWordRangeAtPosition(position);
                    if (wordRange) {
                        targetText = document.getText(wordRange);
                    }
                }
            }

            const cleanedText = cleanCommentText(targetText);

            if (!cleanedText || cleanedText.length < 3 || 
                /^(const|let|var|function|import|export|class|return|if|else|for|while|true|false|null|undefined|void|public|private|protected|async|await|try|catch|finally|throw|new|delete)$/.test(cleanedText)) {
                return null;
            }

            try {
                const res = await translateText(cleanedText);
                
                const sourceLang = res.from === 'pt' ? 'Português' : 'Inglês';
                const targetLang = res.to === 'pt' ? 'Português' : 'Inglês';
                
                const hoverMarkdown = new vscode.MarkdownString();
                hoverMarkdown.isTrusted = true;
                
                hoverMarkdown.appendMarkdown(`### DevLingo Tradução (${sourceLang} ➔ ${targetLang})\n`);
                hoverMarkdown.appendMarkdown(`> **${res.translated}**\n\n`);

                if (res.connectedSpeech) {
                    hoverMarkdown.appendMarkdown(`**🗣️ Connected Speech:** *${res.connectedSpeech}*\n\n`);
                }

                if (res.explanationEn) {
                    hoverMarkdown.appendMarkdown(`**💡 Dica do Coach (EN):** ${res.explanationEn}\n`);
                    const expEnEscaped = encodeURIComponent(JSON.stringify([res.explanationEn]));
                    hoverMarkdown.appendMarkdown(`[🔊 Ouvir Dica (EN)](command:devlingo.speak?${expEnEscaped})\n\n`);
                }

                if (res.explanationPt) {
                    hoverMarkdown.appendMarkdown(`**💡 Dica do Coach (PT):** ${res.explanationPt}\n`);
                    const expPtEscaped = encodeURIComponent(JSON.stringify([res.explanationPt]));
                    hoverMarkdown.appendMarkdown(`[🔊 Ouvir Dica (PT)](command:devlingo.speak?${expPtEscaped})\n\n`);
                }
                
                const originalEscaped = encodeURIComponent(JSON.stringify([cleanedText]));
                const translatedEscaped = encodeURIComponent(JSON.stringify([res.translated]));
                
                hoverMarkdown.appendMarkdown(`[🔊 Ouvir Original (em ${sourceLang})](command:devlingo.speak?${originalEscaped}) &nbsp;|&nbsp; `);
                hoverMarkdown.appendMarkdown(`[🔊 Ouvir Tradução (em ${targetLang})](command:devlingo.speak?${translatedEscaped})`);

                return new vscode.Hover(hoverMarkdown);
            } catch (error) {
                return null;
            }
        }
    });

    const activeEditorChange = vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateInlineDecoration(editor);
        }
    });

    const selectionChange = vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === vscode.window.activeTextEditor) {
            updateInlineDecoration(event.textEditor);
        }
    });

    if (vscode.window.activeTextEditor) {
        updateInlineDecoration(vscode.window.activeTextEditor);
    }

    context.subscriptions.push(
        translateReplaceCmd, 
        translateCommentCmd, 
        speakCmd, 
        translateAnywhereCmd,
        hoverProvider,
        activeEditorChange,
        selectionChange
    );
}

function deactivate() {
    clearInlineDecorations();
}

module.exports = {
    activate,
    deactivate
};
