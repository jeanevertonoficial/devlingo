const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Referência global para o provedor do painel lateral
let sidebarProviderRef = null;

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
    selectedPtVoiceName: '',
    geminiInHover: false,
    geminiModel: 'gemini-3.5-flash'
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
 * Realiza uma requisição fetch com timeout para evitar travamentos.
 * @param {string} url URL para requisição
 * @param {RequestInit} options Opções adicionais do fetch
 * @param {number} timeout Tempo limite em milissegundos
 */
async function fetchWithTimeout(url, options = {}, timeout = 6000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

/**
 * Traduz e analisa um texto usando o Gemini API (se configurado) ou Google Translate (grátis).
 * @param {string} text Texto a ser traduzido
 * @param {boolean} forceGoogleTranslate Se true, força o uso do Google Translate em vez do Gemini
 * @returns {Promise<{ translated: string, from: string, to: string, connectedSpeech: string, explanationEn: string, explanationPt: string }>}
 */
async function translateText(text, forceGoogleTranslate = false) {
    if (!text || !text.trim()) {
        return { translated: '', from: '', to: '', connectedSpeech: '', explanationEn: '', explanationPt: '' };
    }

    const trimmed = text.trim();
    if (translationCache.has(trimmed)) {
        const cached = translationCache.get(trimmed);
        if (forceGoogleTranslate || cached.connectedSpeech || !settings.geminiApiKey || !settings.geminiApiKey.trim()) {
            return cached;
        }
    }

    let result = null;
    let geminiError = null;

    // Se houver chave API do Gemini configurada e não estiver forçado o Google Translate, usamos IA
    if (!forceGoogleTranslate && settings.geminiApiKey && settings.geminiApiKey.trim()) {
        try {
            result = await translateWithGemini(trimmed, settings.geminiApiKey.trim());
        } catch (err) {
            console.error('[translateText] Erro na tradução com Gemini, recorrendo ao Google Translate:', err);
            if (err.message && err.message.includes('429')) {
                geminiError = 'Limite de requisições excedido (Erro 429).';
            } else if (err.message && err.message.includes('503')) {
                geminiError = 'Serviço temporariamente indisponível (Erro 503).';
            } else {
                geminiError = 'Erro na resposta do serviço.';
            }
        }
    }

    // Se a tradução com Gemini falhar ou não estiver disponível
    if (!result) {
        try {
            const isPtHeuristic = hasPortugueseWords(trimmed);

            const urlEn = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(trimmed)}`;
            const resEn = await fetchWithTimeout(urlEn);
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
                const resPt = await fetchWithTimeout(urlPt);
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
                explanationPt: '',
                geminiError: geminiError
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
    const model = settings.geminiModel || 'gemini-3.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const prompt = `Você é um professor particular de inglês focado em programadores e profissionais de tecnologia.
Analise o texto a seguir para realizar a tradução bidirecional (PT <-> EN). Se o texto for majoritariamente em português, formule para o inglês de forma correta e idiomática. Se for em inglês, traduza para o português.

Texto a ser analisado: "${text}"

Instruções importantes para o JSON de retorno:
1. "translated": Forneça a tradução correta e mais natural (especialmente adaptada ao contexto corporativo de TI se aplicável).
2. "connectedSpeech": Forneça a pronúncia em formato IPA simples e adaptada para falantes do português brasileiro (exemplo: "people" -> "pí-pəl", "busy" -> "bí-zi", "What time is it?" -> "Whaddáimez-it? (fala rápida)"). Mostre como pronunciar as palavras principais ou conexões de palavras de forma muito direta e sucinta, usando hifens e acentuação amigável em português para indicar a sílaba tônica.
3. "explanationEn": Sugira uma frase ou expressão curta útil relacionada ao contexto ou muito comum no cotidiano profissional para o desenvolvedor aprender. Deve vir no formato: "Frase em inglês (Pronúncia IPA Simples da frase sugerida)". Exemplo: se o texto for um cumprimento, sugira algo como: "I'm doing well, how about you? (ái-m dú-in uél, háu a-báut iú?)".
4. "explanationPt": Forneça a tradução correspondente da frase sugerida em "explanationEn" e o contexto de uso entre parênteses. Exemplo: "Estou indo bem, como vai você? (resposta comum em daily standups)".
5. "from": Código do idioma de origem ("pt" ou "en").
6. "to": Código do idioma de destino ("pt" ou "en").

Retorne a resposta estritamente no formato de objeto JSON com as chaves: "translated", "connectedSpeech", "explanationEn", "explanationPt", "from", "to". Não coloque blocos de marcação de código do tipo \`\`\`json no retorno, apenas a string JSON limpa.`;

    const response = await fetchWithTimeout(url, {
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
                    const res = await translateText(cleaned, !settings.geminiInHover);
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
                case 'triggerTranslateAnywhere':
                    vscode.commands.executeCommand('devlingo.translateAnywhere', { source: 'clipboard', text: data.text });
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
                            explanationPt: result.explanationPt || '',
                            geminiError: result['geminiError'] || null
                        });
                    } catch (err) {
                        vscode.window.showErrorMessage(err.message);
                    }
                    break;
                case 'updateSettings':
                    settings = data.settings;
                    this._context.globalState.update('hoverEnabled', settings.hoverEnabled);
                    this._context.globalState.update('inlineEnabled', settings.inlineEnabled);
                    this._context.globalState.update('geminiInHover', settings.geminiInHover);
                    this._context.globalState.update('voiceEngine', settings.voiceEngine);
                    this._context.globalState.update('speechRate', settings.speechRate);
                    this._context.globalState.update('geminiApiKey', settings.geminiApiKey);
                    this._context.globalState.update('selectedEnVoiceName', settings.selectedEnVoiceName);
                    this._context.globalState.update('selectedPtVoiceName', settings.selectedPtVoiceName);
                    this._context.globalState.update('geminiModel', settings.geminiModel);
                    
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
                case 'speakNative':
                    if (settings.voiceEngine === 'online' && process.platform === 'win32') {
                        playOnlineTTSWindows(data.text, data.lang);
                    } else {
                        try {
                            const base64 = await getGoogleTTSBase64(data.text, data.lang);
                            webviewView.webview.postMessage({ type: 'speakBase64', text: data.text, lang: data.lang, base64 });
                        } catch (err) {
                            console.error('[speakNative] Erro ao obter base64 do Google TTS:', err);
                            webviewView.webview.postMessage({ type: 'speakOnlineFallback', text: data.text, lang: data.lang });
                        }
                    }
                    break;
                case 'exportPortfolio':
                    try {
                        const historyItems = data.history || [];
                        if (historyItems.length === 0) {
                            vscode.window.showInformationMessage('Nenhum item no histórico para exportar.');
                            break;
                        }

                        let mdContent = `# 📚 Apostila de Aprendizado - DevLingo\n\n`;
                        mdContent += `Gerado em: ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}\n\n`;
                        mdContent += `Parabéns pelo seu progresso! Aqui está o seu portfólio de estudo acumulado com as traduções, pronúncias simplificadas (IPA) e dicas do coach.\n\n`;
                        mdContent += `---\n\n`;

                        historyItems.forEach((item, index) => {
                            const isPt = item.from === 'pt';
                            const ptText = isPt ? item.original : item.translated;
                            const enText = isPt ? item.translated : item.original;

                            mdContent += `## ${index + 1}. ${enText}\n`;
                            mdContent += `- **Tradução:** ${ptText}\n`;
                            
                            if (item.connectedSpeech) {
                                mdContent += `- **Pronúncia da Frase (IPA simples):** *${item.connectedSpeech}*\n`;
                            }
                            
                            if (item.explanationEn || item.explanationPt) {
                                mdContent += `### 💡 Expressão Extra para Praticar:\n`;
                                if (item.explanationEn) {
                                    mdContent += `  - **Inglês:** ${item.explanationEn}\n`;
                                }
                                if (item.explanationPt) {
                                    mdContent += `  - **Tradução & Contexto:** ${item.explanationPt}\n`;
                                }
                            }
                            mdContent += `\n- **Status:** ${item.learned ? '✅ Aprendido' : '⏳ Em aprendizado'}\n\n`;
                            mdContent += `---\n\n`;
                        });

                        mdContent += `\n*Continue praticando diariamente para expandir seu vocabulário tech! 🚀*\n`;

                        const defaultPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir(), 'Apostila_DevLingo.md');
                        const options = {
                            defaultUri: vscode.Uri.file(defaultPath),
                            filters: {
                                'Markdown Files': ['md']
                            },
                            title: 'Salvar Apostila DevLingo'
                        };

                        const fileUri = await vscode.window.showSaveDialog(options);
                        if (fileUri) {
                            fs.writeFileSync(fileUri.fsPath, mdContent, 'utf8');
                            vscode.window.showInformationMessage('Apostila exportada com sucesso!', 'Abrir Arquivo').then(selection => {
                                if (selection === 'Abrir Arquivo') {
                                    vscode.workspace.openTextDocument(fileUri).then(doc => {
                                        vscode.window.showTextDocument(doc);
                                    });
                                }
                            });
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Falha ao exportar apostila: ${err.message}`);
                    }
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

    speakBase64(text, lang, base64) {
        if (this._view) {
            this._view.show(true);
            this._view.webview.postMessage({ type: 'speakBase64', text, lang, base64 });
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
    settings.geminiInHover = context.globalState.get('geminiInHover', false);
    settings.voiceEngine = context.globalState.get('voiceEngine', 'online');
    settings.speechRate = context.globalState.get('speechRate', '0.9');
    settings.geminiApiKey = context.globalState.get('geminiApiKey', '');
    settings.selectedEnVoiceName = context.globalState.get('selectedEnVoiceName', '');
    settings.selectedPtVoiceName = context.globalState.get('selectedPtVoiceName', '');
    settings.geminiModel = context.globalState.get('geminiModel', 'gemini-3.5-flash');

    // Carrega estatísticas salvas
    stats = context.globalState.get('stats', {
        streak: 0,
        lastQuizDate: '',
        totalQuizzes: 0,
        correctAnswers: 0,
        totalQuestions: 0
    });

    const sidebarProvider = new DevLingoSidebarProvider(context);
    sidebarProviderRef = sidebarProvider;
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
                const res = await translateText(text, true);
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, res.translated);
                });
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
                const res = await translateText(text, true);
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
            const res = await translateText(cleaned, true);
            if (settings.voiceEngine === 'online') {
                if (process.platform === 'win32') {
                    playOnlineTTSWindows(cleaned, res.from);
                } else {
                    const base64 = await getGoogleTTSBase64(cleaned, res.from);
                    sidebarProviderRef.speakBase64(cleaned, res.from, base64);
                }
            } else {
                sidebarProviderRef.speak(cleaned, res.from);
            }
        } catch (err) {
            console.error('[speakCmd] Erro ao obter áudio do Google:', err);
            if (settings.voiceEngine === 'online' && process.platform === 'win32') {
                playOnlineTTSWindows(cleaned, 'en');
            } else {
                sidebarProviderRef.speak(cleaned, 'en');
            }
        }
    });

    // Traduzir de Qualquer Lugar (Editor, Terminal, Chats, Clipboard)
    const translateAnywhereCmd = vscode.commands.registerCommand('devlingo.translateAnywhere', async (args) => {
        let text = '';
        const source = args && args.source;

        // 1. Tenta pegar a seleção do editor ativo (somente se não vier de forma explícita do clipboard)
        if (source !== 'clipboard') {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                text = editor.document.getText(editor.selection);
            }
        }

        // 2. Se não houver seleção no editor, tenta ler do clipboard
        if (!text || !text.trim()) {
            try {
                // Tenta forçar a cópia de seleção ativa do terminal ou de inputs baseados em Monaco para o clipboard
                await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
                await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
                await new Promise(resolve => setTimeout(resolve, 80));
            } catch (e) {
                // Ignora se os comandos não estiverem disponíveis ou não aplicáveis
            }
            text = await vscode.env.clipboard.readText();
        }

        if (!text || !text.trim()) {
            vscode.window.showInformationMessage('Copie algum texto para a Área de Transferência (Ctrl+C) ou selecione no editor para traduzir.');
            return;
        }

        const cleaned = cleanCommentText(text.trim());
        if (cleaned.length < 2) return;

        try {
            /** @type {any} */
            let res = null;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "DevLingo: Traduzindo...",
                cancellable: false
            }, async () => {
                res = await translateText(cleaned, true);
            });

            // Pequena pausa para garantir que o VS Code dispense a notificação de progresso na UI
            await new Promise(resolve => setTimeout(resolve, 200));

            if (res) {
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
            }
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
                const res = await translateText(cleanedText, !settings.geminiInHover);
                
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
                    const expEnUri = vscode.Uri.parse(`command:devlingo.speak?${encodeURIComponent(JSON.stringify([res.explanationEn]))}`);
                    hoverMarkdown.appendMarkdown(`[🔊 Ouvir Dica (EN)](${expEnUri})\n\n`);
                }

                if (res.explanationPt) {
                    hoverMarkdown.appendMarkdown(`**💡 Dica do Coach (PT):** ${res.explanationPt}\n`);
                    const expPtUri = vscode.Uri.parse(`command:devlingo.speak?${encodeURIComponent(JSON.stringify([res.explanationPt]))}`);
                    hoverMarkdown.appendMarkdown(`[🔊 Ouvir Dica (PT)](${expPtUri})\n\n`);
                }
                
                const originalUri = vscode.Uri.parse(`command:devlingo.speak?${encodeURIComponent(JSON.stringify([cleanedText]))}`);
                const translatedUri = vscode.Uri.parse(`command:devlingo.speak?${encodeURIComponent(JSON.stringify([res.translated]))}`);
                
                hoverMarkdown.appendMarkdown(`[🔊 Ouvir Original (em ${sourceLang})](${originalUri}) &nbsp;|&nbsp; `);
                hoverMarkdown.appendMarkdown(`[🔊 Ouvir Tradução (em ${targetLang})](${translatedUri})`);

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

/**
 * Obtém o áudio do Google TTS e retorna como uma string Base64.
 * Isso permite contornar as restrições de CORS e Origin no Webview.
 */
async function getGoogleTTSBase64(text, langCode) {
    const lang = langCode === 'pt' ? 'pt' : 'en';
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text.substring(0, 200))}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Google TTS retornou status ${response.status}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString('base64');
}

/**
 * Reproduz o áudio do Google TTS nativamente no Windows utilizando o PowerShell e o MediaPlayer.
 * Utiliza o switch -EncodedCommand para contornar políticas de segurança/execução de arquivo do Windows.
 */
async function playOnlineTTSWindows(text, langCode) {
    try {
        const lang = langCode === 'pt' ? 'pt' : 'en';
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text.substring(0, 200))}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Google TTS retornou status ${response.status}`);
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const tempDir = os.tmpdir();
        const mp3FilePath = path.join(tempDir, `devlingo_tts_${Date.now()}.mp3`);
        fs.writeFileSync(mp3FilePath, buffer);
        
        const speed = parseFloat(settings.speechRate || '0.9');
        const escapedMp3Path = mp3FilePath.replace(/'/g, "''");
        
        const psScript = [
            `$ProgressPreference = 'SilentlyContinue'`,
            `Add-Type -AssemblyName PresentationCore`,
            `$player = New-Object System.Windows.Media.MediaPlayer`,
            `$uri = New-Object System.Uri('${escapedMp3Path}')`,
            `$player.Open($uri)`,
            `$player.SpeedRatio = ${speed}`,
            ``,
            `# Espera até que a duração esteja disponível (timeout de 3s)`,
            `$timeout = 30`,
            `while (-not $player.NaturalDuration.HasTimeSpan -and $timeout -gt 0) {`,
            `    Start-Sleep -m 100`,
            `    $timeout--`,
            `}`,
            ``,
            `# Se a duração estiver disponível, executa o truque do seek dinâmico para acordar a placa de som`,
            `if ($player.NaturalDuration.HasTimeSpan) {`,
            `    $duration = $player.NaturalDuration.TimeSpan.TotalMilliseconds`,
            `    $player.Play()`,
            `    `,
            `    # Aguarda dinamicamente até a posição começar a avançar (indica que a placa de som acordou)`,
            `    $wakeTimeout = 200`,
            `    $elapsedLoops = 0`,
            `    while ($player.Position.TotalMilliseconds -eq 0 -and $wakeTimeout -gt 0) {`,
            `        [System.Threading.Thread]::Sleep(5)`,
            `        $wakeTimeout--`,
            `        $elapsedLoops++`,
            `    }`,
            `    `,
            `    # Se demorou mais que 40ms (8 loops) para iniciar, a placa estava dormindo e houve corte.`,
            `    # Nesse caso, retrocedemos para o início. Caso contrário, evitamos o seek para não gaguejar.`,
            `    if ($elapsedLoops -gt 8) {`,
            `        $player.Position = New-Object System.TimeSpan(0)`,
            `    }`,
            `    # Aguarda o tempo de reprodução completo + margem de segurança de 300ms`,
            `    $sleepTime = [int]($duration / ${speed}) + 300`,
            `    Start-Sleep -m $sleepTime`,
            `} else {`,
            `    # Fallback simples caso a duração falhe`,
            `    $player.Play()`,
            `    Start-Sleep -s 5`,
            `}`,
            ``,
            `$player.Close()`,
            `Remove-Item '${escapedMp3Path}' -ErrorAction SilentlyContinue`
        ].join('\r\n');
        
        const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
        const playCommand = `powershell -WindowStyle Hidden -EncodedCommand ${b64}`;
        
        exec(playCommand, (error, stdout, stderr) => {
            if (stdout) console.log('[playOnlineTTSWindows] PowerShell stdout:', stdout);
            if (stderr) {
                // Filtra o XML de progresso padrão de inicialização do PowerShell (CLIXML)
                if (!stderr.includes('CLIXML')) {
                    console.error('[playOnlineTTSWindows] PowerShell stderr:', stderr);
                }
            }
            
            if (error) {
                console.error('[playOnlineTTSWindows] Erro ao reproduzir via PowerShell:', error);
                // Limpeza preventiva em caso de falha de spawn
                try { fs.unlinkSync(mp3FilePath); } catch (_) {}
            }
        });
    } catch (err) {
        console.error('[playOnlineTTSWindows] Falha no player online nativo, recorrendo à Webview:', err);
        // Fallback para a Webview
        if (sidebarProviderRef) {
            // Em caso de erro nativo, enviamos como base64 para o webview (CORS-free)
            try {
                const base64 = await getGoogleTTSBase64(text, langCode);
                sidebarProviderRef.speakBase64(text, langCode, base64);
            } catch (_) {
                sidebarProviderRef.speak(text, langCode);
            }
        }
    }
}

function deactivate() {
    clearInlineDecorations();
}

module.exports = {
    activate,
    deactivate
};
